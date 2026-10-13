from contextlib import asynccontextmanager, closing
from contextvars import ContextVar
from datetime import date, datetime, time, timedelta, timezone
import asyncio
import base64
import hashlib
from functools import lru_cache
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from threading import Lock
from typing import Callable, Literal
from uuid import uuid4
import pymupdf

import fitz
import jwt
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError
from pydantic import BaseModel, Field, StrictInt, field_validator

from app.rag import (
    AIProvider,
    AIServiceError,
    OpenAICompatibleProvider,
    RETRIEVAL_LIMIT,
    chunk_pages,
    cosine_similarity,
    deserialize_embedding,
    serialize_embedding,
)


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / ".env")
DATABASE_PATH = BASE_DIR / "data" / "documents.sqlite3"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
MAX_UPLOAD_SIZE = 20 * 1024 * 1024
PREVIEW_LENGTH = 280
logger = logging.getLogger(__name__)
SOURCE_CITATION = re.compile(r"\[S(\d+)\]")
_USER_DATABASE_PATH: ContextVar[Path | None] = ContextVar(
    "papertrail_user_database_path", default=None
)


def _validate_citations(answer: str, context: list[dict[str, str]]) -> None:
    if not isinstance(answer, str) or not answer.strip():
        raise AIServiceError("The generated answer is empty or invalid.")
    allowed = {item["source_id"] for item in context}
    cited = {f"S{index}" for index in SOURCE_CITATION.findall(answer)}
    if not cited or not cited.issubset(allowed):
        raise AIServiceError("The generated answer contains invalid source citations.")


class DocumentSummary(BaseModel):
    id: str
    filename: str
    file_size: int
    page_count: int
    uploaded_at: str
    character_count: int
    text_preview: str
    index_status: str


class DocumentDetail(DocumentSummary):
    extracted_text: str


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=8)

    @field_validator("question")
    @classmethod
    def validate_question(cls, question: str) -> str:
        if not question.strip():
            raise ValueError("Question cannot be blank.")
        return question.strip()


class ChatSource(BaseModel):
    source_id: str
    filename: str
    page_number: int
    excerpt: str


class ChatResponse(BaseModel):
    answer: str
    sources: list[ChatSource]


class SummaryRequest(BaseModel):
    language: Literal["en", "hi"] = "en"


class SummaryResponse(BaseModel):
    summary: str = Field(min_length=1, max_length=12000)
    language: Literal["en", "hi"]
    source_pages: list[StrictInt] = Field(min_length=1, max_length=14)

    @field_validator("summary")
    @classmethod
    def validate_summary(cls, summary: str) -> str:
        summary = summary.strip()
        if not summary:
            raise ValueError("Summary cannot be blank.")
        return summary

    @field_validator("source_pages")
    @classmethod
    def validate_source_pages(cls, source_pages: list[int]) -> list[int]:
        if any(page < 1 for page in source_pages) or len(set(source_pages)) != len(source_pages):
            raise ValueError("Summary source pages must be unique positive page numbers.")
        return source_pages


class ExplainRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    language: Literal["en", "hi"] = "en"

    @field_validator("question")
    @classmethod
    def validate_question(cls, question: str) -> str:
        if not question.strip():
            raise ValueError("Question cannot be blank.")
        return question.strip()


class ExplainResponse(BaseModel):
    explanation: str = Field(min_length=1, max_length=12000)
    language: Literal["en", "hi"]
    sources: list[ChatSource] = Field(min_length=1)


class QuizRequest(BaseModel):
    language: Literal["en", "hi"] = "en"
    count: int = Field(default=5, ge=1, le=10)


class GeneratedQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    options: list[str] = Field(min_length=4, max_length=4)
    correct_answer_index: int = Field(ge=0, le=3, strict=True)
    explanation: str = Field(min_length=1, max_length=2000)
    page_number: int = Field(ge=1, strict=True)

    @field_validator("question", "explanation")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question and explanation cannot be blank.")
        return value

    @field_validator("options")
    @classmethod
    def validate_options(cls, options: list[str]) -> list[str]:
        cleaned = [option.strip() for option in options]
        if any(not option for option in cleaned) or len(
            {option.casefold() for option in cleaned}
        ) != 4:
            raise ValueError("Each quiz question needs four distinct, non-empty options.")
        return cleaned


class QuizAnswersRequest(BaseModel):
    answers: list[StrictInt] = Field(min_length=1, max_length=10)


class QuizPublicQuestion(BaseModel):
    question: str
    options: list[str]
    page_number: int


class QuizResponse(BaseModel):
    quiz_id: str
    language: Literal["en", "hi"]
    questions: list[QuizPublicQuestion]


class QuizAnswerResult(BaseModel):
    question: str
    options: list[str]
    selected_index: int
    correct_index: int
    is_correct: bool
    explanation: str
    page_number: int


class QuizGradeResponse(BaseModel):
    quiz_id: str
    score: int
    total: int
    correct_count: int
    results: list[QuizAnswerResult]


class QuizHistoryEntry(BaseModel):
    quiz_id: str
    language: Literal["en", "hi"]
    total: int
    score: int | None
    submitted: bool
    created_at: str
    questions: list[QuizPublicQuestion]


class StudySessionStartRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=80)
    notes: str = Field(default="", max_length=2000)

    @field_validator("subject")
    @classmethod
    def validate_subject(cls, subject: str) -> str:
        subject = subject.strip()
        if not subject:
            raise ValueError("Subject cannot be blank.")
        return subject

    @field_validator("notes")
    @classmethod
    def normalize_notes(cls, notes: str) -> str:
        return notes.strip()


class StudySessionResponse(BaseModel):
    id: str
    subject: str
    start_time: datetime
    end_time: datetime | None
    duration_seconds: int
    status: Literal["active", "paused", "completed"]
    notes: str


class StudyGoalResponse(BaseModel):
    daily_goal_minutes: int


class StudyGoalRequest(BaseModel):
    daily_goal_minutes: int = Field(ge=1, le=1440, strict=True)


class StudyDashboardResponse(BaseModel):
    today_seconds: int
    week_seconds: int
    month_seconds: int
    daily_average_seconds: int
    completed_sessions: int
    current_streak_days: int
    daily_goal_minutes: int
    goal_progress_percent: int
    weekly: list[dict[str, int | str]]
    subjects: list[dict[str, int | str]]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _session_duration_seconds(
    connection: sqlite3.Connection, session_id: str, now: datetime
) -> int:
    rows = connection.execute(
        "SELECT started_at, ended_at FROM study_intervals WHERE session_id = ?",
        (session_id,),
    ).fetchall()
    total = 0.0
    for row in rows:
        started_at = _parse_timestamp(row["started_at"])
        ended_at = _parse_timestamp(row["ended_at"]) if row["ended_at"] else now
        if ended_at < started_at:
            raise ValueError("A study interval ends before it starts.")
        total += (ended_at - started_at).total_seconds()
    return int(total)


def _study_session_response(
    connection: sqlite3.Connection, row: sqlite3.Row, now: datetime
) -> StudySessionResponse:
    return StudySessionResponse(
        id=row["id"],
        subject=row["subject"],
        start_time=_parse_timestamp(row["start_time"]),
        end_time=(
            _parse_timestamp(row["end_time"]) if row["end_time"] is not None else None
        ),
        duration_seconds=_session_duration_seconds(connection, row["id"], now),
        status=row["status"],
        notes=row["notes"],
    )


def _connect(database_path: Path) -> sqlite3.Connection:
    active_database_path = _USER_DATABASE_PATH.get() or database_path
    active_database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(active_database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _initialize_database(database_path: Path, upload_dir: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    with closing(_connect(database_path)) as connection:
        with connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    page_count INTEGER NOT NULL,
                    uploaded_at TEXT NOT NULL,
                    extracted_text TEXT NOT NULL,
                    stored_filename TEXT NOT NULL,
                    index_status TEXT NOT NULL DEFAULT 'pending'
                )
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(documents)").fetchall()
            }
            if "index_status" not in columns:
                connection.execute(
                    "ALTER TABLE documents ADD COLUMN index_status TEXT NOT NULL DEFAULT 'pending'"
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS document_chunks (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    page_number INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    embedding TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS quiz_history (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    language TEXT NOT NULL,
                    questions TEXT NOT NULL,
                    answers TEXT,
                    score INTEGER,
                    correct_count INTEGER,
                    created_at TEXT NOT NULL
                )
                """
            )
            quiz_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(quiz_history)").fetchall()
            }
            if "correct_count" not in quiz_columns:
                connection.execute(
                    "ALTER TABLE quiz_history ADD COLUMN correct_count INTEGER"
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS study_sessions (
                    id TEXT PRIMARY KEY,
                    subject TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration_seconds INTEGER NOT NULL DEFAULT 0
                        CHECK (duration_seconds >= 0),
                    status TEXT NOT NULL
                        CHECK (status IN ('active', 'paused', 'completed')),
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS one_open_study_session
                ON study_sessions ((1))
                WHERE status IN ('active', 'paused')
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS study_intervals (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES study_sessions(id)
                        ON DELETE CASCADE,
                    started_at TEXT NOT NULL,
                    ended_at TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS study_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    daily_goal_minutes INTEGER NOT NULL DEFAULT 60
                        CHECK (daily_goal_minutes BETWEEN 1 AND 1440)
                )
                """
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO study_settings (id, daily_goal_minutes)
                VALUES (1, 60)
                """
            )
            legacy_documents = connection.execute(
                """
                SELECT d.*
                FROM documents AS d
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM document_chunks AS c
                    WHERE c.document_id = d.id
                )
                """
            ).fetchall()
            for document in legacy_documents:
                stored_filename = Path(document["stored_filename"]).name
                stored_path = upload_dir / stored_filename
                pages = [(1, document["extracted_text"])]
                if stored_path.is_file():
                    try:
                        with fitz.open(stored_path) as pdf:
                            if not pdf.needs_pass:
                                pages = [
                                    (page_number, page.get_text("text"))
                                    for page_number, page in enumerate(pdf, start=1)
                                ]
                    except (
                        OSError,
                        fitz.FileDataError,
                        fitz.EmptyFileError,
                        RuntimeError,
                        ValueError,
                    ):
                        logger.warning(
                            "Could not recover PDF pages for legacy document %s; "
                            "using its saved extracted text",
                            document["id"],
                        )
                chunks = chunk_pages(pages)
                connection.executemany(
                    """
                    INSERT INTO document_chunks
                        (id, document_id, page_number, content, embedding)
                    VALUES (?, ?, ?, ?, NULL)
                    """,
                    [
                        (
                            uuid4().hex,
                            document["id"],
                            chunk["page_number"],
                            chunk["content"],
                        )
                        for chunk in chunks
                    ],
                )
                connection.execute(
                    "UPDATE documents SET index_status = ? WHERE id = ?",
                    ("pending" if chunks else "no_text", document["id"]),
                )


def _summary(row: sqlite3.Row) -> DocumentSummary:
    text = row["extracted_text"]
    return DocumentSummary(
        id=row["id"],
        filename=row["filename"],
        file_size=row["file_size"],
        page_count=row["page_count"],
        uploaded_at=row["uploaded_at"],
        character_count=len(text),
        text_preview=" ".join(text.split())[:PREVIEW_LENGTH],
        index_status=row["index_status"],
    )


def _clerk_issuer_and_jwks_url() -> tuple[str, str]:
    publishable_key = os.getenv("CLERK_PUBLISHABLE_KEY") or os.getenv(
        "VITE_CLERK_PUBLISHABLE_KEY"
    )
    if not publishable_key:
        raise RuntimeError(
            "Clerk is not configured for the API. Pull the linked Clerk environment "
            "into backend/.env and restart the backend."
        )
    key_parts = publishable_key.split("_", 2)
    if (
        len(key_parts) != 3
        or key_parts[0] != "pk"
        or key_parts[1] not in {"test", "live"}
    ):
        raise RuntimeError("The Clerk publishable key is invalid.")
    try:
        encoded_domain = key_parts[2].rstrip("$")
        padded_domain = encoded_domain + "=" * (-len(encoded_domain) % 4)
        domain = base64.b64decode(
            padded_domain, altchars=b"-_", validate=True
        ).decode("ascii").rstrip("$")
    except (ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("The Clerk publishable key is invalid.") from error
    if (
        not domain
        or "/" in domain
        or ":" in domain
        or not (domain.endswith(".clerk.accounts.dev") or domain.endswith(".clerk.com"))
    ):
        raise RuntimeError("The Clerk publishable key contains an invalid domain.")
    issuer = f"https://{domain}"
    return issuer, f"{issuer}/.well-known/jwks.json"


@lru_cache(maxsize=4)
def _clerk_jwk_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_keys=True, timeout=5)


def _verify_clerk_token(token: str) -> str:
    issuer, jwks_url = _clerk_issuer_and_jwks_url()
    signing_key = _clerk_jwk_client(jwks_url).get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        issuer=issuer,
        options={"require": ["sub", "exp", "iat"]},
    )
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise PyJWTError("The Clerk token has no valid user subject.")
    return user_id


def create_app(
    database_path: Path = DATABASE_PATH,
    upload_dir: Path = UPLOAD_DIR,
    ai_provider: AIProvider | None = None,
    token_verifier: Callable[[str], str] | None = None,
) -> FastAPI:
    provider = ai_provider
    if provider is None and os.getenv("OPENAI_API_KEY"):
        provider = OpenAICompatibleProvider(
            api_key=os.environ["OPENAI_API_KEY"],
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            embedding_model=os.getenv(
                "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"
            ),
            chat_model=os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini"),

        )
        print("\n\nPrint the api key :: -_------ \n\n")
        print(provider.api_key)

        print("\n \n print end the api\n \n ")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        upload_dir.mkdir(parents=True, exist_ok=True)
        _initialize_database(database_path, upload_dir)
        yield

    app = FastAPI(title="Papertrail API", version="1.0.0", lifespan=lifespan)
    app.state.database_path = database_path
    app.state.upload_dir = upload_dir
    app.state.ai_provider = provider
    app.state.token_verifier = token_verifier or _verify_clerk_token
    initialized_user_databases: set[Path] = set()
    app.state.initialized_user_databases = initialized_user_databases
    app.state.user_database_lock = Lock()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def authenticate_and_scope_user(request: Request, call_next):
        if (
            not request.url.path.startswith("/api/")
            or request.url.path in {"/api/health", "/api/chat/status"}
            or request.method == "OPTIONS"
        ):
            return await call_next(request)

        authorization = request.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            return JSONResponse(
                status_code=401,
                content={"detail": "A valid Clerk session token is required."},
                headers={"WWW-Authenticate": "Bearer"},
            )
        try:
            user_id = await asyncio.to_thread(
                app.state.token_verifier, token.strip()
            )
        except RuntimeError as error:
            return JSONResponse(status_code=503, content={"detail": str(error)})
        except PyJWKClientConnectionError:
            logger.exception("Could not reach Clerk to verify an API session")
            return JSONResponse(
                status_code=503,
                content={"detail": "Could not contact Clerk to verify your session. Please retry."},
            )
        except (PyJWKClientError, PyJWTError, ValueError, OSError):
            return JSONResponse(
                status_code=401,
                content={"detail": "The Clerk session token is invalid or expired."},
                headers={"WWW-Authenticate": "Bearer"},
            )

        user_directory = database_path.parent / "users" / hashlib.sha256(
            user_id.encode("utf-8")
        ).hexdigest()
        user_database_path = user_directory / database_path.name
        user_upload_dir = user_directory / upload_dir.name

        def initialize_user_database() -> None:
            with app.state.user_database_lock:
                if user_database_path not in app.state.initialized_user_databases:
                    _initialize_database(user_database_path, user_upload_dir)
                    app.state.initialized_user_databases.add(user_database_path)

        if user_database_path not in app.state.initialized_user_databases:
            await asyncio.to_thread(initialize_user_database)

        request.state.user_id = user_id
        request.state.database_path = user_database_path
        request.state.upload_dir = user_upload_dir
        database_token = _USER_DATABASE_PATH.set(user_database_path)
        try:
            return await call_next(request)
        finally:
            _USER_DATABASE_PATH.reset(database_token)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/chat/status")
    def chat_status() -> dict[str, bool | str]:
        return {
            "configured": provider is not None,
            "provider": "openai-compatible",
        }

    @app.get("/api/study/active", response_model=StudySessionResponse | None)
    def get_active_study_session() -> StudySessionResponse | None:
        now = _utc_now()
        with closing(_connect(database_path)) as connection:
            row = connection.execute(
                """
                SELECT * FROM study_sessions
                WHERE status IN ('active', 'paused')
                LIMIT 1
                """
            ).fetchone()
            return _study_session_response(connection, row, now) if row else None

    @app.post(
        "/api/study/sessions",
        response_model=StudySessionResponse,
        status_code=201,
    )
    def start_study_session(request: StudySessionStartRequest) -> StudySessionResponse:
        now = _utc_now()
        timestamp = now.isoformat()
        session_id = uuid4().hex
        try:
            with closing(_connect(database_path)) as connection:
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    open_session = connection.execute(
                        """
                        SELECT 1 FROM study_sessions
                        WHERE status IN ('active', 'paused')
                        LIMIT 1
                        """
                    ).fetchone()
                    if open_session is not None:
                        raise HTTPException(
                            status_code=409,
                            detail="Stop or resume the current study session first.",
                        )
                    connection.execute(
                        """
                        INSERT INTO study_sessions
                            (id, subject, start_time, status, notes, created_at)
                        VALUES (?, ?, ?, 'active', ?, ?)
                        """,
                        (session_id, request.subject, timestamp, request.notes, timestamp),
                    )
                    connection.execute(
                        """
                        INSERT INTO study_intervals (id, session_id, started_at)
                        VALUES (?, ?, ?)
                        """,
                        (uuid4().hex, session_id, timestamp),
                    )
                    row = connection.execute(
                        "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                    ).fetchone()
                    return _study_session_response(connection, row, now)
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                status_code=409,
                detail="Stop or resume the current study session first.",
            ) from error

    @app.post(
        "/api/study/sessions/{session_id}/pause",
        response_model=StudySessionResponse,
    )
    def pause_study_session(session_id: str) -> StudySessionResponse:
        now = _utc_now()
        timestamp = now.isoformat()
        with closing(_connect(database_path)) as connection:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Study session not found.")
                if row["status"] != "active":
                    raise HTTPException(
                        status_code=409, detail="Only an active session can be paused."
                    )
                interval = connection.execute(
                    """
                    UPDATE study_intervals SET ended_at = ?
                    WHERE session_id = ? AND ended_at IS NULL
                    """,
                    (timestamp, session_id),
                )
                if interval.rowcount != 1:
                    raise HTTPException(
                        status_code=409, detail="The active timer interval is invalid."
                    )
                duration = _session_duration_seconds(connection, session_id, now)
                connection.execute(
                    """
                    UPDATE study_sessions SET status = ?, duration_seconds = ?
                    WHERE id = ?
                    """,
                    ("paused", duration, session_id),
                )
                updated = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                return _study_session_response(connection, updated, now)

    @app.post(
        "/api/study/sessions/{session_id}/resume",
        response_model=StudySessionResponse,
    )
    def resume_study_session(session_id: str) -> StudySessionResponse:
        now = _utc_now()
        timestamp = now.isoformat()
        with closing(_connect(database_path)) as connection:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Study session not found.")
                if row["status"] != "paused":
                    raise HTTPException(
                        status_code=409, detail="Only a paused session can be resumed."
                    )
                connection.execute(
                    """
                    INSERT INTO study_intervals (id, session_id, started_at)
                    VALUES (?, ?, ?)
                    """,
                    (uuid4().hex, session_id, timestamp),
                )
                connection.execute(
                    "UPDATE study_sessions SET status = 'active' WHERE id = ?",
                    (session_id,),
                )
                updated = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                return _study_session_response(connection, updated, now)

    @app.post(
        "/api/study/sessions/{session_id}/stop",
        response_model=StudySessionResponse,
    )
    def stop_study_session(session_id: str) -> StudySessionResponse:
        now = _utc_now()
        timestamp = now.isoformat()
        with closing(_connect(database_path)) as connection:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Study session not found.")
                if row["status"] == "completed":
                    raise HTTPException(
                        status_code=409, detail="This study session is already complete."
                    )
                if row["status"] == "active":
                    interval = connection.execute(
                        """
                        UPDATE study_intervals SET ended_at = ?
                        WHERE session_id = ? AND ended_at IS NULL
                        """,
                        (timestamp, session_id),
                    )
                    if interval.rowcount != 1:
                        raise HTTPException(
                            status_code=409,
                            detail="The active timer interval is invalid.",
                        )
                duration = _session_duration_seconds(connection, session_id, now)
                if duration < 1:
                    raise HTTPException(
                        status_code=422,
                        detail="Study for at least one second before stopping the timer.",
                    )
                connection.execute(
                    """
                    UPDATE study_sessions
                    SET status = 'completed', end_time = ?, duration_seconds = ?
                    WHERE id = ?
                    """,
                    (timestamp, duration, session_id),
                )
                completed = connection.execute(
                    "SELECT * FROM study_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                return _study_session_response(connection, completed, now)

    @app.put("/api/study/goal", response_model=StudyGoalResponse)
    def set_study_goal(request: StudyGoalRequest) -> StudyGoalResponse:
        with closing(_connect(database_path)) as connection:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """
                    UPDATE study_settings SET daily_goal_minutes = ? WHERE id = 1
                    """,
                    (request.daily_goal_minutes,),
                )
        return StudyGoalResponse(daily_goal_minutes=request.daily_goal_minutes)

    @app.get("/api/study/goal", response_model=StudyGoalResponse)
    def get_study_goal() -> StudyGoalResponse:
        with closing(_connect(database_path)) as connection:
            row = connection.execute(
                "SELECT daily_goal_minutes FROM study_settings WHERE id = 1"
            ).fetchone()
        return StudyGoalResponse(daily_goal_minutes=row["daily_goal_minutes"])

    @app.get("/api/study/sessions", response_model=list[StudySessionResponse])
    def list_study_sessions(
        subject: str | None = None,
        from_date: date | None = None,
        to_date: date | None = None,
        timezone_offset_minutes: int = Query(default=0, ge=-840, le=840),
    ) -> list[StudySessionResponse]:
        if from_date and to_date and from_date > to_date:
            raise HTTPException(
                status_code=422, detail="from_date must not be after to_date."
            )
        local_offset = timedelta(minutes=-timezone_offset_minutes)
        clauses = ["status = 'completed'"]
        parameters: list[str] = []
        if subject and subject.strip():
            clauses.append("subject = ?")
            parameters.append(subject.strip())
        if from_date:
            utc_start = datetime.combine(from_date, time.min) - local_offset
            clauses.append("start_time >= ?")
            parameters.append(utc_start.replace(tzinfo=timezone.utc).isoformat())
        if to_date:
            utc_end = datetime.combine(to_date + timedelta(days=1), time.min) - local_offset
            clauses.append("start_time < ?")
            parameters.append(utc_end.replace(tzinfo=timezone.utc).isoformat())
        with closing(_connect(database_path)) as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM study_sessions
                WHERE {" AND ".join(clauses)}
                ORDER BY start_time DESC
                LIMIT 500
                """,
                parameters,
            ).fetchall()
            now = _utc_now()
            return [
                _study_session_response(connection, row, now) for row in rows
            ]

    @app.get("/api/study/dashboard", response_model=StudyDashboardResponse)
    def study_dashboard(
        timezone_offset_minutes: int = Query(default=0, ge=-840, le=840),
    ) -> StudyDashboardResponse:
        now_utc = _utc_now()
        local_offset = timedelta(minutes=-timezone_offset_minutes)
        local_now = now_utc + local_offset
        today = local_now.date()
        week_start = today - timedelta(days=today.weekday())
        month_start = today.replace(day=1)
        week_chart_start = today - timedelta(days=6)
        with closing(_connect(database_path)) as connection:
            rows = connection.execute(
                """
                SELECT s.id, s.subject, s.status, i.started_at, i.ended_at
                FROM study_sessions AS s
                JOIN study_intervals AS i ON i.session_id = s.id
                ORDER BY i.started_at
                """
            ).fetchall()
            goal_row = connection.execute(
                "SELECT daily_goal_minutes FROM study_settings WHERE id = 1"
            ).fetchone()
            completed_count = connection.execute(
                "SELECT COUNT(*) AS total FROM study_sessions WHERE status = 'completed'"
            ).fetchone()["total"]

        daily_totals: dict[date, int] = {}
        monthly_subject_totals: dict[str, int] = {}
        for row in rows:
            segment_start = _parse_timestamp(row["started_at"]) + local_offset
            segment_end = (
                _parse_timestamp(row["ended_at"]) + local_offset
                if row["ended_at"]
                else local_now
            )
            if segment_end < segment_start:
                continue
            cursor = segment_start.date()
            while cursor <= segment_end.date():
                day_start = datetime.combine(cursor, time.min, tzinfo=timezone.utc)
                day_end = day_start + timedelta(days=1)
                overlap_start = max(segment_start, day_start)
                overlap_end = min(segment_end, day_end)
                seconds = max(0, int((overlap_end - overlap_start).total_seconds()))
                if seconds:
                    daily_totals[cursor] = daily_totals.get(cursor, 0) + seconds
                    if cursor >= month_start:
                        subject = row["subject"]
                        monthly_subject_totals[subject] = (
                            monthly_subject_totals.get(subject, 0) + seconds
                        )
                cursor += timedelta(days=1)

        today_seconds = daily_totals.get(today, 0)
        week_seconds = sum(
            seconds
            for day, seconds in daily_totals.items()
            if week_start <= day <= today
        )
        month_seconds = sum(
            seconds
            for day, seconds in daily_totals.items()
            if month_start <= day <= today
        )
        current_streak = 0
        streak_day = today if today_seconds else today - timedelta(days=1)
        while daily_totals.get(streak_day, 0) > 0:
            current_streak += 1
            streak_day -= timedelta(days=1)
        daily_goal_minutes = goal_row["daily_goal_minutes"]
        weekly = [
            {
                "date": (week_chart_start + timedelta(days=index)).isoformat(),
                "seconds": daily_totals.get(
                    week_chart_start + timedelta(days=index), 0
                ),
            }
            for index in range(7)
        ]
        subjects = [
            {"subject": subject, "seconds": seconds}
            for subject, seconds in sorted(
                monthly_subject_totals.items(),
                key=lambda item: item[1],
                reverse=True,
            )
        ]
        return StudyDashboardResponse(
            today_seconds=today_seconds,
            week_seconds=week_seconds,
            month_seconds=month_seconds,
            daily_average_seconds=round(
                month_seconds / max(1, today.day)
            ),
            completed_sessions=completed_count,
            current_streak_days=current_streak,
            daily_goal_minutes=daily_goal_minutes,
            goal_progress_percent=min(
                100, round(today_seconds * 100 / (daily_goal_minutes * 60))
            ),
            weekly=weekly,
            subjects=subjects,
        )

    @app.post("/api/documents", response_model=DocumentSummary, status_code=201)
    async def upload_document(
        request: Request, file: UploadFile = File(...)
    ) -> DocumentSummary:
        filename = file.filename or ""
        if not filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=415, detail="Only PDF files are accepted.")

        content = await file.read(MAX_UPLOAD_SIZE + 1)
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"PDF must be {MAX_UPLOAD_SIZE // (1024 * 1024)} MB or smaller.",
            )
        if not content:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")
        if b"%PDF-" not in content[:1024]:
            raise HTTPException(status_code=415, detail="The file is not a valid PDF.")

        try:
            with fitz.open(stream=content, filetype="pdf") as pdf:
                if pdf.needs_pass:
                    raise HTTPException(
                        status_code=422,
                        detail="Password-protected PDFs are not supported.",
                    )
                page_count = pdf.page_count
                pages = [
                    (page_number, page.get_text("text"))
                    for page_number, page in enumerate(pdf, start=1)
                ]
                extracted_text = "\n\n".join(text for _, text in pages)
        except (fitz.FileDataError, fitz.EmptyFileError, RuntimeError, ValueError) as error:
            raise HTTPException(
                status_code=422,
                detail="The PDF could not be read. Please upload a valid, unencrypted PDF.",
            ) from error

        chunks = chunk_pages(pages)
        embeddings: list[list[float]] | None = None
        if chunks and provider is not None:
            try:
                embeddings = await asyncio.to_thread(
                    provider.create_embeddings,
                    [str(chunk["content"]) for chunk in chunks],
                )
                if len(embeddings) != len(chunks):
                    raise AIServiceError
            except AIServiceError:
                logger.warning(
                    "AI provider failed to index an uploaded PDF; storing it as pending"
                )
                embeddings = None

        index_status = "ready" if embeddings is not None else (
            "pending" if chunks else "no_text"
        )
        document_id = uuid4().hex
        stored_filename = f"{document_id}.pdf"
        stored_path = request.state.upload_dir / stored_filename
        uploaded_at = datetime.now(timezone.utc).isoformat()
        stored_path.write_bytes(content)

        connection = _connect(database_path)
        try:
            connection.execute(
                """
                INSERT INTO documents
                    (id, filename, file_size, page_count, uploaded_at,
                     extracted_text, stored_filename, index_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    Path(filename).name,
                    len(content),
                    page_count,
                    uploaded_at,
                    extracted_text,
                    stored_filename,
                    index_status,
                ),
            )
            connection.executemany(
                """
                INSERT INTO document_chunks
                    (id, document_id, page_number, content, embedding)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        uuid4().hex,
                        document_id,
                        chunk["page_number"],
                        chunk["content"],
                        (
                            serialize_embedding(embeddings[index])
                            if embeddings is not None
                            else None
                        ),
                    )
                    for index, chunk in enumerate(chunks)
                ],
            )
            connection.commit()
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        except Exception:
            connection.rollback()
            stored_path.unlink(missing_ok=True)
            raise
        finally:
            connection.close()

        return _summary(row)

    @app.get("/api/documents", response_model=list[DocumentSummary])
    def list_documents() -> list[DocumentSummary]:
        with closing(_connect(database_path)) as connection:
            rows = connection.execute(
                "SELECT * FROM documents ORDER BY uploaded_at DESC"
            ).fetchall()
        return [_summary(row) for row in rows]

    @app.get("/api/documents/{document_id}", response_model=DocumentDetail)
    def get_document(document_id: str) -> DocumentDetail:
        with closing(_connect(database_path)) as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        return DocumentDetail(
            **_summary(row).model_dump(),
            extracted_text=row["extracted_text"],
        )

    @app.post(
        "/api/documents/{document_id}/chat",
        response_model=ChatResponse,
    )
    def chat_with_document(
        document_id: str, request: ChatRequest
    ) -> ChatResponse:
        with closing(_connect(database_path)) as connection:
            document = connection.execute(
                "SELECT filename, index_status FROM documents WHERE id = ?",
                (document_id,),
            ).fetchone()
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        if provider is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "PDF chat is not configured. Set OPENAI_API_KEY in the backend "
                    "environment and restart the API."
                ),
            )

        with closing(_connect(database_path)) as connection:
            chunks = connection.execute(
                """
                SELECT id, page_number, content, embedding
                FROM document_chunks
                WHERE document_id = ?
                """,
                (document_id,),
            ).fetchall()

        if not chunks:
            raise HTTPException(
                status_code=422,
                detail="This PDF has no extractable text to chat about.",
            )

        if any(chunk["embedding"] is None for chunk in chunks):
            try:
                embeddings = provider.create_embeddings(
                    [chunk["content"] for chunk in chunks]
                )
                if len(embeddings) != len(chunks):
                    raise AIServiceError
            except AIServiceError as error:
                logger.warning("AI provider failed while indexing a PDF for chat")
                raise HTTPException(
                    status_code=502,
                    detail="Could not index this PDF for chat. Please try again later.",
                ) from error
            with closing(_connect(database_path)) as connection:
                with connection:
                    connection.executemany(
                        "UPDATE document_chunks SET embedding = ? WHERE id = ?",
                        [
                            (serialize_embedding(embedding), chunk["id"])
                            for chunk, embedding in zip(chunks, embeddings)
                        ],
                    )
                    connection.execute(
                        "UPDATE documents SET index_status = 'ready' WHERE id = ?",
                        (document_id,),
                    )
            chunks = [
                {**dict(chunk), "embedding": serialize_embedding(embedding)}
                for chunk, embedding in zip(chunks, embeddings)
            ]

        try:
            query_embedding = provider.create_embeddings([request.question])[0]
            ranked = sorted(
                (
                    (
                        cosine_similarity(
                            query_embedding,
                            deserialize_embedding(chunk["embedding"]),
                        ),
                        chunk,
                    )
                    for chunk in chunks
                ),
                key=lambda item: item[0],
                reverse=True,
            )[:RETRIEVAL_LIMIT]
            retrieved = [
                {
                    "source_id": f"S{index}",
                    "page_number": str(chunk["page_number"]),
                    "content": chunk["content"],
                }
                for index, (_, chunk) in enumerate(ranked, start=1)
            ]
            if not retrieved:
                raise AIServiceError
            answer = provider.generate_answer(
                request.question,
                [message.model_dump() for message in request.history],
                retrieved,
            )
            _validate_citations(answer, retrieved)
        except (AIServiceError, ValueError, IndexError) as error:
            logger.warning("AI provider failed while answering a PDF chat question")
            raise HTTPException(
                status_code=502,
                detail="The AI service could not answer right now. Please try again.",
            ) from error

        return ChatResponse(
            answer=answer,
            sources=[
                ChatSource(
                    source_id=item["source_id"],
                    filename=document["filename"],
                    page_number=int(item["page_number"]),
                    excerpt=item["content"][:320],
                )
                for item in retrieved
            ],
        )

    def load_study_context(document_id: str, limit: int = 14) -> list[dict[str, str]]:
        with closing(_connect(database_path)) as connection:
            rows = connection.execute(
                """
                SELECT page_number, content
                FROM document_chunks
                WHERE document_id = ?
                ORDER BY page_number, id
                """,
                (document_id,),
            ).fetchall()
        context: list[dict[str, str]] = []
        char_count = 0
        for row in rows:
            if len(context) >= limit or char_count >= 18000:
                break
            content = row["content"][: max(0, 18000 - char_count)]
            if content.strip():
                context.append(
                    {"page_number": str(row["page_number"]), "content": content}
                )
                char_count += len(content)
        return context

    def require_study_document(document_id: str) -> sqlite3.Row:
        with closing(_connect(database_path)) as connection:
            document = connection.execute(
                "SELECT id, filename FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        if provider is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Study tools are not configured. Set OPENAI_API_KEY in the backend "
                    "environment and restart the API."
                ),
            )
        return document

    @app.post(
        "/api/documents/{document_id}/summary",
        response_model=SummaryResponse,
    )
    def summarize_document(
        document_id: str, request: SummaryRequest
    ) -> SummaryResponse:
        require_study_document(document_id)
        context = load_study_context(document_id, limit=14)
        if not context:
            raise HTTPException(
                status_code=422,
                detail="This PDF has no extractable text to summarize.",
            )
        try:
            result = provider.generate_study_json(
                "summary", request.language, context, "", 0
            )
            if not isinstance(result, dict) or set(result) != {
                "summary",
                "source_pages",
            }:
                raise ValueError("The AI returned an invalid summary object.")
            summary = SummaryResponse.model_validate(
                {**result, "language": request.language}
            )
            available_pages = {int(item["page_number"]) for item in context}
            if not set(summary.source_pages).issubset(available_pages):
                raise ValueError("Summary referenced an unavailable page.")
        except (AIServiceError, ValueError, TypeError, KeyError) as error:
            logger.warning("AI provider returned an invalid document summary")
            raise HTTPException(
                status_code=502,
                detail="Could not create a validated summary. Please try again.",
            ) from error
        return summary

    @app.post(
        "/api/documents/{document_id}/explain",
        response_model=ExplainResponse,
    )
    def explain_document_topic(
        document_id: str, request: ExplainRequest
    ) -> ExplainResponse:
        document = require_study_document(document_id)
        with closing(_connect(database_path)) as connection:
            chunks = connection.execute(
                """
                SELECT id, page_number, content, embedding
                FROM document_chunks
                WHERE document_id = ?
                """,
                (document_id,),
            ).fetchall()
        if not chunks:
            raise HTTPException(
                status_code=422,
                detail="This PDF has no extractable text to explain.",
            )
        try:
            if any(chunk["embedding"] is None for chunk in chunks):
                embeddings = provider.create_embeddings(
                    [chunk["content"] for chunk in chunks]
                )
                if len(embeddings) != len(chunks):
                    raise AIServiceError
                with closing(_connect(database_path)) as connection:
                    with connection:
                        connection.executemany(
                            "UPDATE document_chunks SET embedding = ? WHERE id = ?",
                            [
                                (serialize_embedding(vector), chunk["id"])
                                for chunk, vector in zip(chunks, embeddings)
                            ],
                        )
                        connection.execute(
                            "UPDATE documents SET index_status = 'ready' WHERE id = ?",
                            (document_id,),
                        )
                chunks = [
                    {**dict(chunk), "embedding": serialize_embedding(vector)}
                    for chunk, vector in zip(chunks, embeddings)
                ]
            query_vector = provider.create_embeddings([request.question])[0]
            ranked = sorted(
                (
                    (
                        cosine_similarity(
                            query_vector, deserialize_embedding(chunk["embedding"])
                        ),
                        chunk,
                    )
                    for chunk in chunks
                ),
                key=lambda item: item[0],
                reverse=True,
            )[:RETRIEVAL_LIMIT]
            context = [
                {
                    "source_id": f"S{index}",
                    "page_number": str(chunk["page_number"]),
                    "content": chunk["content"],
                }
                for index, (_, chunk) in enumerate(ranked, start=1)
            ]
            answer = provider.generate_answer(
                request.question, [], context, language=request.language
            )
            _validate_citations(answer, context)
            response = ExplainResponse(
                explanation=answer,
                language=request.language,
                sources=[
                    ChatSource(
                        source_id=item["source_id"],
                        filename=document["filename"],
                        page_number=int(item["page_number"]),
                        excerpt=item["content"][:320],
                    )
                    for item in context
                ],
            )
        except (AIServiceError, ValueError, IndexError, TypeError) as error:
            logger.warning("AI provider failed to explain a document topic")
            raise HTTPException(
                status_code=502,
                detail="Could not create a grounded explanation. Please try again.",
            ) from error
        return response

    @app.post(
        "/api/documents/{document_id}/quizzes",
        response_model=QuizResponse,
        status_code=201,
    )
    def generate_quiz(
        document_id: str, request: QuizRequest
    ) -> QuizResponse:
        require_study_document(document_id)
        context = load_study_context(document_id, limit=14)
        if not context:
            raise HTTPException(
                status_code=422,
                detail="This PDF has no extractable text for a quiz.",
            )
        available_pages = {int(item["page_number"]) for item in context}
        try:
            result = provider.generate_study_json(
                "quiz", request.language, context, "", request.count
            )
            if not isinstance(result, dict):
                raise ValueError("The AI returned an invalid quiz object.")
            raw_questions = result.get("questions")
            if not isinstance(raw_questions, list) or len(raw_questions) != request.count:
                raise ValueError("The AI returned an unexpected question count.")
            expected_question_keys = {
                "question",
                "options",
                "correct_answer_index",
                "explanation",
                "page_number",
            }
            if any(
                not isinstance(question, dict)
                or set(question) != expected_question_keys
                for question in raw_questions
            ):
                raise ValueError("The AI returned an invalid question object.")
            questions = [
                GeneratedQuestion.model_validate(question)
                for question in raw_questions
            ]
            if any(question.page_number not in available_pages for question in questions):
                raise ValueError("The AI returned a page outside the supplied PDF context.")
            if len({question.question.casefold() for question in questions}) != len(questions):
                raise ValueError("The AI returned duplicate quiz questions.")
        except (AIServiceError, ValueError, TypeError, KeyError) as error:
            logger.warning("AI provider returned invalid quiz questions")
            raise HTTPException(
                status_code=502,
                detail="Could not generate a valid quiz. Please try again.",
            ) from error

        quiz_id = uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        with closing(_connect(database_path)) as connection:
            with connection:
                connection.execute(
                    """
                    INSERT INTO quiz_history
                        (id, document_id, language, questions, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        quiz_id,
                        document_id,
                        request.language,
                        json.dumps(
                            [question.model_dump() for question in questions],
                            ensure_ascii=False,
                        ),
                        created_at,
                    ),
                )
        return QuizResponse(
            quiz_id=quiz_id,
            language=request.language,
            questions=[
                QuizPublicQuestion(
                    question=question.question,
                    options=question.options,
                    page_number=question.page_number,
                )
                for question in questions
            ],
        )

    @app.post(
        "/api/documents/{document_id}/quizzes/{quiz_id}/submit",
        response_model=QuizGradeResponse,
    )
    def submit_quiz(
        document_id: str, quiz_id: str, request: QuizAnswersRequest
    ) -> QuizGradeResponse:
        with closing(_connect(database_path)) as connection:
            row = connection.execute(
                """
                SELECT questions, answers
                FROM quiz_history
                WHERE id = ? AND document_id = ?
                """,
                (quiz_id, document_id),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Quiz not found.")
        if row["answers"] is not None:
            raise HTTPException(status_code=409, detail="This quiz has already been submitted.")
        try:
            questions = [
                GeneratedQuestion.model_validate(item)
                for item in json.loads(row["questions"])
            ]
        except (ValueError, TypeError, KeyError) as error:
            logger.error("Stored quiz %s failed validation", quiz_id)
            raise HTTPException(
                status_code=500,
                detail="This saved quiz could not be graded safely.",
            ) from error
        if len(request.answers) != len(questions):
            raise HTTPException(
                status_code=422,
                detail=f"Submit exactly {len(questions)} answers.",
            )
        if any(answer < 0 or answer >= 4 for answer in request.answers):
            raise HTTPException(
                status_code=422,
                detail="Each answer must select an option from 0 to 3.",
            )

        results = [
            QuizAnswerResult(
                question=question.question,
                options=question.options,
                selected_index=answer,
                correct_index=question.correct_answer_index,
                is_correct=answer == question.correct_answer_index,
                explanation=question.explanation,
                page_number=question.page_number,
            )
            for question, answer in zip(questions, request.answers)
        ]
        correct_count = sum(result.is_correct for result in results)
        score = round(100 * correct_count / len(questions))
        with closing(_connect(database_path)) as connection:
            with connection:
                update = connection.execute(
                    """
                    UPDATE quiz_history
                    SET answers = ?, score = ?, correct_count = ?
                    WHERE id = ? AND document_id = ? AND answers IS NULL
                    """,
                    (
                        json.dumps(request.answers),
                        score,
                        correct_count,
                        quiz_id,
                        document_id,
                    ),
                )
                if update.rowcount != 1:
                    raise HTTPException(
                        status_code=409,
                        detail="This quiz has already been submitted.",
                    )
        return QuizGradeResponse(
            quiz_id=quiz_id,
            score=score,
            total=len(questions),
            correct_count=correct_count,
            results=results,
        )

    @app.get(
        "/api/documents/{document_id}/quizzes",
        response_model=list[QuizHistoryEntry],
    )
    def list_quiz_history(document_id: str) -> list[QuizHistoryEntry]:
        with closing(_connect(database_path)) as connection:
            exists = connection.execute(
                "SELECT 1 FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="Document not found.")
            rows = connection.execute(
                """
                SELECT id, language, questions, score, correct_count, answers, created_at
                FROM quiz_history
                WHERE document_id = ?
                ORDER BY created_at DESC
                """,
                (document_id,),
            ).fetchall()
        history: list[QuizHistoryEntry] = []
        for row in rows:
            try:
                questions = [
                    GeneratedQuestion.model_validate(item)
                    for item in json.loads(row["questions"])
                ]
            except (ValueError, TypeError, KeyError) as error:
                logger.error("Stored quiz %s failed validation", row["id"])
                raise HTTPException(
                    status_code=500,
                    detail="A saved quiz could not be loaded safely.",
                ) from error
            history.append(
                QuizHistoryEntry(
                    quiz_id=row["id"],
                    language=row["language"],
                    total=len(questions),
                    score=row["score"],
                    submitted=row["answers"] is not None,
                    created_at=row["created_at"],
                    questions=[
                        QuizPublicQuestion(
                            question=question.question,
                            options=question.options,
                            page_number=question.page_number,
                        )
                        for question in questions
                    ],
                )
            )
        return history

    @app.get("/api/documents/{document_id}/file")
    def download_document(request: Request, document_id: str) -> FileResponse:
        with closing(_connect(database_path)) as connection:
            row = connection.execute(
                "SELECT filename, stored_filename FROM documents WHERE id = ?",
                (document_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        stored_path = request.state.upload_dir / row["stored_filename"]
        if not stored_path.is_file():
            raise HTTPException(status_code=404, detail="Stored PDF file not found.")
        return FileResponse(
            stored_path,
            media_type="application/pdf",
            filename=row["filename"],
        )

    return app


app = create_app()
