import type {
  AlertDelivery,
  CheckDetailsResponse,
  ConfigChange,
  FailureKind,
  FailureRun,
  IncidentDetail,
} from "../shared/types";
import { ValidationError } from "./monitoring/validation";

const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const MAX_RUNS = 100;

interface RunRow {
  id: number;
  started_at: number;
  ended_at: number;
  recovered_at: number | null;
  failure_kind: FailureKind;
  http_status: number | null;
  error: string | null;
  failed_checks: number;
  total_latency_ms: number;
  max_latency_ms: number;
  response_body: string | null;
  response_headers: string | null;
  expected_status_min: number;
  expected_status_max: number;
  timeout_ms: number;
}

interface IncidentRow {
  id: string;
  monitor_id: string;
  monitor_name: string;
  started_at: number;
  resolved_at: number | null;
  initial_error: string | null;
  last_error: string | null;
  created_at: number;
}

interface AlertRow {
  incident_id: string;
  kind: AlertDelivery["kind"];
  status: AlertDelivery["status"];
  attempts: number;
  sent_at: number | null;
  last_error: string | null;
}

interface AuditRow {
  action: string;
  details: string | null;
  created_at: number;
}

interface MetricRow {
  total_checks: number;
  successful_checks: number;
  total_latency_ms: number;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
}

interface Window {
  monitorId: string;
  monitorName: string;
  from: number;
  to: number;
  now: number;
  admin: boolean;
}

export function parseHour(value: string | undefined, now: number): number {
  const hour = Number(value);
  if (!value || !Number.isSafeInteger(hour) || hour % 3600 !== 0 || hour < now - RETENTION_SECONDS || hour > now) {
    throw new ValidationError("Choose an hourly block from the last 90 days.");
  }
  return hour;
}

export async function getHourDetails(
  env: Env,
  options: { monitorId: string; hour: number; now: number; admin: boolean; displayName?: string },
): Promise<CheckDetailsResponse | null> {
  const { monitorId, hour, now, admin, displayName } = options;
  const monitor = await env.DB.prepare("SELECT name FROM monitors WHERE id = ?1")
    .bind(monitorId)
    .first<{ name: string }>();
  if (!monitor) return null;

  const window = { monitorId, monitorName: displayName ?? monitor.name, from: hour, to: hour + 3600, now, admin };
  const [metricResult, ...rest] = await env.DB.batch([
    env.DB.prepare(
      `SELECT total_checks, successful_checks, total_latency_ms, min_latency_ms, max_latency_ms
         FROM metrics_hourly
        WHERE monitor_id = ?1 AND bucket_start = ?2`,
    ).bind(monitorId, hour),
    ...windowStatements(env, window, null),
  ]);
  const metric = (metricResult.results as MetricRow[])[0] ?? null;
  const total = metric?.total_checks ?? 0;
  const successes = metric?.successful_checks ?? 0;

  return {
    ...mapWindow(window, rest),
    totalChecks: total,
    successfulChecks: successes,
    failedChecks: total - successes,
    latency: metric
      ? {
          averageMs: successes > 0 ? Math.round(metric.total_latency_ms / successes) : null,
          minMs: metric.min_latency_ms,
          maxMs: metric.max_latency_ms,
        }
      : null,
  };
}

export async function getIncidentDetails(
  env: Env,
  options: { incidentId: string; now: number },
): Promise<CheckDetailsResponse | null> {
  const { incidentId, now } = options;
  const incident = await env.DB.prepare(
    `SELECT i.monitor_id, i.started_at, i.resolved_at, m.name AS monitor_name
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE i.id = ?1`,
  )
    .bind(incidentId)
    .first<Pick<IncidentRow, "monitor_id" | "started_at" | "resolved_at" | "monitor_name">>();
  if (!incident) return null;

  // Include the check that confirmed recovery.
  const window = {
    monitorId: incident.monitor_id,
    monitorName: incident.monitor_name,
    from: incident.started_at,
    to: (incident.resolved_at ?? now) + 1,
    now,
    admin: true,
  };
  const results = await env.DB.batch(windowStatements(env, window, incidentId));
  const details = mapWindow(window, results);
  return {
    ...details,
    totalChecks: null,
    successfulChecks: null,
    failedChecks: (results[2].results as { failed: number }[])[0]?.failed ?? 0,
    latency: null,
  };
}

function windowStatements(env: Env, window: Window, incidentId: string | null): D1PreparedStatement[] {
  const { monitorId, from, to, admin } = window;
  const incidentFilter = incidentId
    ? "i.monitor_id = ?1 AND i.id = ?2 AND i.started_at < ?3"
    : "i.monitor_id = ?1 AND i.started_at < ?3 AND (i.resolved_at IS NULL OR i.resolved_at >= ?2)";
  const incidentBindings = incidentId ? [monitorId, incidentId, to] : [monitorId, from, to];

  return [
    env.DB.prepare(
      `SELECT * FROM check_runs
        WHERE monitor_id = ?1 AND started_at < ?3 AND ended_at >= ?2
        ORDER BY started_at DESC, id DESC
        LIMIT ${MAX_RUNS + 1}`,
    ).bind(monitorId, from, to),
    env.DB.prepare(
      `SELECT id FROM check_runs WHERE monitor_id = ?1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).bind(monitorId),
    env.DB.prepare(
      `SELECT COALESCE(SUM(failed_checks), 0) AS failed FROM check_runs
        WHERE monitor_id = ?1 AND started_at < ?3 AND ended_at >= ?2`,
    ).bind(monitorId, from, to),
    env.DB.prepare(
      `SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at,
              i.initial_error, i.last_error, i.created_at
         FROM incidents i
         JOIN monitors m ON m.id = i.monitor_id
        WHERE ${incidentFilter}
        ORDER BY i.started_at DESC`,
    ).bind(...incidentBindings),
    ...(admin
      ? [
          env.DB.prepare(
            `SELECT n.incident_id, n.kind, n.status, n.attempts, n.sent_at, n.last_error
               FROM notifications n
               JOIN incidents i ON i.id = n.incident_id
              WHERE ${incidentFilter} AND n.kind IN ('down', 'recovered')
              ORDER BY n.created_at ASC`,
          ).bind(...incidentBindings),
          env.DB.prepare(
            `SELECT action, details, created_at FROM audit_logs
              WHERE entity_type = 'monitor' AND entity_id = ?1
                AND created_at >= ?2 AND created_at < ?3
              ORDER BY created_at ASC`,
          ).bind(monitorId, from, to),
        ]
      : []),
  ];
}

function mapWindow(
  window: Window,
  results: D1Result[],
): Pick<CheckDetailsResponse, "monitorName" | "from" | "to" | "generatedAt" | "downtimeSeconds" | "runs" | "runsTruncated" | "incidents" | "configChanges"> {
  const { from, to, now, admin } = window;
  const [runResult, latestResult, , incidentResult, alertResult, auditResult] = results;
  const runRows = runResult.results as RunRow[];
  const latestRunId = (latestResult.results as { id: number }[])[0]?.id ?? null;
  const incidentRows = incidentResult.results as IncidentRow[];
  const alertRows = (alertResult?.results ?? []) as AlertRow[];

  const windowEnd = Math.min(to, now);
  const downtimeSeconds = incidentRows.reduce((total, incident) => {
    const end = Math.min(windowEnd, incident.resolved_at ?? now);
    return total + Math.max(0, end - Math.max(from, incident.started_at));
  }, 0);

  return {
    monitorName: window.monitorName,
    from,
    to,
    generatedAt: now,
    downtimeSeconds,
    runs: runRows.slice(0, MAX_RUNS).map((row) => mapRun(row, latestRunId, admin)),
    runsTruncated: runRows.length > MAX_RUNS,
    incidents: incidentRows.map((row): IncidentDetail => ({
      id: row.id,
      monitorId: row.monitor_id,
      // A status page may show the monitor under a different name.
      monitorName: window.monitorName,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      confirmedAt: row.created_at,
      initialError: admin ? row.initial_error : null,
      lastError: admin ? row.last_error : null,
      ...(admin
        ? {
            alerts: alertRows
              .filter((alert) => alert.incident_id === row.id)
              .map((alert) => ({
                kind: alert.kind,
                status: alert.status,
                attempts: alert.attempts,
                sentAt: alert.sent_at,
                error: alert.last_error,
              })),
          }
        : {}),
    })),
    ...(admin
      ? {
          configChanges: ((auditResult?.results ?? []) as AuditRow[]).map((row): ConfigChange => ({
            action: row.action,
            details: row.details,
            createdAt: row.created_at,
          })),
        }
      : {}),
  };
}

function mapRun(row: RunRow, latestRunId: number | null, admin: boolean): FailureRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    passedAt: row.recovered_at,
    outcome: row.recovered_at !== null ? "passed" : row.id === latestRunId ? "ongoing" : "changed",
    failureKind: row.failure_kind,
    httpStatus: row.http_status,
    reason: publicReason(row.failure_kind, row.http_status),
    failedChecks: row.failed_checks,
    averageLatencyMs: Math.round(row.total_latency_ms / row.failed_checks),
    maxLatencyMs: row.max_latency_ms,
    ...(admin
      ? {
          error: row.error,
          responseBody: row.response_body,
          responseHeaders: JSON.parse(row.response_headers ?? "{}") as Record<string, string>,
          expectedStatusMin: row.expected_status_min,
          expectedStatusMax: row.expected_status_max,
          timeoutMs: row.timeout_ms,
        }
      : {}),
  };
}

function publicReason(kind: FailureKind, status: number | null): string {
  switch (kind) {
    case "http": return `Unexpected HTTP ${status ?? "status"}`;
    case "timeout": return "Request timed out";
    case "network": return "Connection failed (network, DNS or TLS)";
    case "keyword": return "Expected response text missing";
    case "body": return "Response body could not be read";
    default: return "Health check failed";
  }
}
