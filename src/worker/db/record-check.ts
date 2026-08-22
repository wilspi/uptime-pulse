import type { MonitorStatus } from "../../shared/types";
import { transitionMonitorState } from "../monitoring/state-machine";
import type { CheckResult } from "../monitoring/checker";
import type { MonitorRow, MonitorStateRow, OpenIncidentRow } from "./types";

export interface RecordedCheck {
  previousStatus: Exclude<MonitorStatus, "paused">;
  currentStatus: Exclude<MonitorStatus, "paused">;
}

export async function recordCheck(
  env: Env,
  monitor: MonitorRow,
  result: CheckResult,
): Promise<RecordedCheck> {
  const current = await env.DB.prepare(
    `SELECT monitor_id, status, last_checked_at, last_latency_ms, last_http_status,
            last_error, consecutive_failures, consecutive_successes,
            verification_started_at, changed_at
       FROM monitor_state
      WHERE monitor_id = ?1`,
  )
    .bind(monitor.id)
    .first<MonitorStateRow>();

  const previousStatus = current?.status ?? "unknown";
  const next = transitionMonitorState(
    {
      status: previousStatus,
      consecutiveFailures: current?.consecutive_failures ?? 0,
      consecutiveSuccesses: current?.consecutive_successes ?? 0,
      verificationStartedAt: current?.verification_started_at ?? null,
    },
    result.successful,
    result.checkedAt,
  );

  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB.prepare(
      `INSERT INTO monitor_state (
         monitor_id, status, last_checked_at, last_latency_ms, last_http_status,
         last_error, consecutive_failures, consecutive_successes,
         verification_started_at, changed_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(monitor_id) DO UPDATE SET
         status = excluded.status,
         last_checked_at = excluded.last_checked_at,
         last_latency_ms = excluded.last_latency_ms,
         last_http_status = excluded.last_http_status,
         last_error = excluded.last_error,
         consecutive_failures = excluded.consecutive_failures,
         consecutive_successes = excluded.consecutive_successes,
         verification_started_at = excluded.verification_started_at,
         changed_at = excluded.changed_at`,
    ).bind(
      monitor.id,
      next.status,
      result.checkedAt,
      result.latencyMs,
      result.httpStatus,
      result.error,
      next.consecutiveFailures,
      next.consecutiveSuccesses,
      next.verificationStartedAt,
      next.status === previousStatus ? (current?.changed_at ?? result.checkedAt) : result.checkedAt,
    ),
  );

  const bucketStart = Math.floor(result.checkedAt / 3600) * 3600;
  const successfulLatency = result.successful ? result.latencyMs : null;
  statements.push(
    env.DB.prepare(
      `INSERT INTO metrics_hourly (
         monitor_id, bucket_start, total_checks, successful_checks, failed_checks,
         total_latency_ms, min_latency_ms, max_latency_ms
       ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(monitor_id, bucket_start) DO UPDATE SET
         total_checks = metrics_hourly.total_checks + 1,
         successful_checks = metrics_hourly.successful_checks + excluded.successful_checks,
         failed_checks = metrics_hourly.failed_checks + excluded.failed_checks,
         total_latency_ms = metrics_hourly.total_latency_ms + excluded.total_latency_ms,
         min_latency_ms = CASE
           WHEN excluded.min_latency_ms IS NULL THEN metrics_hourly.min_latency_ms
           WHEN metrics_hourly.min_latency_ms IS NULL THEN excluded.min_latency_ms
           ELSE MIN(metrics_hourly.min_latency_ms, excluded.min_latency_ms)
         END,
         max_latency_ms = CASE
           WHEN excluded.max_latency_ms IS NULL THEN metrics_hourly.max_latency_ms
           WHEN metrics_hourly.max_latency_ms IS NULL THEN excluded.max_latency_ms
           ELSE MAX(metrics_hourly.max_latency_ms, excluded.max_latency_ms)
         END`,
    ).bind(
      monitor.id,
      bucketStart,
      result.successful ? 1 : 0,
      result.successful ? 0 : 1,
      result.successful ? result.latencyMs : 0,
      successfulLatency,
    ),
  );

  let openIncident: OpenIncidentRow | null = null;
  if (next.openedIncident || next.resolvedIncident || next.status === "down") {
    openIncident = await env.DB.prepare(
      `SELECT id, monitor_id, started_at
         FROM incidents
        WHERE monitor_id = ?1 AND resolved_at IS NULL
        LIMIT 1`,
    )
      .bind(monitor.id)
      .first<OpenIncidentRow>();
  }

  if (next.openedIncident && !openIncident) {
    const incidentId = crypto.randomUUID();
    const startedAt = next.verificationStartedAt ?? result.checkedAt;
    statements.push(
      env.DB.prepare(
        `INSERT INTO incidents (
           id, monitor_id, started_at, resolved_at, initial_error, last_error, created_at
         ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, ?5)`,
      ).bind(incidentId, monitor.id, startedAt, result.error, result.checkedAt),
      env.DB.prepare(
        `INSERT INTO notifications (
           id, incident_id, kind, subject, body, status, attempts,
           next_attempt_at, created_at
         ) VALUES (?1, ?2, 'down', ?3, ?4, 'pending', 0, ?5, ?5)`,
      ).bind(
        crypto.randomUUID(),
        incidentId,
        `[${env.SITE_NAME}] ${monitor.name} is down`,
        downMessage(env.SITE_NAME, monitor, result, startedAt),
        result.checkedAt,
      ),
    );
  } else if (next.status === "down" && openIncident && result.error) {
    statements.push(
      env.DB.prepare("UPDATE incidents SET last_error = ?1 WHERE id = ?2").bind(
        result.error,
        openIncident.id,
      ),
    );
  }

  if (next.resolvedIncident && openIncident) {
    const durationSeconds = Math.max(0, result.checkedAt - openIncident.started_at);
    statements.push(
      env.DB.prepare(
        "UPDATE incidents SET resolved_at = ?1, last_error = NULL WHERE id = ?2",
      ).bind(result.checkedAt, openIncident.id),
      env.DB.prepare(
        `INSERT INTO notifications (
           id, incident_id, kind, subject, body, status, attempts,
           next_attempt_at, created_at
         ) VALUES (?1, ?2, 'recovered', ?3, ?4, 'pending', 0, ?5, ?5)`,
      ).bind(
        crypto.randomUUID(),
        openIncident.id,
        `[${env.SITE_NAME}] ${monitor.name} recovered`,
        recoveryMessage(env.SITE_NAME, monitor, result, durationSeconds),
        result.checkedAt,
      ),
    );
  }

  await env.DB.batch(statements);
  logEvent("monitor_checked", {
    monitorId: monitor.id,
    successful: result.successful,
    latencyMs: result.latencyMs,
    status: next.status,
    httpStatus: result.httpStatus,
  });

  return { previousStatus, currentStatus: next.status };
}

function downMessage(
  siteName: string,
  monitor: MonitorRow,
  result: CheckResult,
  startedAt: number,
): string {
  return [
    `${monitor.name} has been confirmed down by ${siteName}.`,
    "",
    `URL: ${monitor.url}`,
    `Failure began: ${new Date(startedAt * 1000).toISOString()}`,
    `Latest error: ${result.error ?? "Unknown error"}`,
    `Response time: ${result.latencyMs} ms`,
  ].join("\n");
}

function recoveryMessage(
  siteName: string,
  monitor: MonitorRow,
  result: CheckResult,
  durationSeconds: number,
): string {
  return [
    `${monitor.name} has recovered according to ${siteName}.`,
    "",
    `URL: ${monitor.url}`,
    `Recovered: ${new Date(result.checkedAt * 1000).toISOString()}`,
    `Incident duration: ${formatDuration(durationSeconds)}`,
    `Response time: ${result.latencyMs} ms`,
  ].join("\n");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function logEvent(message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...fields }));
}
