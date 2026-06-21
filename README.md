# TIESVERSE Career Site

This project keeps the static frontend at the repository root and all backend code inside `backend/`.

Backend-only documentation lives in `backend/docs/django-backend.md`.

## Run locally

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 127.0.0.1:8000
```

Open `http://127.0.0.1:8000/` for the careers page or `http://127.0.0.1:8000/admin.html` for the ATS.

In VS Code, clicking Live Server's Go Live opens the frontend on port `5501`; `.vscode/go-live.ps1` starts Django on port `8000` for API calls.

## Admin

The current admin password is configured in `backend/tiesverse_backend/settings.py` as `ADMIN_PASSWORD`.

## Data

Production data now goes through Cloudflare D1 by default. Uploaded resume files go to Cloudflare R2. Copy `backend/.env.example` to `backend/.env`, fill the Cloudflare values, then run:

```powershell
cd backend
python scripts/init_cloudflare_d1.py
```

Apps Script remains only as an optional fallback with `TV_DATA_PROVIDER=appscript`.
