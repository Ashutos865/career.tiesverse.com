CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    roles TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    linkedin TEXT NOT NULL DEFAULT '',
    portfolio TEXT NOT NULL DEFAULT '',
    why_join TEXT NOT NULL DEFAULT '',
    answers TEXT NOT NULL DEFAULT '',
    resume_name TEXT NOT NULL DEFAULT '',
    resume_key TEXT NOT NULL DEFAULT '',
    resume_content_type TEXT NOT NULL DEFAULT '',
    resume_data TEXT NOT NULL DEFAULT '',
    interview_status TEXT NOT NULL DEFAULT 'Pending Setup',
    interviewer TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    final_decision TEXT NOT NULL DEFAULT 'Under Review',
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_department_created ON candidates (department, created_at);
-- The application cooldowns scan by recency across every department, so the
-- department-first index above cannot serve them.
CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates (created_at);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates (email);
CREATE INDEX IF NOT EXISTS idx_candidates_request_id ON candidates (request_id);

CREATE TABLE IF NOT EXISTS form_gates (
    key TEXT PRIMARY KEY,
    is_open INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions (expires_at);
