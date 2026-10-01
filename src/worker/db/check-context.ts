import type { FailureKind, MonitorStatus } from "../../shared/types";
import type { CheckContext, MonitorRow } from "./types";

/** A monitor joined with everything recordCheck reads, so recording needs only its write batch. */
export interface MonitorWithContextRow extends MonitorRow {
  state_status: Exclude<MonitorStatus, "paused"> | null;
  state_last_checked_at: number | null;
  state_last_latency_ms: number | null;
  state_last_http_status: number | null;
  state_last_error: string | null;
  state_consecutive_failures: number | null;
  state_consecutive_successes: number | null;
  state_verification_started_at: number | null;
  state_changed_at: number | null;
  run_id: number | null;
  run_started_at: number | null;
  run_recovered_at: number | null;
  run_failure_kind: FailureKind | null;
  run_http_status: number | null;
  run_error: string | null;
  incident_id: string | null;
  incident_started_at: number | null;
  verification_error: string | null;
}

export const MONITOR_WITH_CONTEXT_SELECT = `
  SELECT m.id, m.name, m.url, m.method, m.expected_status_min,
         m.expected_status_max, m.expected_keyword, m.timeout_ms,
         m.interval_seconds, m.follow_redirects, m.paused,
         m.created_at, m.updated_at,
         s.status AS state_status, s.last_checked_at AS state_last_checked_at,
         s.last_latency_ms AS state_last_latency_ms, s.last_http_status AS state_last_http_status,
         s.last_error AS state_last_error, s.consecutive_failures AS state_consecutive_failures,
         s.consecutive_successes AS state_consecutive_successes,
         s.verification_started_at AS state_verification_started_at, s.changed_at AS state_changed_at,
         r.id AS run_id, r.started_at AS run_started_at, r.recovered_at AS run_recovered_at,
         r.failure_kind AS run_failure_kind, r.http_status AS run_http_status, r.error AS run_error,
         i.id AS incident_id, i.started_at AS incident_started_at,
         (SELECT v.error FROM check_runs v
           WHERE v.monitor_id = m.id AND v.started_at = s.verification_started_at
           ORDER BY v.id LIMIT 1) AS verification_error
    FROM monitors m
    LEFT JOIN monitor_state s ON s.monitor_id = m.id
    LEFT JOIN check_runs r ON r.id = (
      SELECT id FROM check_runs WHERE monitor_id = m.id ORDER BY started_at DESC, id DESC LIMIT 1
    )
    LEFT JOIN incidents i ON i.monitor_id = m.id AND i.resolved_at IS NULL`;

export function splitMonitorContext(row: MonitorWithContextRow): { monitor: MonitorRow; context: CheckContext } {
  return {
    monitor: {
      id: row.id,
      name: row.name,
      url: row.url,
      method: row.method,
      expected_status_min: row.expected_status_min,
      expected_status_max: row.expected_status_max,
      expected_keyword: row.expected_keyword,
      timeout_ms: row.timeout_ms,
      interval_seconds: row.interval_seconds,
      follow_redirects: row.follow_redirects,
      paused: row.paused,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    context: {
      state: row.state_status === null
        ? null
        : {
            monitor_id: row.id,
            status: row.state_status,
            last_checked_at: row.state_last_checked_at,
            last_latency_ms: row.state_last_latency_ms,
            last_http_status: row.state_last_http_status,
            last_error: row.state_last_error,
            consecutive_failures: row.state_consecutive_failures ?? 0,
            consecutive_successes: row.state_consecutive_successes ?? 0,
            verification_started_at: row.state_verification_started_at,
            changed_at: row.state_changed_at ?? row.created_at,
          },
      // Only the newest run can still be open; an older unrecovered run was superseded by a new cause.
      openRun: row.run_id !== null && row.run_recovered_at === null
        ? {
            id: row.run_id,
            started_at: row.run_started_at!,
            failure_kind: row.run_failure_kind!,
            http_status: row.run_http_status,
            error: row.run_error,
          }
        : null,
      openIncident: row.incident_id === null
        ? null
        : { id: row.incident_id, monitor_id: row.id, started_at: row.incident_started_at! },
      verificationError: row.verification_error,
    },
  };
}

export async function loadCheckContext(env: Env, monitorId: string): Promise<CheckContext> {
  const row = await env.DB.prepare(`${MONITOR_WITH_CONTEXT_SELECT} WHERE m.id = ?1`)
    .bind(monitorId)
    .first<MonitorWithContextRow>();
  return row
    ? splitMonitorContext(row).context
    : { state: null, openRun: null, openIncident: null, verificationError: null };
}
