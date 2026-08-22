import type { MonitorMethod, MonitorStatus } from "../../shared/types";

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
