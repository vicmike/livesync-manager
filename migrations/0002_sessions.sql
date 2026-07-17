-- Server-side admin sessions (docs/API.md § Auth). The id is the SHA-256
-- of the cookie token, so a database leak does not yield valid cookies.

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
