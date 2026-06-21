# Django Backend Documentation

## Purpose

The Django backend is now the API layer for the career site. The browser talks to Django at `/api/`, and Django talks to the active data provider.

The active data provider is Cloudflare D1. Django sits between the frontend and D1, so the HTML pages do not need Cloudflare credentials and do not talk to Cloudflare directly.

## Current Runtime Flow

```text
Frontend HTML -> tv-config.js -> Django /api/ -> Cloudflare D1 + R2
```

The frontend still uses the same action names as before:

- `ADMIN_LOGIN`
- `ADMIN_CHECK`
- `GET_CANDIDATES`
- `GET_FORM_GATES`
- `GET_PUBLIC_FORM_GATES`
- `FORM_STATUS`
- `CHECK_REQUEST`
- `SET_FORM_GATES`
- `UPDATE_ROW`
- `CREATE`

## Important Files

- `backend/manage.py`: Django command entrypoint.
- `backend/tiesverse_backend/settings.py`: Django settings and provider config.
- `backend/tiesverse_backend/urls.py`: Static page routes and `/api/`.
- `backend/careers/views.py`: Request entrypoint and local fallback API logic.
- `backend/careers/providers.py`: Data provider adapter layer.
- `tv-config.js`: Frontend API URL selection.
- `.vscode/go-live.ps1`: Starts Django when Live Server opens the frontend.

## Provider Settings

The backend defaults to Cloudflare:

```powershell
$env:TV_DATA_PROVIDER = "cloudflare"
$env:CLOUDFLARE_ACCOUNT_ID = "..."
$env:CLOUDFLARE_D1_DATABASE_ID = "..."
$env:CLOUDFLARE_API_TOKEN = "..."
$env:CLOUDFLARE_R2_BUCKET = "..."
$env:CLOUDFLARE_R2_ACCESS_KEY_ID = "..."
$env:CLOUDFLARE_R2_SECRET_ACCESS_KEY = "..."
```

You can also copy `backend/.env.example` to `backend/.env` and fill in those values. Django loads `backend/.env` automatically.

## Cloudflare D1 Setup

Create a D1 database in Cloudflare, then create a custom API token with Account -> D1 -> Edit permission.

Apply the schema:

```powershell
cd backend
python scripts/init_cloudflare_d1.py
```

The schema lives at `docs/cloudflare-d1-schema.sql`.

The D1 provider uses Cloudflare's official D1 query API:

```text
POST /accounts/{account_id}/d1/database/{database_id}/query
```

## Cloudflare R2 Setup

Create an R2 bucket for resumes, for example:

```text
tiesverse-resumes
```

Then create R2 S3 API credentials from the R2 dashboard. Add these to `.env`:

```powershell
$env:CLOUDFLARE_R2_BUCKET = "tiesverse-resumes"
$env:CLOUDFLARE_R2_ACCESS_KEY_ID = "..."
$env:CLOUDFLARE_R2_SECRET_ACCESS_KEY = "..."
```

Uploaded resumes are decoded by Django and uploaded to R2 as files under keys like:

```text
resumes/2026/06/{request_id}-{random}.pdf
```

D1 stores only the file metadata:

- `resume_name`
- `resume_key`
- `resume_content_type`

## Running Locally

Install dependencies:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 127.0.0.1:8000
```

Open:

- Careers site: `http://127.0.0.1:8000/`
- Admin ATS: `http://127.0.0.1:8000/admin.html`
- API: `http://127.0.0.1:8000/api/?action=GET_PUBLIC_FORM_GATES`

## VS Code Go Live

The workspace is configured so Live Server uses port `5501`.

When Go Live opens the browser, `.vscode/go-live.ps1` starts Django on `127.0.0.1:8000` if it is not already running, then opens the Live Server URL.

Frontend pages served by Live Server detect port `5501` in `tv-config.js` and send API calls to:

```text
http://127.0.0.1:8000/api/
```

## Data Storage

Cloudflare D1 stores:

- Candidate applications
- Resume file metadata
- Form gates
- Admin sessions
- Candidate evaluation updates

Cloudflare R2 stores:

- Uploaded resume files

Apps Script is no longer used by default. It remains in the code only as an optional fallback if `TV_DATA_PROVIDER=appscript`.
