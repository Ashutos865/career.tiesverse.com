import json
import os
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "docs" / "cloudflare-d1-schema.sql"


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


def d1_query(endpoint, api_token, sql, params=None):
    request = Request(
        endpoint,
        data=json.dumps({"sql": sql, "params": params or []}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    with urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if not payload.get("success"):
        raise SystemExit(json.dumps(payload, indent=2))
    result = payload.get("result") or []
    return result[0] if result else {}


def ensure_column(endpoint, api_token, table, column, definition):
    result = d1_query(endpoint, api_token, f"PRAGMA table_info({table})")
    columns = {row.get("name") for row in result.get("results") or []}
    if column in columns:
        return
    d1_query(endpoint, api_token, f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    print(f"Added missing column: {table}.{column}")


def main():
    load_dotenv()
    account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
    database_id = require_env("CLOUDFLARE_D1_DATABASE_ID")
    api_token = require_env("CLOUDFLARE_API_TOKEN")
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"

    d1_query(endpoint, api_token, SCHEMA_PATH.read_text(encoding="utf-8"))
    ensure_column(endpoint, api_token, "candidates", "resume_key", "TEXT NOT NULL DEFAULT ''")
    ensure_column(endpoint, api_token, "candidates", "resume_content_type", "TEXT NOT NULL DEFAULT ''")

    print("Cloudflare D1 schema applied successfully.")


if __name__ == "__main__":
    main()
