PRAGMA foreign_keys = ON;

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
  expected_status_min INTEGER NOT NULL DEFAULT 200,
  expected_status_max INTEGER NOT NULL DEFAULT 399,
  expected_keyword TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds IN (60, 300, 900)),
  follow_redirects INTEGER NOT NULL DEFAULT 0 CHECK (follow_redirects IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE monitor_state (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'up', 'verifying', 'down', 'recovering')),
  last_checked_at INTEGER,
  last_latency_ms INTEGER,
  last_http_status INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  verification_started_at INTEGER,
  changed_at INTEGER NOT NULL
);

CREATE TABLE metrics_hourly (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  total_checks INTEGER NOT NULL DEFAULT 0,
  successful_checks INTEGER NOT NULL DEFAULT 0,
  failed_checks INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  min_latency_ms INTEGER,
  max_latency_ms INTEGER,
  PRIMARY KEY (monitor_id, bucket_start)
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  initial_error TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX one_open_incident_per_monitor
  ON incidents(monitor_id)
  WHERE resolved_at IS NULL;

CREATE INDEX incidents_monitor_started
  ON incidents(monitor_id, started_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('down', 'recovered', 'test')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE UNIQUE INDEX one_incident_notification_kind
  ON notifications(incident_id, kind)
  WHERE incident_id IS NOT NULL;

CREATE INDEX notifications_due
  ON notifications(status, next_attempt_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  actor_ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX audit_logs_created
  ON audit_logs(created_at DESC);

CREATE TABLE runtime_locks (
  name TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
