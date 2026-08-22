import type {
  MonitorStatus,
  PublicMonitor,
  PublicStatusResponse,
  StatusMetricPoint,
} from "../shared/types";

interface PublicMonitorRow {
  id: string;
  name: string;
  url: string;
  interval_seconds: number;
  paused: number;
  created_at: number;
  status: Exclude<MonitorStatus, "paused"> | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_http_status: number | null;
  last_error: string | null;
}

interface MetricRow {
  monitor_id: string;
  bucket_start: number;
  total_checks: number;
  successful_checks: number;
  total_latency_ms: number;
  min_latency_ms: number | null;
  max_latency_ms: number | null;
}

interface IncidentWindowRow {
  monitor_id: string;
  started_at: number;
  resolved_at: number | null;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const TWENTY_FOUR_HOURS = 24 * 60 * 60;

export async function getPublicStatus(env: Env, now: number): Promise<PublicStatusResponse> {
  const [monitorResult, metricResult, incidentResult] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, m.name, m.url, m.interval_seconds, m.paused, m.created_at,
              s.status, s.last_checked_at, s.last_latency_ms,
              s.last_http_status, s.last_error
         FROM monitors m
         LEFT JOIN monitor_state s ON s.monitor_id = m.id
        ORDER BY m.created_at ASC`,
    ).all<PublicMonitorRow>(),
    env.DB.prepare(
      `SELECT monitor_id, bucket_start, total_checks, successful_checks,
              total_latency_ms, min_latency_ms, max_latency_ms
         FROM metrics_hourly
        WHERE bucket_start >= ?1
        ORDER BY bucket_start ASC`,
    )
      .bind(now - TWENTY_FOUR_HOURS)
      .all<MetricRow>(),
    env.DB.prepare(
      `SELECT monitor_id, started_at, resolved_at
         FROM incidents
        WHERE started_at < ?1
          AND (resolved_at IS NULL OR resolved_at > ?2)`,
    )
      .bind(now, now - THIRTY_DAYS)
      .all<IncidentWindowRow>(),
  ]);

  const metricsByMonitor = groupMetrics(metricResult.results);
  const incidentsByMonitor = groupIncidents(incidentResult.results);
  const monitors = monitorResult.results.map((row) =>
    mapPublicMonitor(row, metricsByMonitor.get(row.id) ?? [], incidentsByMonitor.get(row.id) ?? [], now),
  );

  return {
    siteName: env.SITE_NAME,
    generatedAt: now,
    overallStatus: overallStatus(monitors),
    monitors,
  };
}

function mapPublicMonitor(
  row: PublicMonitorRow,
  metrics: StatusMetricPoint[],
  incidents: IncidentWindowRow[],
  now: number,
): PublicMonitor {
  let status: MonitorStatus = row.status ?? "unknown";
  if (row.paused === 1) {
    status = "paused";
  } else if (
    row.last_checked_at === null ||
    now - row.last_checked_at > Math.max(row.interval_seconds * 3, 180)
  ) {
    status = "unknown";
  }

  const observedFrom = Math.max(row.created_at, now - THIRTY_DAYS);
  const observedSeconds = Math.max(0, now - observedFrom);
  let uptime30d: number | null = null;
  if (row.last_checked_at !== null && observedSeconds > 0) {
    const downtime = incidents.reduce((total, incident) => {
      const start = Math.max(observedFrom, incident.started_at);
      const end = Math.min(now, incident.resolved_at ?? now);
      return total + Math.max(0, end - start);
    }, 0);
    uptime30d = Math.max(0, Math.min(100, ((observedSeconds - downtime) / observedSeconds) * 100));
  }

  return {
    id: row.id,
    name: row.name,
    url: publicOrigin(row.url),
    status,
    lastCheckedAt: row.last_checked_at,
    lastLatencyMs: row.last_latency_ms,
    lastHttpStatus: row.last_http_status,
    lastError:
      row.last_error && (status === "down" || status === "verifying" || status === "recovering")
        ? "The latest health check failed."
        : null,
    uptime30d,
    metrics,
  };
}

function publicOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function groupMetrics(rows: MetricRow[]): Map<string, StatusMetricPoint[]> {
  const grouped = new Map<string, StatusMetricPoint[]>();
  for (const row of rows) {
    const points = grouped.get(row.monitor_id) ?? [];
    points.push({
      timestamp: row.bucket_start,
      checks: row.total_checks,
      successes: row.successful_checks,
      averageLatencyMs:
        row.successful_checks > 0 ? Math.round(row.total_latency_ms / row.successful_checks) : null,
      minLatencyMs: row.min_latency_ms,
      maxLatencyMs: row.max_latency_ms,
    });
    grouped.set(row.monitor_id, points);
  }
  return grouped;
}

function groupIncidents(rows: IncidentWindowRow[]): Map<string, IncidentWindowRow[]> {
  const grouped = new Map<string, IncidentWindowRow[]>();
  for (const row of rows) {
    const incidents = grouped.get(row.monitor_id) ?? [];
    incidents.push(row);
    grouped.set(row.monitor_id, incidents);
  }
  return grouped;
}

function overallStatus(monitors: PublicMonitor[]): MonitorStatus {
  const active = monitors.filter((monitor) => monitor.status !== "paused");
  if (active.length === 0) return "unknown";
  if (active.some((monitor) => monitor.status === "down")) return "down";
  if (active.some((monitor) => monitor.status === "verifying")) return "verifying";
  if (active.some((monitor) => monitor.status === "recovering")) return "recovering";
  if (active.some((monitor) => monitor.status === "unknown")) return "unknown";
  return "up";
}
