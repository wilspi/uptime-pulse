import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AdminMonitor, AuditLogEntry, IncidentSummary, MonitorInput } from "../shared/types";
import { auditStatement } from "./db/audit";
import { recordCheck } from "./db/record-check";
import type { MonitorRow } from "./db/types";
import { requireAdmin } from "./http/auth";
import { readJsonBody } from "./http/body";
import { checkMonitor } from "./monitoring/checker";
import { parseMonitorInput, ValidationError } from "./monitoring/validation";
import { isSmtpConfigured, sendSmtpMail, SmtpError } from "./notifications/smtp";
import { getPublicStatus } from "./status";
import { getHourDetails, getIncidentDetails, parseHour } from "./check-details";

interface AdminMonitorRow extends MonitorRow {
  status: AdminMonitor["status"] | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_http_status: number | null;
  last_error: string | null;
}

interface IncidentRow {
  id: string;
  monitor_id: string;
  monitor_name: string;
  started_at: number;
  resolved_at: number | null;
  initial_error: string | null;
  last_error: string | null;
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: string | null;
  actor_ip: string | null;
  created_at: number;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", secureHeaders());
app.use("*", async (c, next) => {
  const startedAt = performance.now();
  await next();
  console.log(
    JSON.stringify({
      message: "api_request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    }),
  );
});

app.get("/api/status", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const status = await getPublicStatus(c.env, now);
  return c.json(status, 200, {
    "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
  });
});

app.get("/api/status/monitors/:id/checks", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const hour = parseHour(c.req.query("hour"), now);
  const details = await getHourDetails(c.env, { monitorId: c.req.param("id"), hour, now, admin: false });
  if (!details) return c.json({ error: "Monitor not found." }, 404);
  // Past hours change only when a run that spans them later recovers.
  return c.json(details, 200, {
    "Cache-Control": hour + 3600 <= now ? "public, max-age=300" : "public, max-age=30",
  });
});

app.use("/api/admin/*", requireAdmin);
app.use("/api/admin/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/api/admin/monitors/:id/checks", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const hour = parseHour(c.req.query("hour"), now);
  const details = await getHourDetails(c.env, { monitorId: c.req.param("id"), hour, now, admin: true });
  return details ? c.json(details) : c.json({ error: "Monitor not found." }, 404);
});

app.get("/api/admin/incidents/:id", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const details = await getIncidentDetails(c.env, { incidentId: c.req.param("id"), now });
  return details ? c.json(details) : c.json({ error: "Incident not found." }, 404);
});

app.get("/api/admin/config", (c) =>
  c.json({
    siteName: c.env.SITE_NAME,
    smtpConfigured: isSmtpConfigured(c.env),
    smtpHost: c.env.SMTP_HOST,
    smtpPort: Number(c.env.SMTP_PORT),
    smtpFrom: c.env.SMTP_FROM,
    smtpTo: c.env.SMTP_TO,
  }),
);

app.get("/api/admin/monitors", async (c) => {
  const result = await c.env.DB.prepare(adminMonitorSelect()).all<AdminMonitorRow>();
  return c.json({ monitors: result.results.map(mapAdminMonitor) });
});

app.post("/api/admin/monitors", async (c) => {
  const input = parseMonitorInput(await readJsonBody(c.req.raw));
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM monitors").first<number>(
    "total",
  );
  if ((count ?? 0) >= 20) {
    return c.json({ error: "The free-plan safety limit is 20 monitors." }, 409);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    insertMonitorStatement(c.env, id, input, now),
    c.env.DB.prepare(
      `INSERT INTO monitor_state (monitor_id, status, changed_at)
       VALUES (?1, 'unknown', ?2)`,
    ).bind(id, now),
    auditStatement(c.env, {
      action: "monitor.created",
      entityType: "monitor",
      entityId: id,
      details: { name: input.name, url: input.url },
      actorIp: requestIp(c.req.raw),
      createdAt: now,
    }),
  ]);

  const monitor = await getAdminMonitor(c.env, id);
  return c.json({ monitor }, 201);
});

app.put("/api/admin/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getMonitorRow(c.env, id);
  if (!existing) return c.json({ error: "Monitor not found." }, 404);

  const input = parseMonitorInput(await readJsonBody(c.req.raw));
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    updateMonitorStatement(c.env, id, input, now),
    auditStatement(c.env, {
      action: "monitor.updated",
      entityType: "monitor",
      entityId: id,
      details: { name: input.name, url: input.url, paused: input.paused },
      actorIp: requestIp(c.req.raw),
      createdAt: now,
    }),
  ]);

  const monitor = await getAdminMonitor(c.env, id);
  return c.json({ monitor });
});

app.delete("/api/admin/monitors/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getMonitorRow(c.env, id);
  if (!existing) return c.json({ error: "Monitor not found." }, 404);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM notifications WHERE incident_id IN (SELECT id FROM incidents WHERE monitor_id = ?1)",
    ).bind(id),
    c.env.DB.prepare("DELETE FROM incidents WHERE monitor_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM metrics_hourly WHERE monitor_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM check_runs WHERE monitor_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM monitor_state WHERE monitor_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM monitors WHERE id = ?1").bind(id),
    auditStatement(c.env, {
      action: "monitor.deleted",
      entityType: "monitor",
      entityId: id,
      details: { name: existing.name, url: existing.url },
      actorIp: requestIp(c.req.raw),
      createdAt: now,
    }),
  ]);
  return c.body(null, 204);
});

app.post("/api/admin/monitors/:id/check", async (c) => {
  const monitor = await getMonitorRow(c.env, c.req.param("id"));
  if (!monitor) return c.json({ error: "Monitor not found." }, 404);

  const result = await checkMonitor(monitor);
  const state = await recordCheck(c.env, monitor, result);
  await auditStatement(c.env, {
    action: "monitor.checked_manually",
    entityType: "monitor",
    entityId: monitor.id,
    details: { successful: result.successful, latencyMs: result.latencyMs },
    actorIp: requestIp(c.req.raw),
  }).run();

  return c.json({ result, state });
});

app.get("/api/admin/incidents", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at,
            i.resolved_at, i.initial_error, i.last_error
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      ORDER BY i.started_at DESC
      LIMIT 100`,
  ).all<IncidentRow>();
  const incidents: IncidentSummary[] = result.results.map((row) => ({
    id: row.id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    initialError: row.initial_error,
    lastError: row.last_error,
  }));
  return c.json({ incidents });
});

app.get("/api/admin/logs", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, action, entity_type, entity_id, details, actor_ip, created_at
       FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 100`,
  ).all<AuditRow>();
  const logs: AuditLogEntry[] = result.results.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details,
    actorIp: row.actor_ip,
    createdAt: row.created_at,
  }));
  return c.json({ logs });
});

app.post("/api/admin/smtp/test", async (c) => {
  if (!isSmtpConfigured(c.env)) {
    return c.json({ error: "SMTP is not configured. Update wrangler.jsonc and Worker secrets." }, 409);
  }

  try {
    await sendSmtpMail(c.env, {
      kind: "test",
      subject: `[${c.env.SITE_NAME}] SMTP test successful`,
      body: [
        `This is a test notification from ${c.env.SITE_NAME}.`,
        "",
        `Sent: ${new Date().toISOString()}`,
        `SMTP server: ${c.env.SMTP_HOST}:${c.env.SMTP_PORT}`,
      ].join("\n"),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown SMTP error";
    console.error(JSON.stringify({ message: "smtp_test_failed", error: detail }));
    return c.json({ error: detail }, error instanceof SmtpError && error.permanent ? 422 : 502);
  }

  await auditStatement(c.env, {
    action: "smtp.test_sent",
    entityType: "smtp",
    actorIp: requestIp(c.req.raw),
  }).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof ValidationError) {
    return c.json({ error: error.message }, 400);
  }
  console.error(
    JSON.stringify({
      message: "api_unhandled_error",
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return c.json({ error: "Internal server error" }, 500);
});

export { app };

function adminMonitorSelect(id?: string): string {
  return `SELECT m.id, m.name, m.url, m.method, m.expected_status_min,
                 m.expected_status_max, m.expected_keyword, m.timeout_ms,
                 m.interval_seconds, m.follow_redirects, m.paused,
                 m.created_at, m.updated_at, s.status, s.last_checked_at,
                 s.last_latency_ms, s.last_http_status, s.last_error
            FROM monitors m
            LEFT JOIN monitor_state s ON s.monitor_id = m.id
           ${id ? "WHERE m.id = ?1" : ""}
           ORDER BY m.created_at ASC`;
}

async function getAdminMonitor(env: Env, id: string): Promise<AdminMonitor | null> {
  const row = await env.DB.prepare(adminMonitorSelect(id)).bind(id).first<AdminMonitorRow>();
  return row ? mapAdminMonitor(row) : null;
}

async function getMonitorRow(env: Env, id: string): Promise<MonitorRow | null> {
  return env.DB.prepare(
    `SELECT id, name, url, method, expected_status_min, expected_status_max,
            expected_keyword, timeout_ms, interval_seconds, follow_redirects,
            paused, created_at, updated_at
       FROM monitors
      WHERE id = ?1`,
  )
    .bind(id)
    .first<MonitorRow>();
}

function mapAdminMonitor(row: AdminMonitorRow): AdminMonitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    expectedStatusMin: row.expected_status_min,
    expectedStatusMax: row.expected_status_max,
    expectedKeyword: row.expected_keyword,
    timeoutMs: row.timeout_ms,
    intervalSeconds: row.interval_seconds,
    followRedirects: row.follow_redirects === 1,
    paused: row.paused === 1,
    status: row.paused === 1 ? "paused" : (row.status ?? "unknown"),
    lastCheckedAt: row.last_checked_at,
    lastLatencyMs: row.last_latency_ms,
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertMonitorStatement(
  env: Env,
  id: string,
  input: MonitorInput,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO monitors (
       id, name, url, method, expected_status_min, expected_status_max,
       expected_keyword, timeout_ms, interval_seconds, follow_redirects,
       paused, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
  ).bind(
    id,
    input.name,
    input.url,
    input.method,
    input.expectedStatusMin,
    input.expectedStatusMax,
    input.expectedKeyword,
    input.timeoutMs,
    input.intervalSeconds,
    input.followRedirects ? 1 : 0,
    input.paused ? 1 : 0,
    now,
  );
}

function updateMonitorStatement(
  env: Env,
  id: string,
  input: MonitorInput,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE monitors SET
       name = ?1, url = ?2, method = ?3, expected_status_min = ?4,
       expected_status_max = ?5, expected_keyword = ?6, timeout_ms = ?7,
       interval_seconds = ?8, follow_redirects = ?9, paused = ?10,
       updated_at = ?11
     WHERE id = ?12`,
  ).bind(
    input.name,
    input.url,
    input.method,
    input.expectedStatusMin,
    input.expectedStatusMax,
    input.expectedKeyword,
    input.timeoutMs,
    input.intervalSeconds,
    input.followRedirects ? 1 : 0,
    input.paused ? 1 : 0,
    now,
    id,
  );
}

function requestIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP");
}
