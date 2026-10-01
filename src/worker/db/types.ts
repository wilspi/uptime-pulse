import type { FailureKind, MonitorMethod, MonitorStatus } from "../../shared/types";

export interface MonitorRow {
  id: string;
  name: string;
  url: string;
  method: MonitorMethod;
  expected_status_min: number;
  expected_status_max: number;
  expected_keyword: string | null;
  timeout_ms: number;
  interval_seconds: 60 | 300 | 900;
  follow_redirects: number;
  paused: number;
  created_at: number;
  updated_at: number;
}

export interface MonitorStateRow {
  monitor_id: string;
  status: Exclude<MonitorStatus, "paused">;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_http_status: number | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  verification_started_at: number | null;
  changed_at: number;
}

export interface OpenIncidentRow {
  id: string;
  monitor_id: string;
  started_at: number;
}

export interface OpenRunRow {
  id: number;
  started_at: number;
  failure_kind: FailureKind;
  http_status: number | null;
  error: string | null;
}

export interface CheckContext {
  state: MonitorStateRow | null;
  openRun: OpenRunRow | null;
  openIncident: OpenIncidentRow | null;
  /** Error of the run that began the current verification window, if it has one. */
  verificationError: string | null;
}
