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
