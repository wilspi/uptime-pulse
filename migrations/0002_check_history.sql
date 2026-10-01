-- One row per run of consecutive failed checks with the same cause.
-- Passing checks are not stored individually; metrics_hourly already counts them.
CREATE TABLE check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  recovered_at INTEGER,
  failure_kind TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  failed_checks INTEGER NOT NULL DEFAULT 1,
  total_latency_ms INTEGER NOT NULL,
  max_latency_ms INTEGER NOT NULL,
  response_body TEXT,
  response_headers TEXT,
  expected_status_min INTEGER NOT NULL,
  expected_status_max INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL
);

CREATE INDEX check_runs_monitor_started ON check_runs(monitor_id, started_at);
