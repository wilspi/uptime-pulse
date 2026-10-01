import { useEffect, useRef, useState } from "react";
import type { CheckDetailsResponse, FailureRun, IncidentDetail } from "../shared/types";

export type DetailSelection = { monitorId: string; hour: number; pageSlug?: string } | { incidentId: string };

const RETENTION_HOURS = 90 * 24;

export function CheckDetailsDialog({ selection, token, onClose }: {
  selection: DetailSelection; token?: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<CheckDetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hour, setHour] = useState("hour" in selection ? selection.hour : null);
  const [revision, setRevision] = useState(0);
  const [privateDetails, setPrivateDetails] = useState(Boolean(token));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (trigger instanceof HTMLElement) trigger.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      const path = "incidentId" in selection
        ? `/api/admin/incidents/${encodeURIComponent(selection.incidentId)}`
        : privateDetails
          ? `/api/admin/monitors/${encodeURIComponent(selection.monitorId)}/checks?hour=${hour}`
          : selection.pageSlug
            ? `/api/pages/${encodeURIComponent(selection.pageSlug)}/monitors/${encodeURIComponent(selection.monitorId)}/checks?hour=${hour}`
            : `/api/status/monitors/${encodeURIComponent(selection.monitorId)}/checks?hour=${hour}`;
      try {
        const response = await fetch(path, {
          signal: controller.signal,
          headers: privateDetails && token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (response.status === 401 && "monitorId" in selection) { setPrivateDetails(false); return; }
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to view incident diagnostics." : "Could not load check details. Please retry.");
        const details = await response.json() as CheckDetailsResponse;
        if (!controller.signal.aborted) setData(details);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not load details.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [selection, token, privateDetails, hour, revision]);

  function changeHour(next: number) { setHour(next); setData(null); }
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3600;
  return (
    <dialog className="modal detail-dialog" ref={dialog} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }} aria-labelledby="details-title">
      <div className="modal-title"><div><p className="eyebrow">{hour === null ? "Incident details" : "Hourly check details"}</p><h2 id="details-title">{data?.monitorName ?? "Check history"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close check details" autoFocus>✕</button></div>
      {hour !== null && <div className="detail-navigation"><button className="secondary-button" disabled={hour <= currentHour - (RETENTION_HOURS - 1) * 3600} onClick={() => changeHour(hour - 3600)}>← Previous hour</button><button className="secondary-button" disabled={hour >= currentHour} onClick={() => changeHour(hour + 3600)}>Next hour →</button></div>}
      {loading && <p role="status" className="muted">Loading check details…</p>}
      {error && <div className="notice error" role="alert">{error} <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry</button></div>}
      {data && !loading && !error && <>
        <p className="detail-period">{formatTime(data.from)} — {formatTime(Math.min(data.to, data.generatedAt) - 1)}{hour === currentHour ? " · In progress" : ""} <span className="muted">· {Intl.DateTimeFormat().resolvedOptions().timeZone} time</span></p>
        {hour !== null && <Verdict data={data} />}
        <div className="detail-stats">
          {data.totalChecks !== null && <div><strong>{data.totalChecks}</strong><span>Checks</span></div>}
          <div><strong>{data.failedChecks}</strong><span>Failed</span></div>
          <div><strong>{data.downtimeSeconds ? duration(data.downtimeSeconds) : "None"}</strong><span>Confirmed downtime</span></div>
          {data.latency && <div><strong>{data.latency.averageMs === null ? "—" : `${data.latency.averageMs} ms`}</strong><span>{data.latency.minMs === null ? "Avg. response" : `Avg. response (${data.latency.minMs}–${data.latency.maxMs} ms)`}</span></div>}
        </div>
        <p className="muted">Counts represent monitoring checks, including manual checks, rather than visitor requests.</p>

        <section className="detail-section"><div className="detail-section-title"><h3>What happened</h3><button className="text-button" onClick={() => setRevision((value) => value + 1)}>Refresh</button></div>
          {data.runs.length === 0 && <p className="muted">{data.failedChecks > 0 ? "Failure details were not recorded for this period. They are kept for 90 days, starting from when diagnostics were enabled." : "No failed checks in this period."}</p>}
          {data.runs.length > 0 && <ol className="run-list">{[...data.runs].reverse().map((run) => <RunItem key={run.id} run={run} from={data.from} privateDetails={privateDetails} />)}</ol>}
          {data.runsTruncated && <p className="muted">Showing the 100 most recent failure runs.</p>}
          {!privateDetails && !("pageSlug" in selection && selection.pageSlug) && data.runs.length > 0 && <p className="muted">Sign in through Manage, then reopen a block to see raw errors and response excerpts.</p>}
        </section>

        <section className="detail-section"><h3>{hour === null ? "Incident" : "Confirmed incidents"}</h3>
          {data.incidents.map((incident) => <IncidentItem key={incident.id} incident={incident} now={data.generatedAt} />)}
          {data.incidents.length === 0 && <p className="muted">No confirmed incident overlaps this hour. An incident opens after 3 consecutive failures and resolves after 2 consecutive successes.</p>}
        </section>

        {data.configChanges && data.configChanges.length > 0 && <section className="detail-section"><h3>Monitor changes in this period</h3>
          <ul className="failure-list">{data.configChanges.map((change) => <li key={`${change.createdAt}-${change.action}`}><span>{humanChange(change.action)}{change.details ? ` · ${change.details}` : ""}</span><strong>{formatClock(change.createdAt)}</strong></li>)}</ul>
        </section>}
      </>}
    </dialog>
  );
}

function Verdict({ data }: { data: CheckDetailsResponse }) {
  const total = data.totalChecks ?? 0;
  const ratio = total ? (data.successfulChecks ?? 0) / total : null;
  if (ratio === null) return <div className="notice"><strong>Gray block: </strong>No checks were recorded in this hour. This does not establish whether the service was up or down.</div>;
  if (ratio === 1) return <div className="notice"><strong>Green block: </strong>All {total} checks passed.</div>;
  const color = ratio >= 0.8 ? "Yellow" : "Red";
  const rule = color === "Yellow" ? "Yellow means at least 80%, but fewer than 100%, passed." : "Red means fewer than 80% passed.";
  const cause = data.downtimeSeconds > 0
    ? `The service was confirmed down for ${duration(data.downtimeSeconds)} of this hour.`
    : "No outage was confirmed, so these were brief or intermittent failures (an outage needs 3 consecutive failures).";
  return <div className={`notice ${color === "Red" ? "error" : ""}`}><strong>{color} block: </strong>{data.failedChecks} of {total} checks failed ({(ratio * 100).toFixed(1)}% passed). {rule} {cause}</div>;
}

function RunItem({ run, from, privateDetails }: { run: FailureRun; from: number; privateDetails: boolean }) {
  const span = run.startedAt === run.endedAt ? formatClock(run.startedAt) : `${formatClock(run.startedAt)} – ${formatClock(run.endedAt)}`;
  const outcome = run.outcome === "passed" ? `Passing again at ${formatClock(run.passedAt!)}`
    : run.outcome === "changed" ? "Followed by a different failure"
    : "No passing check since";
  return (
    <li>
      <details className="check-detail">
        <summary>
          <span className="check-fail">{run.failedChecks} failed</span>
          <span>{span}{run.startedAt < from ? " (began earlier)" : ""}</span>
          <span>{run.error ?? run.reason}</span>
          <span className={run.outcome === "passed" ? "check-pass" : "muted"}>{outcome}</span>
        </summary>
        <div className="check-diagnostics">
          <p>{run.reason} · avg. {run.averageLatencyMs} ms, slowest {run.maxLatencyMs} ms{run.startedAt < from ? " · counts cover the whole run" : ""}</p>
          {run.expectedStatusMin !== undefined && <p>Expected HTTP {run.expectedStatusMin}–{run.expectedStatusMax} · Timeout {run.timeoutMs} ms</p>}
          {privateDetails && <><h4>Response headers (first failure)</h4>{Object.keys(run.responseHeaders ?? {}).length ? <pre>{Object.entries(run.responseHeaders ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n")}</pre> : <p className="muted">No diagnostic headers captured.</p>}
            <h4>Response excerpt (first failure)</h4>{run.responseBody ? <><pre>{run.responseBody}</pre><p className="muted">Up to 2 KiB of text; the response may be longer.</p></> : <p className="muted">{run.httpStatus === null ? "No HTTP response was received." : "No text excerpt captured (empty, non-text, HEAD response, or body unavailable)."}</p>}</>}
        </div>
      </details>
    </li>
  );
}

function IncidentItem({ incident, now }: { incident: IncidentDetail; now: number }) {
  return (
    <div className="incident-detail">
      <strong>{incident.resolvedAt === null ? "Ongoing" : "Recovered"} · down {duration((incident.resolvedAt ?? now) - incident.startedAt)}</strong>
      <p>First failure {formatTime(incident.startedAt)}</p>
      <p>Confirmed down {formatTime(incident.confirmedAt)} ({duration(incident.confirmedAt - incident.startedAt)} later)</p>
      <p>{incident.resolvedAt === null ? "Recovery has not yet been confirmed." : `Recovery confirmed ${formatTime(incident.resolvedAt)}`}</p>
      {incident.initialError && <p>Initial failure: {incident.initialError}</p>}
      {incident.lastError && incident.lastError !== incident.initialError && <p>Last failure: {incident.lastError}</p>}
      {incident.alerts?.map((alert) => <p key={alert.kind} className={alert.status === "failed" ? "check-fail" : undefined}>
        {alert.kind === "down" ? "Down alert" : "Recovery alert"}: {alert.status === "sent" && alert.sentAt ? `emailed ${formatTime(alert.sentAt)}` : alert.status === "failed" ? `failed after ${alert.attempts} attempts${alert.error ? ` (${alert.error})` : ""}` : "pending"}
      </p>)}
    </div>
  );
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function formatClock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString(undefined, { timeStyle: "short" });
}

function humanChange(action: string): string {
  return ({
    "monitor.created": "Monitor created",
    "monitor.updated": "Settings changed",
    "monitor.checked_manually": "Manual check",
  } as Record<string, string>)[action] ?? action;
}

function duration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m` : `${Math.max(0, seconds)}s`;
}
