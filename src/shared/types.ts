export type MonitorStatus =
  | "unknown"
  | "up"
  | "verifying"
  | "down"
  | "recovering"
  | "paused";

export type MonitorMethod = "GET" | "HEAD";

export interface MonitorInput {
  name: string;
  url: string;
  method: MonitorMethod;
  expectedStatusMin: number;
  expectedStatusMax: number;
  expectedKeyword: string | null;
  timeoutMs: number;
  intervalSeconds: 60 | 300 | 900;
  followRedirects: boolean;
  paused: boolean;
}

export interface StatusMetricPoint {
  timestamp: number;
  checks: number;
  successes: number;
  averageLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface PublicMonitor {
  id: string;
  name: string;
  url: string;
  status: MonitorStatus;
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  uptime30d: number | null;
  metrics: StatusMetricPoint[];
}

export interface PublicStatusResponse {
  siteName: string;
  generatedAt: number;
  overallStatus: MonitorStatus;
  monitors: PublicMonitor[];
}

export interface AdminMonitor extends MonitorInput {
  id: string;
  status: MonitorStatus;
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface IncidentSummary {
  id: string;
  monitorId: string;
  monitorName: string;
  startedAt: number;
  resolvedAt: number | null;
  initialError: string | null;
  lastError: string | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: string | null;
  actorIp: string | null;
  createdAt: number;
}

export type FailureKind = "http" | "timeout" | "network" | "keyword" | "body";

/** Consecutive failed checks that shared one cause. */
export interface FailureRun {
  id: number;
  startedAt: number;
  endedAt: number;
  /** First passing check after the run, when the run ended in recovery. */
  passedAt: number | null;
  /** Whether the run ended with a passing check, a different failure, or is still failing. */
  outcome: "passed" | "changed" | "ongoing";
  failureKind: FailureKind;
  httpStatus: number | null;
  reason: string;
  failedChecks: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  // Admin only.
  error?: string | null;
  responseBody?: string | null;
  responseHeaders?: Record<string, string>;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
  timeoutMs?: number;
}

export interface AlertDelivery {
  kind: "down" | "recovered";
  status: "pending" | "sent" | "failed";
  attempts: number;
  sentAt: number | null;
  error: string | null;
}

export interface IncidentDetail extends IncidentSummary {
  /** When the third consecutive failure confirmed the outage. */
  confirmedAt: number;
  alerts?: AlertDelivery[];
}

export interface ConfigChange {
  action: string;
  details: string | null;
  createdAt: number;
}

export interface CheckDetailsResponse {
  monitorName: string;
  from: number;
  to: number;
  generatedAt: number;
  /** Null for incident windows, which are not aligned to hourly counts. */
  totalChecks: number | null;
  successfulChecks: number | null;
  failedChecks: number;
  latency: { averageMs: number | null; minMs: number | null; maxMs: number | null } | null;
  /** Confirmed incident time inside the window. */
  downtimeSeconds: number;
  runs: FailureRun[];
  runsTruncated: boolean;
  incidents: IncidentDetail[];
  configChanges?: ConfigChange[];
}
