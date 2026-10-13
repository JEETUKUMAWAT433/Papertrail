<<<<<<< HEAD
# Papertrail — AI Study Buddy

Papertrail is a local PDF library with a React frontend and FastAPI backend. Upload a PDF to extract and read its text, ask grounded questions, generate English or Hindi summaries and topic explanations, and take multiple-choice quizzes with grading and saved history.

The **Study hours** dashboard also provides a timestamp-based study timer, pause/resume, custom subjects and notes, persisted daily goals, study statistics, recent weekly and subject charts, date/subject-filtered history, and configurable Pomodoro focus/break cycles. Focus timer subjects include Engineering Mathematics, Introduction to Python, Introduction to Programming with C, and Informatics. Additional subjects can be added from the subject selector and are saved in that browser.

## Requirements

- Windows 10/11 with PowerShell
- Python 3.10 or newer
- Node.js 20 or newer (includes npm)
- An OpenAI API key, only for chat and AI study features

PDF upload and text extraction work without an API key. AI features use an OpenAI-compatible API for embeddings and chat completions.

## Install

Open PowerShell in the project root (the folder containing this README). Create the backend virtual environment and install Python dependencies:

```powershell
Set-Location .\backend
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Open a second PowerShell window in the project root and install the frontend dependencies:

```powershell
Set-Location .\frontend
npm install
```

## Configure the AI provider

Set the key in the **same PowerShell window used to start the backend**. The secure prompt avoids placing the key directly in the command or saving it in a project file:

```powershell
$secureKey = Read-Host "OpenAI API key" -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
```

Do not put API keys in frontend code, source files, or committed `.env` files. If a key has been shared or exposed, revoke it and use a new one.

Optional OpenAI-compatible provider settings:

```powershell
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
$env:OPENAI_CHAT_MODEL = "gpt-4o-mini"
```

Those are the defaults; set them only when you need to override them. `OPENAI_BASE_URL` should be the API base URL ending in `/v1`, not an individual endpoint. The backend appends `/embeddings` and `/chat/completions`.

The key is read when the backend starts. If you set or change it after starting the API, stop and restart the backend in the same PowerShell window. Without a key, uploads still work, but chat and study endpoints respond with a setup error.

## Clerk authentication

The React app uses Clerk sign-in and sign-up controls and requires a signed-in user to access the library and study tracker. Every authenticated API request carries the current Clerk session token; FastAPI verifies it against Clerk's public signing keys and stores each user's documents, quiz history, study sessions, and daily goal in a separate local database and upload folder. Clerk was initialized from `frontend` and linked to the Papertrail development instance. For a fresh local setup, authenticate the Clerk CLI and pull the linked instance's local environment configuration:

```powershell
Set-Location .\frontend
clerk auth login
clerk env pull
clerk env pull --file ..\backend\.env
```

Keep both generated environment files private; they are ignored by Git. The frontend needs `VITE_CLERK_PUBLISHABLE_KEY`. The backend uses `VITE_CLERK_PUBLISHABLE_KEY` from `backend\.env` to discover Clerk's public key set; it never needs or reads `CLERK_SECRET_KEY`. Vite exposes only variables prefixed with `VITE_`, so never rename or copy a Clerk secret to a `VITE_` variable. Restart both servers after changing Clerk environment configuration. The development instance emits a normal warning and should not be used for production.

The existing shared SQLite database is left unassigned and is not visible to any account. Each user's new data is isolated using a stable hash of the verified Clerk user ID. The backend remains intended for local use; do not expose it to an untrusted network.

## Start the application

### Backend

From the backend PowerShell window opened at the project root:

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Leave this window open. Check the API at <http://127.0.0.1:8000/api/health>; a healthy server returns `{"status":"ok"}`. The AI configuration status is available at <http://127.0.0.1:8000/api/chat/status>.

### Frontend

From the frontend PowerShell window opened at the project root:

```powershell
Set-Location .\frontend
npm run dev
```

Open the Vite URL printed in the terminal, normally <http://localhost:5173>. If that port is busy, Vite selects another port and prints the URL to use. The Vite development server proxies `/api` requests to `http://127.0.0.1:8000`.

## Data and privacy

Uploaded PDFs and the SQLite database are stored under `backend\data\`. The API accepts PDF files up to 20 MB and checks the extension, PDF signature, and whether the document can be opened. Password-protected PDFs are rejected. PDFs without embedded selectable text can be stored, but OCR is not included.

PDFs remain on this machine unless an AI operation is requested. When chat, embeddings, summaries, explanations, or quizzes are used, relevant extracted PDF text is sent to the configured AI provider. Clerk authentication currently protects only the browser UI; backend API routes and the shared local database do not yet enforce user identity. The app is intended for local use; do not expose the backend to an untrusted network.

For each signed-in account, documents, quiz history, study sessions, pause/resume intervals, and the daily goal are stored in `backend\data\users\<user-id-hash>\documents.sqlite3`; uploaded files are stored in that account's `uploads` subfolder. The original shared database at `backend\data\documents.sqlite3` is left unassigned and is not displayed to signed-in accounts. The server timestamps intervals and calculates durations/statistics from saved start/end timestamps; an active or paused session is restored by the dashboard after navigation or refresh. The Pomodoro focus/break configuration and custom timer subjects are stored in that account's browser local storage so the settings persist across refreshes without being shared between accounts on that browser.

Study tracker API routes:

- `GET /api/study/active` — current active/paused session, or `null`.
- `POST /api/study/sessions` — start a session with `{ "subject": "Python", "notes": "optional" }`.
- `POST /api/study/sessions/{id}/pause`, `/resume`, and `/stop` — control and save the timer.
- `GET /api/study/sessions` — completed history; supports `subject`, `from_date`, `to_date`, and `timezone_offset_minutes` filters.
- `GET /api/study/dashboard?timezone_offset_minutes=...` — timestamp-derived totals, streak, goal progress, seven-day chart data, and current-month subject totals.
- `GET /api/study/goal` and `PUT /api/study/goal` — read or set the daily target in minutes (1–1440).

## Tests and production build

From a PowerShell window opened at the project root, run backend tests (they use a deterministic AI stub and do not require a key or network access):

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe -m pytest -q
```

Build and type-check the frontend:

```powershell
Set-Location .\frontend
npm run build
```

The frontend currently has no separate unit-test script; `npm run build` runs the TypeScript project check and Vite production build.

## Troubleshooting

- **The library does not load / API is not responding:** Keep the backend terminal running. Visit `http://127.0.0.1:8000/api/health`; if it does not return `{"status":"ok"}`, start Uvicorn from `project\backend` using the command above. Check that port 8000 is available.
- **API says the Clerk session is missing or invalid:** Sign in again and restart the backend after running `clerk env pull --file ..\backend\.env` from `project\frontend`. The backend uses Clerk's public signing keys; it does not need the Clerk secret key.
- **Chat or study tools say the provider is not configured:** Run `GET http://127.0.0.1:8000/api/chat/status`. If `configured` is `false`, set `OPENAI_API_KEY` in the backend terminal and restart Uvicorn. The frontend cannot configure this key.
- **Provider requests fail:** Check that the key is valid, active, and allowed to use the selected models. For a compatible provider, verify `OPENAI_BASE_URL` and both model names. Provider/network errors are returned as safe API errors; the local server log may provide additional diagnostic context.
- **Uploads return 413:** The file exceeds the 20 MB limit.
- **Uploads return 415 or 422:** Check that the file is a readable PDF, is not password-protected, and has not merely been renamed with a `.pdf` extension.
- **The PDF has no text / study tools say there is no extractable text:** The PDF may be a scan. OCR is not supported; use a PDF with a selectable text layer.
- **The frontend opens on a different port:** Use the exact Vite URL printed in its terminal. If the API still cannot be reached, confirm the backend is listening on port 8000 and restart Vite after changing `vite.config.ts`.
- **PowerShell cannot activate a virtual environment:** Activation is not required; the commands in this guide call `.venv\Scripts\python.exe` directly.
=======
# Papertrail
study web application
>>>>>>> 14f5641b7e4043227fbe68206b1b490d01ebe441
