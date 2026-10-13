import sqlite3
import hashlib
from pathlib import Path

import fitz
import pytest
from fastapi.testclient import TestClient as FastAPITestClient

from app.main import create_app as _create_app
from app.rag import AIServiceError, OpenAICompatibleProvider, chunk_pages


class TestClient(FastAPITestClient):
    def __init__(self, app, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        headers.setdefault("Authorization", "Bearer test-user")
        super().__init__(app, headers=headers, **kwargs)


def create_app(**kwargs):
    kwargs.setdefault("token_verifier", lambda token: token)
    return _create_app(**kwargs)


def make_test_app(**kwargs):
    return create_app(**kwargs)


def authenticated_client(app):
    return TestClient(app, headers={"Authorization": "Bearer test-user"})


def user_storage_path(database_path: Path, user_id: str, *parts: str) -> Path:
    user_hash = hashlib.sha256(user_id.encode("utf-8")).hexdigest()
    return database_path.parent / "users" / user_hash / Path(*parts)


@pytest.fixture
def client(tmp_path):
    app = make_test_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
    )
    with authenticated_client(app) as test_client:
        yield test_client


def make_pdf(*page_texts: str) -> bytes:
    pdf = fitz.open()
    for text in page_texts:
        page = pdf.new_page()
        page.insert_text((72, 72), text)
    content = pdf.tobytes()
    pdf.close()
    return content


def test_upload_extract_list_and_download_document(client):
    content = make_pdf("Quarterly report: revenue grew 18%.", "Next steps: expand the team.")
    response = client.post(
        "/api/documents",
        files={"file": ("quarterly-report.pdf", content, "application/pdf")},
    )

    assert response.status_code == 201
    uploaded = response.json()
    assert uploaded["filename"] == "quarterly-report.pdf"
    assert uploaded["page_count"] == 2
    assert uploaded["file_size"] == len(content)
    assert "Quarterly report" in uploaded["text_preview"]
    assert uploaded["index_status"] == "pending"

    listing = client.get("/api/documents")
    assert listing.status_code == 200
    assert [document["id"] for document in listing.json()] == [uploaded["id"]]

    detail = client.get(f"/api/documents/{uploaded['id']}")
    assert detail.status_code == 200
    assert "revenue grew 18%" in detail.json()["extracted_text"]
    assert "expand the team" in detail.json()["extracted_text"]

    download = client.get(f"/api/documents/{uploaded['id']}/file")
    assert download.status_code == 200
    assert download.content == content


@pytest.mark.parametrize(
    ("filename", "content", "status_code"),
    [
        ("notes.txt", b"%PDF-1.7 not really a pdf", 415),
        ("broken.pdf", b"plain text, not a PDF", 415),
        ("broken.pdf", b"%PDF-1.7\nnot a valid document", 422),
        ("empty.pdf", b"", 400),
    ],
)
def test_rejects_invalid_uploads(client, filename, content, status_code):
    response = client.post(
        "/api/documents",
        files={"file": (filename, content, "application/pdf")},
    )

    assert response.status_code == status_code
    assert response.json()["detail"]
    assert client.get("/api/documents").json() == []


def test_rejects_oversized_upload(client):
    content = b"%PDF-1.7\n" + (b"x" * (20 * 1024 * 1024))
    response = client.post(
        "/api/documents",
        files={"file": ("large.pdf", content, "application/pdf")},
    )

    assert response.status_code == 413
    assert client.get("/api/documents").json() == []


def test_reports_missing_document(client):
    response = client.get("/api/documents/missing-id")

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found."


def test_api_requires_a_valid_clerk_session_token(tmp_path):
    app = make_test_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
    )

    with FastAPITestClient(app) as unauthenticated_client:
        response = unauthenticated_client.get("/api/documents")

    assert response.status_code == 401
    assert response.json()["detail"] == "A valid Clerk session token is required."


def test_document_data_is_isolated_between_clerk_users(tmp_path):
    app = make_test_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
    )
    user_one = FastAPITestClient(
        app, headers={"Authorization": "Bearer user-one"}
    )
    user_two = FastAPITestClient(
        app, headers={"Authorization": "Bearer user-two"}
    )
    content = make_pdf("Private notes for the first student.")

    with user_one, user_two:
        uploaded = user_one.post(
            "/api/documents",
            files={"file": ("private.pdf", content, "application/pdf")},
        )
        other_user_listing = user_two.get("/api/documents")
        other_user_detail = user_two.get(
            f"/api/documents/{uploaded.json()['id']}"
        )

    assert uploaded.status_code == 201
    assert other_user_listing.status_code == 200
    assert other_user_listing.json() == []
    assert other_user_detail.status_code == 404


class StubAIProvider:
    def __init__(self):
        self.indexed_texts = []
        self.answer_context = []
        self.study_calls = []
        self.invalid_quiz = False
        self.invalid_summary = False
        self.explanation_language = None

    def create_embeddings(self, texts):
        self.indexed_texts.extend(texts)
        return [
            [1.0, 0.0] if "revenue" in text.lower() else [0.0, 1.0]
            for text in texts
        ]

    def generate_answer(self, question, history, context, language="en"):
        self.answer_context = context
        self.explanation_language = language
        return f"Revenue grew 18%. [{context[0]['source_id']}]"

    def generate_study_json(self, task, language, context, question, count):
        self.study_calls.append((task, language, question, count, context))
        if task == "summary":
            return {
                "summary": "Revenue grew 18% this quarter.",
                "source_pages": (
                    [999]
                    if self.invalid_summary
                    else [int(context[0]["page_number"])]
                ),
            }
        if self.invalid_quiz:
            return {"questions": [{"question": "incomplete"}]}
        return {
            "questions": [
                {
                    "question": f"What changed in the report? {index + 1}",
                    "options": ["Revenue grew", "Revenue fell", "No change", "Not stated"],
                    "correct_answer_index": 0,
                    "explanation": "The report states that revenue grew.",
                    "page_number": int(context[0]["page_number"]),
                }
                for index in range(count)
            ]
        }


def test_chat_retrieves_relevant_page_and_returns_source_citation(tmp_path):
    provider = StubAIProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    content = make_pdf(
        "Quarterly report: revenue grew 18% year over year.",
        "Hiring plan: expand the support team by five people.",
    )
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/documents",
            files={"file": ("annual-report.pdf", content, "application/pdf")},
        )
        assert uploaded.status_code == 201
        assert uploaded.json()["index_status"] == "ready"

        response = client.post(
            f"/api/documents/{uploaded.json()['id']}/chat",
            json={"question": "What happened to revenue?"},
        )

        assert response.status_code == 200
        result = response.json()
        assert "Revenue grew 18%" in result["answer"]
        assert result["sources"][0]["page_number"] == 1
        assert result["sources"][0]["source_id"] == "S1"
        assert "revenue grew 18%" in result["sources"][0]["excerpt"]
        assert provider.answer_context[0]["page_number"] == "1"


def test_chat_migrates_legacy_document_and_recovers_page_citations(tmp_path):
    provider = StubAIProvider()
    app_database_path = tmp_path / "documents.sqlite3"
    database_path = user_storage_path(
        app_database_path, "test-user", app_database_path.name
    )
    upload_dir = user_storage_path(app_database_path, "test-user", "uploads")
    database_path.parent.mkdir(parents=True)
    upload_dir.mkdir(parents=True)
    stored_pdf = make_pdf(
        "Revenue grew 18% this quarter.",
        "Customer support will add five new roles.",
    )
    (upload_dir / "legacy-report.pdf").write_bytes(stored_pdf)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                page_count INTEGER NOT NULL,
                uploaded_at TEXT NOT NULL,
                extracted_text TEXT NOT NULL,
                stored_filename TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-report",
                "legacy-report.pdf",
                len(stored_pdf),
                2,
                "2026-10-12T00:00:00+00:00",
                "Revenue grew 18% this quarter.\n\n"
                "Customer support will add five new roles.",
                "legacy-report.pdf",
            ),
        )

    app = create_app(
        database_path=app_database_path,
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/documents/legacy-report/chat",
            json={"question": "What happened to revenue?"},
        )

        assert response.status_code == 200
        assert provider.indexed_texts[:2] == [
            "Revenue grew 18% this quarter.",
            "Customer support will add five new roles.",
        ]
        assert response.json()["sources"][0]["page_number"] == 1
        assert client.get("/api/documents/legacy-report").json()["index_status"] == "ready"


def test_chat_reports_missing_api_credentials_safely(client):
    uploaded = client.post(
        "/api/documents",
        files={"file": ("report.pdf", make_pdf("Revenue grew 18%."), "application/pdf")},
    )
    document_id = uploaded.json()["id"]

    status = client.get("/api/chat/status")
    response = client.post(
        f"/api/documents/{document_id}/chat",
        json={"question": "What happened?"},
    )

    assert status.json()["configured"] is False
    assert response.status_code == 503
    assert "OPENAI_API_KEY" in response.json()["detail"]


def test_provider_uses_backend_environment_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://ai.example/v1")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "embed-model")
    monkeypatch.setenv("OPENAI_CHAT_MODEL", "answer-model")

    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
    )
    provider = app.state.ai_provider

    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.base_url == "https://ai.example/v1"
    assert provider.embedding_model == "embed-model"
    assert provider.chat_model == "answer-model"


def test_openai_compatible_provider_sends_credentials_and_parses_hindi_json(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"summary":"आय में वृद्धि हुई।","source_pages":[1]}'
                        }
                    }
                ]
            }

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr("app.rag.httpx.post", fake_post)
    provider = OpenAICompatibleProvider(
        api_key="unit-test-key",
        base_url="https://ai.example/v1",
        embedding_model="embed-model",
        chat_model="answer-model",
    )

    result = provider.generate_study_json(
        "summary",
        "hi",
        [{"page_number": "1", "content": "Revenue grew 18%."}],
        "",
        0,
    )

    assert captured["url"] == "https://ai.example/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer unit-test-key"
    assert captured["json"]["response_format"] == {"type": "json_object"}
    assert "Hindi" in captured["json"]["messages"][0]["content"]
    assert result == {"summary": "आय में वृद्धि हुई।", "source_pages": [1]}


def test_openai_compatible_provider_rejects_invalid_json(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "not json"}}]}

    monkeypatch.setattr("app.rag.httpx.post", lambda *args, **kwargs: FakeResponse())
    provider = OpenAICompatibleProvider(
        api_key="unit-test-key",
        base_url="https://ai.example/v1",
        embedding_model="embed-model",
        chat_model="answer-model",
    )

    with pytest.raises(AIServiceError):
        provider.generate_study_json(
            "summary", "en", [{"page_number": "1", "content": "Report."}], "", 0
        )


def test_summary_and_explanation_return_validated_bilingual_grounded_content(tmp_path):
    provider = StubAIProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        upload = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18% this quarter.", "Hiring will expand."),
                    "application/pdf",
                )
            },
        )
        document_id = upload.json()["id"]

        summary = client.post(
            f"/api/documents/{document_id}/summary",
            json={"language": "hi"},
        )
        english_summary = client.post(
            f"/api/documents/{document_id}/summary",
            json={"language": "en"},
        )
        explanation = client.post(
            f"/api/documents/{document_id}/explain",
            json={"question": "Revenue growth", "language": "hi"},
        )

    assert summary.status_code == 200
    assert summary.json()["language"] == "hi"
    assert summary.json()["source_pages"] == [1]
    assert english_summary.status_code == 200
    assert english_summary.json()["language"] == "en"
    assert explanation.status_code == 200
    assert explanation.json()["language"] == "hi"
    assert explanation.json()["sources"][0]["page_number"] == 1
    assert provider.explanation_language == "hi"
    assert provider.study_calls[0][1] == "hi"


def test_quiz_generation_hides_answer_key_grades_and_persists_history(tmp_path):
    provider = StubAIProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        upload = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18% this quarter."),
                    "application/pdf",
                )
            },
        )
        document_id = upload.json()["id"]
        quiz = client.post(
            f"/api/documents/{document_id}/quizzes",
            json={"language": "hi", "count": 3},
        )
        assert quiz.status_code == 201
        generated = quiz.json()
        assert generated["language"] == "hi"
        assert len(generated["questions"]) == 3
        assert "correct_answer_index" not in generated["questions"][0]

        grade = client.post(
            f"/api/documents/{document_id}/quizzes/{generated['quiz_id']}/submit",
            json={"answers": [0, 1, 0]},
        )
        assert grade.status_code == 200
        assert grade.json()["correct_count"] == 2
        assert grade.json()["score"] == 67
        assert grade.json()["total"] == 3
        assert grade.json()["results"][0]["is_correct"] is True
        assert grade.json()["results"][1]["correct_index"] == 0

        history = client.get(f"/api/documents/{document_id}/quizzes")
        assert history.status_code == 200
        assert history.json()[0]["quiz_id"] == generated["quiz_id"]
        assert history.json()[0]["submitted"] is True
        assert history.json()[0]["score"] == 67
        assert "correct_answer_index" not in history.json()[0]["questions"][0]

        duplicate_submit = client.post(
            f"/api/documents/{document_id}/quizzes/{generated['quiz_id']}/submit",
            json={"answers": [0, 0, 0]},
        )
        assert duplicate_submit.status_code == 409


def test_quiz_rejects_invalid_ai_response_and_bad_answer_count(tmp_path):
    provider = StubAIProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        upload = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18% this quarter."),
                    "application/pdf",
                )
            },
        )
        document_id = upload.json()["id"]
        provider.invalid_quiz = True
        invalid = client.post(
            f"/api/documents/{document_id}/quizzes",
            json={"count": 2},
        )
        provider.invalid_quiz = False
        quiz = client.post(
            f"/api/documents/{document_id}/quizzes",
            json={"count": 2},
        )
        wrong_count = client.post(
            f"/api/documents/{document_id}/quizzes/{quiz.json()['quiz_id']}/submit",
            json={"answers": [0]},
        )

    assert invalid.status_code == 502
    assert "correct_answer_index" not in invalid.text
    assert wrong_count.status_code == 422


def test_study_routes_reject_malformed_ai_payload_shapes(tmp_path):
    class MalformedStudyProvider(StubAIProvider):
        def generate_study_json(self, task, language, context, question, count):
            if task == "summary":
                return {
                    "summary": "   ",
                    "source_pages": [int(context[0]["page_number"])] * 2,
                }
            return []

    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=MalformedStudyProvider(),
    )
    with TestClient(app) as client:
        upload = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18% this quarter."),
                    "application/pdf",
                )
            },
        )
        document_id = upload.json()["id"]
        summary = client.post(f"/api/documents/{document_id}/summary", json={})
        quiz = client.post(f"/api/documents/{document_id}/quizzes", json={})

    assert summary.status_code == 502
    assert quiz.status_code == 502
    assert summary.json()["detail"] == (
        "Could not create a validated summary. Please try again."
    )
    assert quiz.json()["detail"] == "Could not generate a valid quiz. Please try again."


def test_study_tools_report_missing_credentials_and_missing_documents(client):
    upload = client.post(
        "/api/documents",
        files={"file": ("report.pdf", make_pdf("Revenue grew."), "application/pdf")},
    )
    document_id = upload.json()["id"]
    summary = client.post(f"/api/documents/{document_id}/summary", json={})
    missing_document = client.get("/api/documents/missing/quizzes")

    assert summary.status_code == 503
    assert "OPENAI_API_KEY" in summary.json()["detail"]
    assert missing_document.status_code == 404


def test_study_tools_reject_invalid_ai_pages_and_citations(tmp_path):
    class InvalidAnswerProvider(StubAIProvider):
        def generate_answer(self, question, history, context, language="en"):
            return "The answer is supported. [S999]"

    provider = InvalidAnswerProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        upload = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18% this quarter."),
                    "application/pdf",
                )
            },
        )
        document_id = upload.json()["id"]
        provider.invalid_summary = True
        bad_summary = client.post(
            f"/api/documents/{document_id}/summary",
            json={"language": "en"},
        )
        bad_explanation = client.post(
            f"/api/documents/{document_id}/explain",
            json={"question": "Revenue"},
        )

    assert bad_summary.status_code == 502
    assert bad_explanation.status_code == 502
    assert "S999" not in bad_explanation.text


def test_chat_reports_provider_failure_without_leaking_provider_details(tmp_path):
    class FailingProvider(StubAIProvider):
        fail_embeddings = False

        def create_embeddings(self, texts):
            from app.rag import AIServiceError

            if self.fail_embeddings:
                raise AIServiceError("secret upstream response")
            return super().create_embeddings(texts)

    provider = FailingProvider()
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=provider,
    )
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/documents",
            files={
                "file": (
                    "report.pdf",
                    make_pdf("Revenue grew 18%."),
                    "application/pdf",
                )
            },
        )
        assert uploaded.status_code == 201
        provider.fail_embeddings = True
        response = client.post(
            f"/api/documents/{uploaded.json()['id']}/chat",
            json={"question": "What happened to revenue?"},
        )
        assert response.status_code == 502
        assert "secret upstream response" not in response.text


def test_upload_is_saved_when_embedding_provider_fails(tmp_path):
    class FailingEmbeddingProvider(StubAIProvider):
        def create_embeddings(self, texts):
            raise AIServiceError("secret upstream response")

    content = make_pdf("A valid PDF whose embeddings temporarily fail.")
    app = create_app(
        database_path=tmp_path / "documents.sqlite3",
        upload_dir=tmp_path / "uploads",
        ai_provider=FailingEmbeddingProvider(),
    )

    with TestClient(app) as client:
        uploaded = client.post(
            "/api/documents",
            files={"file": ("report.pdf", content, "application/pdf")},
        )

        assert uploaded.status_code == 201
        document = uploaded.json()
        assert document["index_status"] == "pending"
        assert "valid PDF" in document["text_preview"]

        listing = client.get("/api/documents")
        assert [item["id"] for item in listing.json()] == [document["id"]]

        download = client.get(f"/api/documents/{document['id']}/file")
        assert download.status_code == 200
        assert download.content == content


def test_chunks_overlap_and_keep_original_page_numbers():
    chunks = chunk_pages(
        [(3, "abcdefghijklmnopqrstuvwxyz")],
        chunk_size=10,
        overlap=3,
    )

    assert chunks == [
        {"page_number": 3, "content": "abcdefghij"},
        {"page_number": 3, "content": "hijklmnopq"},
        {"page_number": 3, "content": "opqrstuvwx"},
        {"page_number": 3, "content": "vwxyz"},
    ]
