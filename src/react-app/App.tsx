import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AdminMonitor,
  AuditLogEntry,
  IncidentSummary,
  MonitorInput,
  MonitorStatus,
  PublicMonitor,
  PublicStatusResponse,
  SiteSettings,
  StatusPage,
} from "../shared/types";

import { CheckDetailsDialog, formatTime, type DetailSelection } from "./CheckDetailsDialog";
import { SharingSection, StatusPageDialog } from "./StatusPages";

// Shared status pages live at /s/<link>; everything else is the homepage.
const pageSlug = location.pathname.match(/^\/s\/([a-z0-9-]+)\/?$/i)?.[1]?.toLowerCase() ?? null;

const emptyMonitor: MonitorInput = {
  name: "",
  url: "https://",
  method: "GET",
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  expectedKeyword: null,
  timeoutMs: 10_000,
  intervalSeconds: 60,
  followRedirects: true,
  paused: false,
  showOnHomepage: false,
};

export function App() {
  const [adminOpen, setAdminOpen] = useState(location.hash === "#admin");
  const [status, setStatus] = useState<PublicStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(pageSlug ? `/api/pages/${encodeURIComponent(pageSlug)}` : "/api/status");
      if (response.status === 404 && pageSlug) throw new Error("This status page does not exist or is no longer shared.");
      if (!response.ok) throw new Error("Status data is temporarily unavailable.");
      setStatus(await response.json() as PublicStatusResponse);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load status.");
    }
  }, []);

  useEffect(() => {
    if (!pageSlug) return;
    // Backs up the X-Robots-Tag header in case a crawler only reads the document.
    const robots = Object.assign(document.createElement("meta"), { name: "robots", content: "noindex, nofollow" });
    document.head.append(robots);
    return () => robots.remove();
  }, []);

  useEffect(() => {
    if (status) document.title = status.siteName;
  }, [status]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  function showAdmin() {
    location.hash = "admin";
    setAdminOpen(true);
  }

  function showStatus() {
    history.replaceState(null, "", location.pathname);
    setAdminOpen(false);
    void loadStatus();
  }

  if (adminOpen) return <AdminPanel onClose={showStatus} />;

  const hidden = status !== null && !status.listed;

  return (
    <main className="shell">
      <header className="topbar">
        {/* A shared page does not link to the homepage or the admin area. */}
        {pageSlug
          ? <span className="brand"><span className="brand-mark"><span /></span>{status?.siteName ?? "Status"}</span>
          : <a className="brand" href="/" aria-label="Status home"><span className="brand-mark"><span /></span>{status?.siteName ?? "Uptime Pulse"}</a>}
        {!pageSlug && <button className="text-button" type="button" onClick={showAdmin}>Manage</button>}
      </header>

      {hidden ? (
        <section className="hero">
          <p className="eyebrow">Status</p>
          <h1>Status pages are shared privately</h1>
          <p className="hero-copy">Use the status page link you were given to see the services that matter to you.</p>
        </section>
      ) : (
        <section className="hero">
          <div className={`hero-icon ${statusTone(status?.overallStatus ?? "unknown")}`}>
            {status?.overallStatus === "down" ? "!" : "✓"}
          </div>
          <p className="eyebrow">System status</p>
          <h1>{overallMessage(status?.overallStatus)}</h1>
          {status?.description && <p className="hero-copy hero-description">{status.description}</p>}
          <p className="hero-copy">
            {status ? `${status.monitors.length} service${status.monitors.length === 1 ? "" : "s"} monitored from Cloudflare's network.` : error ? "" : "Retrieving the latest checks…"}
          </p>
        </section>
      )}

      {error && <div className="notice error">{error}</div>}

      {!hidden && (
        <section className="monitor-list" aria-label="Monitored services">
          {status?.monitors.map((monitor) => <MonitorCard key={monitor.id} monitor={monitor} generatedAt={status.generatedAt} />)}
          {status && status.monitors.length === 0 && (
            <div className="empty-state">
              <h2>No services yet</h2>
              <p>{pageSlug ? "Services will appear here once they are added to this page." : "Open Manage to add the first endpoint, or choose which monitors to show on the homepage."}</p>
            </div>
          )}
          {!status && !error && <div className="monitor-card skeleton" />}
        </section>
      )}

      <SiteFooter>
        {!hidden && <>Updated {status ? relativeTime(status.generatedAt) : "just now"} · status page refreshes every minute</>}
      </SiteFooter>
    </main>
  );
}

function MonitorCard({ monitor, generatedAt }: { monitor: PublicMonitor; generatedAt: number }) {
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const latestHour = Math.floor(generatedAt / 3600) * 3600;
  const metrics = new Map(monitor.metrics.map((metric) => [metric.timestamp, metric]));
  return (
    <article className="monitor-card">
      <div className="monitor-heading">
        <div className="monitor-heading-main">
          <ServiceIcon name={monitor.name} url={monitor.url} />
          <div>
            <h2>{monitor.name}</h2>
            <p>{safeHost(monitor.url)}</p>
          </div>
        </div>
        <StatusBadge status={monitor.status} />
      </div>
      <div className="pulse-strip" aria-label="Last 24 hours of hourly results">
        {Array.from({ length: 24 }, (_, index) => {
          const hour = latestHour - (23 - index) * 3600;
          const metric = metrics.get(hour);
          const ratio = metric && metric.checks > 0 ? metric.successes / metric.checks : null;
          const tone = ratio === null ? "empty" : ratio === 1 ? "good" : ratio >= 0.8 ? "warn" : "bad";
          const label = `${formatTime(hour)}: ${ratio === null ? "No checks recorded" : `${metric!.checks - metric!.successes} of ${metric!.checks} checks failed`}. View details`;
          return <button type="button" className={tone} key={hour} title={label} aria-label={label} onClick={() => setSelection({ monitorId: monitor.id, hour, pageSlug: pageSlug ?? undefined })} />;
        })}
      </div>
      <div className="strip-caption"><span>23 hours ago</span><span>Each block is 1 hour · Click for details</span><span>Current hour</span></div>
      <div className="strip-legend"><span><i className="good" />All passed</span><span><i className="warn" />{"80–<100% passed"}</span><span><i className="bad" />Below 80% passed</span><span><i className="empty" />No checks</span></div>
      <div className="monitor-stats">
        <span><strong>{formatUptime(monitor.uptime30d)}</strong> 30-day uptime</span>
        <span><strong>{monitor.lastLatencyMs === null ? "—" : `${monitor.lastLatencyMs} ms`}</strong> response</span>
        <span><strong>{monitor.lastCheckedAt ? relativeTime(monitor.lastCheckedAt) : "Never"}</strong> last check</span>
      </div>
      {monitor.lastError && monitor.status !== "up" && <p className="monitor-error">{monitor.lastError}</p>}
      {selection && <CheckDetailsDialog selection={selection} token={sessionStorage.getItem("pulse-admin-token") ?? undefined} onClose={() => setSelection(null)} />}
    </article>
  );
}

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState(() => sessionStorage.getItem("pulse-admin-token") ?? "");
  const [authorized, setAuthorized] = useState(false);
  const [monitors, setMonitors] = useState<AdminMonitor[]>([]);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [pages, setPages] = useState<StatusPage[]>([]);
  const [settings, setSettings] = useState<SiteSettings>({ homepageShowAll: true });
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const [editing, setEditing] = useState<AdminMonitor | "new" | null>(null);
  const [editingPage, setEditingPage] = useState<StatusPage | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...options?.headers,
      },
    });
    const body = response.status === 204 ? null : await response.json() as { error?: string };
    if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
    return body as T;
  }, [token]);

  const loadAdmin = useCallback(async () => {
    try {
      const [monitorData, incidentData, logData, pageData, settingsData] = await Promise.all([
        request<{ monitors: AdminMonitor[] }>("/api/admin/monitors"),
        request<{ incidents: IncidentSummary[] }>("/api/admin/incidents"),
        request<{ logs: AuditLogEntry[] }>("/api/admin/logs"),
        request<{ pages: StatusPage[] }>("/api/admin/pages"),
        request<{ settings: SiteSettings }>("/api/admin/settings"),
      ]);
      sessionStorage.setItem("pulse-admin-token", token);
      setMonitors(monitorData.monitors);
      setIncidents(incidentData.incidents);
      setLogs(logData.logs);
      setPages(pageData.pages);
      setSettings(settingsData.settings);
      setAuthorized(true);
      setMessage(null);
    } catch (caught) {
      setAuthorized(false);
      setMessage(caught instanceof Error ? caught.message : "Could not sign in.");
    }
  }, [request, token]);

  useEffect(() => {
    if (token) void loadAdmin();
  }, []); // Restore an existing session token once on mount.

  async function act(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await loadAdmin();
      return true;
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!authorized) {
    return (
      <main className="shell admin-shell">
        <header className="topbar"><button className="brand plain-button" onClick={onClose}><span className="brand-mark"><span /></span>Uptime Pulse</button></header>
        <section className="login-card">
          <p className="eyebrow">Private area</p>
          <h1>Manage monitors</h1>
          <p>Your token stays in this browser tab and is sent only to this Worker.</p>
          <form onSubmit={(event) => { event.preventDefault(); void loadAdmin(); }}>
            <label>Admin token<input type="password" value={token} autoFocus autoComplete="current-password" onChange={(event) => setToken(event.target.value)} /></label>
            <button className="primary-button" type="submit">Continue</button>
          </form>
          {message && <div className="notice error">{message}</div>}
          <button className="text-button back-button" onClick={onClose}>← Public status</button>
        </section>
        <SiteFooter />
      </main>
    );
  }

  return (
    <main className="shell admin-shell">
      <header className="topbar">
        <button className="brand plain-button" onClick={onClose}><span className="brand-mark"><span /></span>Uptime Pulse - Admin</button>
        <div className="header-actions">
          <button className="secondary-button" disabled={busy} onClick={() => void act(() => request("/api/admin/smtp/test", { method: "POST" }), "Test email sent.")}>Test Email</button>
          <button className="primary-button" onClick={() => setEditing("new")}>Add monitor</button>
        </div>
      </header>

      <section className="admin-title"><p className="eyebrow">Dashboard</p><h1>Monitors</h1><p>{monitors.length} of 20 free-plan slots used</p></section>
      {message && <div className="notice">{message}</div>}
      <section className="admin-list">
        {monitors.map((monitor) => (
          <article className="admin-row" key={monitor.id}>
            <div className="row-status"><ServiceIcon name={monitor.name} url={monitor.url} compact /><span className={`status-dot ${statusTone(monitor.status)}`} /><div><strong>{monitor.name}{settings.homepageShowAll && monitor.showOnHomepage && <small className="row-tag">Homepage</small>}{monitor.pageCount > 0 && <small className="row-tag">{monitor.pageCount} page{monitor.pageCount === 1 ? "" : "s"}</small>}</strong><span>{monitor.url}</span></div></div>
            <StatusBadge status={monitor.status} />
            <span className="hide-mobile">Every {monitor.intervalSeconds === 60 ? "minute" : `${monitor.intervalSeconds / 60} min`}</span>
            <div className="row-actions">
              <button className="icon-button" onClick={() => setSelection({ monitorId: monitor.id, hour: Math.floor(Date.now() / 3_600_000) * 3600 })}>History</button>
              <button className="icon-button" disabled={busy} title="Check now" onClick={() => void act(() => request(`/api/admin/monitors/${monitor.id}/check`, { method: "POST" }), `Checked ${monitor.name}.`)}>↻</button>
              <button className="icon-button" title="Edit" onClick={() => setEditing(monitor)}>Edit</button>
              <button className="icon-button danger" disabled={busy} title="Delete" onClick={() => {
                if (confirm(`Delete ${monitor.name} and its history?`)) void act(() => request(`/api/admin/monitors/${monitor.id}`, { method: "DELETE" }), `${monitor.name} deleted.`);
              }}>Delete</button>
            </div>
          </article>
        ))}
        {monitors.length === 0 && <div className="empty-state"><h2>Add your first service</h2><p>The scheduler will pick it up on the next minute.</p></div>}
      </section>

      <SharingSection
        settings={settings}
        pages={pages}
        monitors={monitors}
        busy={busy}
        onToggleHomepage={(homepageShowAll) => void act(
          () => request("/api/admin/settings", { method: "PUT", body: JSON.stringify({ homepageShowAll }) }),
          homepageShowAll ? "Homepage now shows selected monitors." : "Homepage now hides all monitors.",
        )}
        onAdd={() => setEditingPage("new")}
        onEdit={setEditingPage}
        onDelete={(page) => {
          if (confirm(`Delete "${page.title}"? Its link will stop working.`)) void act(() => request(`/api/admin/pages/${page.id}`, { method: "DELETE" }), `${page.title} deleted.`);
        }}
      />

      <section className="admin-columns">
        <div><h2>Recent incidents</h2><div className="activity-card">{incidents.slice(0, 8).map((incident) => <button type="button" className="activity-row incident-button" key={incident.id} onClick={() => setSelection({ incidentId: incident.id })}><span className={`status-dot ${incident.resolvedAt ? "up" : "down"}`} /><div><strong>{incident.monitorName}</strong><span>{incident.resolvedAt ? `Recovered ${relativeTime(incident.resolvedAt)}` : `Started ${relativeTime(incident.startedAt)}`}</span><span>View details →</span></div></button>)}{incidents.length === 0 && <p className="muted">No incidents recorded.</p>}</div></div>
        <div><h2>Admin activity</h2><div className="activity-card">{logs.slice(0, 8).map((log) => <div className="activity-row" key={log.id}><span className="activity-mark" /><div><strong>{humanAction(log.action)}</strong><span>{relativeTime(log.createdAt)}</span></div></div>)}{logs.length === 0 && <p className="muted">No activity recorded.</p>}</div></div>
      </section>

      <SiteFooter />

      {selection && <CheckDetailsDialog selection={selection} token={token} onClose={() => setSelection(null)} />}
      {editingPage && <StatusPageDialog page={editingPage === "new" ? null : editingPage} monitors={monitors} busy={busy} onClose={() => setEditingPage(null)} onSave={(input) => void (async () => {
        const saved = await act(
          () => request(editingPage === "new" ? "/api/admin/pages" : `/api/admin/pages/${editingPage.id}`, { method: editingPage === "new" ? "POST" : "PUT", body: JSON.stringify(input) }),
          editingPage === "new" ? "Status page created." : "Status page updated.",
        );
        if (saved) setEditingPage(null);
      })()} />}
      {editing && <MonitorDialog monitor={editing === "new" ? null : editing} busy={busy} onClose={() => setEditing(null)} onSave={(input) => void (async () => {
        const saved = await act(
          () => request(editing === "new" ? "/api/admin/monitors" : `/api/admin/monitors/${editing.id}`, { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(input) }),
          editing === "new" ? "Monitor added." : "Monitor updated.",
        );
        if (saved) setEditing(null);
      })()} />}
    </main>
  );
}

function SiteFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="site-footer">
      {children && <p>{children}</p>}
      <p>
        Built with <span className="footer-heart" aria-label="love">❤️</span> by{" "}
        <a href="https://github.com/wilspi/uptime-pulse" target="_blank" rel="noreferrer">@wilspi</a>
      </p>
    </footer>
  );
}

function ServiceIcon({ name, url, compact = false }: { name: string; url: string; compact?: boolean }) {
  const favicon = faviconUrl(url);
  return (
    <span className={`service-icon${compact ? " compact" : ""}`} aria-hidden="true">
      <span>{name.trim().charAt(0).toUpperCase() || "•"}</span>
      {favicon && (
        <img
          src={favicon}
          alt=""
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          referrerPolicy="no-referrer"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}

function MonitorDialog({ monitor, busy, onClose, onSave }: { monitor: AdminMonitor | null; busy: boolean; onClose: () => void; onSave: (input: MonitorInput) => void }) {
  const [form, setForm] = useState<MonitorInput>(monitor ?? emptyMonitor);
  const field = <K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  function submit(event: FormEvent) { event.preventDefault(); onSave({ ...form, expectedKeyword: form.expectedKeyword || null }); }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="monitor-dialog-title">
        <div className="modal-title"><div><p className="eyebrow">Configuration</p><h2 id="monitor-dialog-title">{monitor ? "Edit monitor" : "New monitor"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label>Display name<input required maxLength={80} value={form.name} onChange={(e) => field("name", e.target.value)} placeholder="API" /></label>
            <label className="wide">URL<input required type="url" value={form.url} onChange={(e) => field("url", e.target.value)} placeholder="https://api.example.com/health" /></label>
            <label>Method<select value={form.method} onChange={(e) => field("method", e.target.value as "GET" | "HEAD")}><option>GET</option><option>HEAD</option></select></label>
            <label>Interval<select value={form.intervalSeconds} onChange={(e) => field("intervalSeconds", Number(e.target.value) as 60 | 300 | 900)}><option value="60">1 minute</option><option value="300">5 minutes</option><option value="900">15 minutes</option></select></label>
            <label>Minimum status<input type="number" min="100" max="599" value={form.expectedStatusMin} onChange={(e) => field("expectedStatusMin", Number(e.target.value))} /></label>
            <label>Maximum status<input type="number" min="100" max="599" value={form.expectedStatusMax} onChange={(e) => field("expectedStatusMax", Number(e.target.value))} /></label>
            <label>Timeout (ms)<input type="number" min="1000" max="30000" step="1000" value={form.timeoutMs} onChange={(e) => field("timeoutMs", Number(e.target.value))} /></label>
            <label className="wide">Expected text <span>(optional, GET only)</span><input maxLength={200} value={form.expectedKeyword ?? ""} onChange={(e) => field("expectedKeyword", e.target.value || null)} placeholder="healthy" /></label>
          </div>
          <div className="check-row"><label title="Each redirect hop makes another HTTP request. Save the final URL to avoid the extra request."><input type="checkbox" checked={form.followRedirects} onChange={(e) => field("followRedirects", e.target.checked)} /> Follow redirects (one request per hop)</label><label><input type="checkbox" checked={form.paused} onChange={(e) => field("paused", e.target.checked)} /> Paused</label><label title="Status pages are managed separately under Sharing."><input type="checkbox" checked={form.showOnHomepage} onChange={(e) => field("showOnHomepage", e.target.checked)} /> Show on homepage</label></div>
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save monitor"}</button></div>
        </form>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: MonitorStatus }) { return <span className={`status-badge ${statusTone(status)}`}><span />{statusLabel(status)}</span>; }
function statusTone(status: MonitorStatus): string { return status === "up" ? "up" : status === "down" ? "down" : status === "verifying" || status === "recovering" ? "warning" : "neutral"; }
function statusLabel(status: MonitorStatus): string { return status.charAt(0).toUpperCase() + status.slice(1); }
function overallMessage(status?: MonitorStatus): string { if (status === "up") return "All systems operational"; if (status === "down") return "Some systems are unavailable"; if (status === "verifying" || status === "recovering") return "We’re verifying service health"; if (status === "paused") return "Monitoring is paused"; return "Waiting for first checks"; }
function formatUptime(value: number | null): string { return value === null ? "—" : `${value.toFixed(value >= 99 ? 3 : 2)}%`; }
function safeHost(value: string): string { try { return new URL(value).host; } catch { return value; } }
function faviconUrl(value: string): string | null { try { return `${new URL(value).origin}/favicon.ico`; } catch { return null; } }
function humanAction(value: string): string { return value.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" · "); }
function relativeTime(timestamp: number): string { const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp); if (seconds < 60) return "just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86_400)}d ago`; }
