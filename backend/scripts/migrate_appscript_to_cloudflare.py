import csv
import hashlib
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "migration" / "Master.csv"
DEFAULT_RESUMES = ROOT / "migration" / "resumes"


def load_dotenv():
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def require_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clean_filename(value, fallback="resume"):
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", str(value or fallback)).strip()
    return cleaned[:140] or fallback


def normalize_header(value):
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def d1_query(endpoint, api_token, sql, params=None):
    request = Request(
        endpoint,
        data=json.dumps({"sql": sql, "params": params or []}).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("success"):
        raise RuntimeError(json.dumps(payload, indent=2))
    result = payload.get("result") or []
    return result[0] if result else {}


class R2:
    def __init__(self):
        import boto3
        from botocore.config import Config

        account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
        self.bucket = require_env("CLOUDFLARE_R2_BUCKET")
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=require_env("CLOUDFLARE_R2_ACCESS_KEY_ID"),
            aws_secret_access_key=require_env("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )

    def upload(self, key, content, content_type):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=content, ContentType=content_type)


def guess_local_resume_path(row, resume_dir):
    candidates = []
    resume_link = str(row.get("resume_link") or "").strip()
    if resume_link:
        parsed = urlparse(resume_link)
        file_id = parse_qs(parsed.query).get("id", [""])[0]
        if not file_id:
            match = re.search(r"/d/([^/]+)", parsed.path)
            if match:
                file_id = match.group(1)
        if file_id:
            candidates.extend(resume_dir.glob(f"*{file_id}*"))

    name_parts = [row.get("first_name"), row.get("last_name"), row.get("email")]
    slugs = [clean_filename(part, "").lower() for part in name_parts if part]
    for path in resume_dir.iterdir() if resume_dir.exists() else []:
        low = path.name.lower()
        if any(slug and slug in low for slug in slugs):
            candidates.append(path)

    for path in candidates:
        if path.is_file():
            return path
    return None


def download_resume(row):
    resume_link = str(row.get("resume_link") or "").strip()
    if not resume_link.startswith("http"):
        return None

    try:
        request = Request(resume_link, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=30) as response:
            content = response.read()
            content_type = response.headers.get("Content-Type") or "application/octet-stream"
            name = "resume"
            disposition = response.headers.get("Content-Disposition") or ""
            match = re.search(r'filename="?([^";]+)', disposition)
            if match:
                name = match.group(1)
            return clean_filename(name), content, content_type
    except Exception:
        return None


def load_resume(row, resume_dir):
    local = guess_local_resume_path(row, resume_dir)
    if local:
        return local.name, local.read_bytes(), mimetypes.guess_type(local.name)[0] or "application/octet-stream"

    downloaded = download_resume(row)
    if downloaded:
        return downloaded

    return "", b"", ""


def row_value(row, *keys, default=""):
    for key in keys:
        normalized = normalize_header(key)
        if normalized in row and str(row[normalized]).strip():
            return str(row[normalized]).strip()
    return default


def stable_request_id(row):
    existing = row_value(row, "request_id")
    if existing:
        return existing

    source_id = row_value(row, "id")
    if source_id:
        return f"migrated_{clean_filename(source_id, 'source')}"

    fingerprint = "|".join(
        [
            row_value(row, "timestamp"),
            row_value(row, "email"),
            row_value(row, "phone"),
            row_value(row, "first_name"),
            row_value(row, "last_name"),
        ]
    )
    digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:16]
    return f"migrated_{digest}"


def parse_rating(value):
    try:
        return int(float(str(value or "0").strip() or 0))
    except ValueError:
        return 0


def migrate(csv_path=DEFAULT_CSV, resume_dir=DEFAULT_RESUMES):
    load_dotenv()
    account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
    database_id = require_env("CLOUDFLARE_D1_DATABASE_ID")
    api_token = require_env("CLOUDFLARE_API_TOKEN")
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
    r2 = R2()

    if not csv_path.exists():
        raise SystemExit(f"CSV not found: {csv_path}")

    inserted = 0
    skipped = 0
    uploaded = 0

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            row = {normalize_header(k): v for k, v in raw.items()}
            email = row_value(row, "email", "e-mail")
            first_name = row_value(row, "first_name", "first name")
            last_name = row_value(row, "last_name", "last name")
            if not email and not first_name:
                continue

            request_id = stable_request_id(row)

            exists = d1_query(endpoint, api_token, "SELECT id FROM candidates WHERE request_id = ? LIMIT 1", [request_id])
            if exists.get("results"):
                skipped += 1
                continue

            resume_name, resume_content, resume_content_type = load_resume(row, resume_dir)
            resume_key = ""
            if resume_content:
                extension = Path(resume_name).suffix.lower()
                resume_key = f"resumes/migrated/{request_id}-{secrets.token_hex(8)}{extension}"
                r2.upload(resume_key, resume_content, resume_content_type or "application/octet-stream")
                uploaded += 1

            timestamp = row_value(row, "timestamp", default=now_iso())
            params = [
                timestamp,
                row_value(row, "department"),
                row_value(row, "roles"),
                first_name,
                last_name,
                email,
                row_value(row, "phone"),
                row_value(row, "city"),
                row_value(row, "linkedin"),
                row_value(row, "portfolio"),
                row_value(row, "why_join"),
                row_value(row, "answers"),
                resume_name,
                resume_key,
                resume_content_type,
                "",
                row_value(row, "interview_status", default="Pending Setup"),
                row_value(row, "interviewer"),
                parse_rating(row_value(row, "rating", default="0")),
                row_value(row, "final_decision", default="Under Review"),
                request_id,
                timestamp,
                now_iso(),
            ]
            d1_query(
                endpoint,
                api_token,
                """
                INSERT INTO candidates (
                    timestamp, department, roles, first_name, last_name, email, phone, city,
                    linkedin, portfolio, why_join, answers, resume_name, resume_key,
                    resume_content_type, resume_data, interview_status, interviewer, rating,
                    final_decision, request_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                params,
            )
            inserted += 1

    print(f"Inserted rows: {inserted}")
    print(f"Skipped existing rows: {skipped}")
    print(f"Uploaded resumes: {uploaded}")


if __name__ == "__main__":
    migrate()
