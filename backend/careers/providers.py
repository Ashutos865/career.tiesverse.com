import base64
import json
import mimetypes
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings


class ProviderError(RuntimeError):
    pass


CATEGORY_KEYS = ["Tech", "Content", "Media", "Operations"]
CATEGORY_POSITIONS = {
    "Content": ["content_editor", "content_writer_upsc", "upsc_strategist", "graphic_designer_canva", "uiux_designer"],
    "Media": ["video_editor_reels_yt", "social_media_manager_ig", "youtube_manager"],
    "Operations": ["hr", "marketing_outreach", "management_coordination", "collab_outreach"],
    "Tech": ["tech_roles"],
}
DEFAULT_GATE_KEYS = [
    "Tech",
    "Content",
    "Media",
    "Operations",
    "content_editor",
    "content_writer_upsc",
    "upsc_strategist",
    "graphic_designer_canva",
    "uiux_designer",
    "video_editor_reels_yt",
    "social_media_manager_ig",
    "youtube_manager",
    "hr",
    "marketing_outreach",
    "management_coordination",
    "collab_outreach",
    "tech_roles",
]


class AppsScriptProvider:
    def get(self, params):
        query = urlencode({key: value for key, value in params.items() if key != "callback"})
        separator = "&" if "?" in settings.APPSCRIPT_BACKEND_URL else "?"
        return self._request(f"{settings.APPSCRIPT_BACKEND_URL}{separator}{query}")

    def post(self, payload):
        request = Request(
            settings.APPSCRIPT_BACKEND_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._request(request)

    def _request(self, request_or_url):
        try:
            with urlopen(request_or_url, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            raise ProviderError(f"Apps Script returned HTTP {exc.code}") from exc
        except URLError as exc:
            raise ProviderError(f"Apps Script unreachable: {exc.reason}") from exc

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProviderError("Apps Script returned a non-JSON response") from exc


class CloudflareD1Provider:
    def get(self, params):
        action = str(params.get("action") or "GET_CANDIDATES").strip() or "GET_CANDIDATES"

        if action == "ADMIN_LOGIN":
            return self.admin_login(params.get("password"))
        if action == "ADMIN_CHECK":
            return {"status": "success" if self.validate_session(params.get("token")) else "UNAUTHORIZED"}
        if action in {"GET_CANDIDATES", "GET_FORM_GATES"} and not self.validate_session(params.get("token")):
            return {"status": "UNAUTHORIZED"}
        if action == "GET_CANDIDATES":
            return {
                "status": "success",
                "data": [
                    self.serialize_candidate(row)
                    for row in self.query_rows(
                        """
                        SELECT id, timestamp, department, roles, first_name, last_name, email, phone, city,
                               linkedin, portfolio, why_join, answers, resume_name, resume_key,
                               interview_status, interviewer, rating, final_decision, created_at
                        FROM candidates
                        ORDER BY id ASC
                        """
                    )
                ],
            }
        if action == "GET_FORM_GATES":
            return {"status": "success", "gates": self.read_form_gates()}
        if action == "GET_PUBLIC_FORM_GATES":
            return {"status": "success", "gates": self.read_form_gates()}
        if action == "FORM_STATUS":
            department = str(params.get("department") or "").strip()
            email = normalize_email(params.get("email"))
            phone = normalize_phone(params.get("phone"))
            return {
                "status": "success",
                "open": self.is_form_open(department) if department else True,
                "duplicate": self.has_recent_duplicate(department, email, phone) if department else False,
                "department": department,
            }
        if action == "CHECK_REQUEST":
            request_id = str(params.get("request_id") or "").strip()
            if not request_id:
                return {"status": "error", "message": "Missing request_id"}
            return {"status": "success", "found": bool(self.find_request(request_id))}
        if action == "GET_RESUME":
            return self.get_resume(params.get("row"))

        return {"status": "error", "message": "Unknown action"}

    def post(self, payload):
        action = payload.get("action")

        if action == "ADMIN_LOGIN":
            return self.admin_login(payload.get("password"))

        if action == "ADMIN_CHECK":
            return {"status": "success" if self.validate_session(payload.get("token")) else "UNAUTHORIZED"}

        if action == "SET_FORM_GATES":
            if not self.validate_session(payload.get("token")):
                return {"status": "UNAUTHORIZED"}
            self.write_form_gates(normalize_gate_hierarchy(payload.get("gates") or {}))
            return {"status": "success"}

        if action == "UPDATE_ROW":
            if not self.validate_session(payload.get("token")):
                return {"status": "UNAUTHORIZED"}
            row_id = int(payload.get("row") or 0)
            self.query(
                """
                UPDATE candidates
                SET interview_status = ?, interviewer = ?, rating = ?, final_decision = ?, updated_at = ?
                WHERE id = ?
                """,
                [
                    str(payload.get("interview_status") or ""),
                    str(payload.get("interviewer") or ""),
                    int(payload.get("rating") or 0),
                    str(payload.get("final_decision") or "Under Review"),
                    now_iso(),
                    row_id,
                ],
            )
            return {"status": "success", "message": "Updated"}

        if action == "CREATE":
            return self.create_candidate(payload)

        return {"status": "error", "message": "Unknown action"}

    def admin_login(self, password):
        if str(password or "") != settings.ADMIN_PASSWORD:
            return {"status": "error", "message": "INVALID_PASSWORD"}
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(days=settings.ADMIN_SESSION_DAYS)).isoformat()
        self.query(
            "INSERT INTO admin_sessions (token, expires_at, created_at) VALUES (?, ?, ?)",
            [token, expires_at, now_iso()],
        )
        return {"status": "success", "token": token, "expires_at": expires_at}

    def validate_session(self, token):
        value = str(token or "").strip()
        if not value:
            return False
        current = now_iso()
        self.query("DELETE FROM admin_sessions WHERE expires_at <= ?", [current])
        rows = self.query_rows("SELECT token FROM admin_sessions WHERE token = ? AND expires_at > ? LIMIT 1", [value, current])
        return bool(rows)

    def create_candidate(self, data):
        department = str(data.get("department") or "").strip()
        email = normalize_email(data.get("email"))
        phone = normalize_phone(data.get("phone"))
        request_id = str(data.get("request_id") or f"req_{secrets.token_hex(12)}").strip()

        if department and not self.is_form_open(department):
            return {"status": "CLOSED"}
        if department and self.has_recent_duplicate(department, email, phone):
            return {"status": "DUPLICATE_30D"}
        if self.find_request(request_id):
            return {"status": "success"}

        resume_meta = self.store_resume(data, request_id)

        self.query(
            """
            INSERT INTO candidates (
                timestamp, department, roles, first_name, last_name, email, phone, city,
                linkedin, portfolio, why_join, answers, resume_name, resume_key, resume_content_type, resume_data,
                interview_status, interviewer, rating, final_decision, request_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                now_iso(),
                department,
                str(data.get("roles") or ""),
                str(data.get("first_name") or ""),
                str(data.get("last_name") or ""),
                str(data.get("email") or ""),
                str(data.get("phone") or ""),
                str(data.get("city") or ""),
                str(data.get("linkedin") or ""),
                str(data.get("portfolio") or ""),
                str(data.get("why_join") or ""),
                stringify_answers(data.get("answers")),
                resume_meta.get("name", ""),
                resume_meta.get("key", ""),
                resume_meta.get("content_type", ""),
                "",
                "Pending Setup",
                "",
                0,
                "Under Review",
                request_id,
                now_iso(),
                now_iso(),
            ],
        )
        return {"status": "success"}

    def store_resume(self, data, request_id):
        resume_data = str(data.get("resume_data") or "")
        resume_name = sanitize_filename(str(data.get("resume_name") or "").strip())
        if not resume_data or not resume_name:
            return {}

        if "," in resume_data:
            header, raw = resume_data.split(",", 1)
        else:
            header, raw = "", resume_data

        try:
            content = base64.b64decode(raw)
        except Exception as exc:
            raise ProviderError("Uploaded resume could not be decoded") from exc

        content_type = "application/octet-stream"
        if header.startswith("data:") and ";" in header:
            content_type = header[5:].split(";", 1)[0] or content_type
        else:
            content_type = mimetypes.guess_type(resume_name)[0] or content_type

        extension = ""
        if "." in resume_name:
            extension = "." + resume_name.rsplit(".", 1)[1].lower()
        key = f"resumes/{datetime.now(timezone.utc).strftime('%Y/%m')}/{request_id}-{secrets.token_hex(8)}{extension}"
        R2Storage().put_object(key, content, content_type)
        return {"key": key, "name": resume_name, "content_type": content_type}

    def read_form_gates(self):
        gates = {key: True for key in DEFAULT_GATE_KEYS}
        for row in self.query_rows("SELECT key, is_open FROM form_gates"):
            gates[str(row.get("key"))] = bool(row.get("is_open"))
        return normalize_gate_hierarchy(gates)

    def write_form_gates(self, gates):
        for key, is_open in gates.items():
            self.query(
                """
                INSERT INTO form_gates (key, is_open, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET is_open = excluded.is_open, updated_at = excluded.updated_at
                """,
                [key, 1 if is_open else 0, now_iso()],
            )

    def is_form_open(self, department):
        return self.read_form_gates().get(department, True) is not False

    def has_recent_duplicate(self, department, email, phone):
        if not email and not phone:
            return False
        since = (datetime.now(timezone.utc) - timedelta(days=settings.DEDUP_WINDOW_DAYS)).isoformat()
        rows = self.query_rows(
            """
            SELECT email, phone FROM candidates
            WHERE department = ? AND created_at >= ?
            """,
            [department, since],
        )
        for row in rows:
            if email and normalize_email(row.get("email")) == email:
                return True
            if phone and normalize_phone(row.get("phone")) == phone:
                return True
        return False

    def find_request(self, request_id):
        rows = self.query_rows("SELECT id FROM candidates WHERE request_id = ? LIMIT 1", [request_id])
        return rows[0] if rows else None

    def get_resume(self, row_id):
        rows = self.query_rows(
            "SELECT resume_name, resume_key, resume_content_type FROM candidates WHERE id = ? LIMIT 1",
            [int(row_id or 0)],
        )
        if not rows or not rows[0].get("resume_key"):
            return {"status": "error", "message": "Resume not found"}
        content = R2Storage().get_object(rows[0].get("resume_key"))
        return {
            "status": "success",
            "resume_name": rows[0].get("resume_name") or "resume.pdf",
            "content_type": rows[0].get("resume_content_type") or "application/octet-stream",
            "content": content,
        }

    def serialize_candidate(self, row):
        row_id = row.get("id")
        resume_link = f"/api/resume/{row_id}/" if row.get("resume_key") else ""
        return {
            "timestamp": row.get("timestamp") or row.get("created_at") or "",
            "row_index": row_id,
            "department": row.get("department") or "",
            "roles": row.get("roles") or "",
            "first_name": row.get("first_name") or "",
            "last_name": row.get("last_name") or "",
            "email": row.get("email") or "",
            "phone": row.get("phone") or "",
            "city": row.get("city") or "",
            "linkedin": row.get("linkedin") or "",
            "portfolio": row.get("portfolio") or "",
            "why_join": row.get("why_join") or "",
            "answers": row.get("answers") or "",
            "resume_link": resume_link,
            "interview_status": row.get("interview_status") or "Pending Setup",
            "interviewer": row.get("interviewer") or "",
            "rating": row.get("rating") or 0,
            "final_decision": row.get("final_decision") or "Under Review",
        }

    def query_rows(self, sql, params=None):
        result = self.query(sql, params or [])
        return result.get("results") or []

    def query(self, sql, params=None):
        self.ensure_configured()
        endpoint = (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{settings.CLOUDFLARE_ACCOUNT_ID}/d1/database/{settings.CLOUDFLARE_D1_DATABASE_ID}/query"
        )
        request = Request(
            endpoint,
            data=json.dumps({"sql": sql, "params": params or []}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {settings.CLOUDFLARE_API_TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ProviderError(f"Cloudflare D1 returned HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise ProviderError(f"Cloudflare D1 unreachable: {exc.reason}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError("Cloudflare D1 returned a non-JSON response") from exc

        if not payload.get("success"):
            raise ProviderError(f"Cloudflare D1 query failed: {payload.get('errors') or payload}")
        results = payload.get("result") or []
        if not results:
            return {"results": [], "meta": {}}
        first = results[0]
        if not first.get("success", True):
            raise ProviderError(f"Cloudflare D1 statement failed: {first}")
        return {"results": first.get("results") or [], "meta": first.get("meta") or {}}

    def ensure_configured(self):
        missing = [
            name
            for name, value in {
                "CLOUDFLARE_ACCOUNT_ID": settings.CLOUDFLARE_ACCOUNT_ID,
                "CLOUDFLARE_D1_DATABASE_ID": settings.CLOUDFLARE_D1_DATABASE_ID,
                "CLOUDFLARE_API_TOKEN": settings.CLOUDFLARE_API_TOKEN,
            }.items()
            if not value
        ]
        if missing:
            raise ProviderError("Missing Cloudflare settings: " + ", ".join(missing))


class R2Storage:
    def __init__(self):
        self.ensure_configured()

    def client(self):
        import boto3
        from botocore.config import Config

        return boto3.client(
            "s3",
            endpoint_url=f"https://{settings.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.CLOUDFLARE_R2_ACCESS_KEY_ID,
            aws_secret_access_key=settings.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )

    def put_object(self, key, content, content_type):
        self.client().put_object(
            Bucket=settings.CLOUDFLARE_R2_BUCKET,
            Key=key,
            Body=content,
            ContentType=content_type,
        )

    def get_object(self, key):
        response = self.client().get_object(Bucket=settings.CLOUDFLARE_R2_BUCKET, Key=key)
        return response["Body"].read()

    def ensure_configured(self):
        missing = [
            name
            for name, value in {
                "CLOUDFLARE_ACCOUNT_ID": settings.CLOUDFLARE_ACCOUNT_ID,
                "CLOUDFLARE_R2_BUCKET": settings.CLOUDFLARE_R2_BUCKET,
                "CLOUDFLARE_R2_ACCESS_KEY_ID": settings.CLOUDFLARE_R2_ACCESS_KEY_ID,
                "CLOUDFLARE_R2_SECRET_ACCESS_KEY": settings.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
            }.items()
            if not value
        ]
        if missing:
            raise ProviderError("Missing Cloudflare R2 settings: " + ", ".join(missing))


def get_data_provider():
    if settings.DATA_PROVIDER == "appscript":
        return AppsScriptProvider()
    if settings.DATA_PROVIDER == "cloudflare":
        return CloudflareD1Provider()
    raise ProviderError(f"Unknown TV_DATA_PROVIDER: {settings.DATA_PROVIDER}")


def normalize_gate_hierarchy(incoming):
    merged = {key: True for key in DEFAULT_GATE_KEYS}
    merged.update({str(key): value is not False for key, value in (incoming or {}).items()})

    for category in CATEGORY_KEYS:
        positions = CATEGORY_POSITIONS.get(category, [])
        if merged.get(category) is False:
            for position in positions:
                merged[position] = False
            continue
        if any(merged.get(position) is not False for position in positions):
            merged[category] = True

    return {key: merged.get(key) is not False for key in DEFAULT_GATE_KEYS}


def stringify_answers(value):
    if not isinstance(value, list):
        return str(value or "")
    lines = []
    for item in value:
        q = str((item or {}).get("q") or "").strip()
        a = str((item or {}).get("a") or "").strip()
        if q or a:
            lines.append(f"{q}\n-> {a}".strip())
    return "\n\n".join(lines)


def normalize_email(value):
    return str(value or "").strip().lower()


def normalize_phone(value):
    return re.sub(r"[^\d+]", "", str(value or ""))


def sanitize_filename(value):
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", value or "resume.pdf").strip()
    return cleaned[:120] or "resume.pdf"


def now_iso():
    return datetime.now(timezone.utc).isoformat()
