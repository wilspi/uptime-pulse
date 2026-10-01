import { FormEvent, useState } from "react";
import type { AdminMonitor, SiteSettings, StatusPage, StatusPageInput } from "../shared/types";

const SHORT_SLUG_LENGTH = 10;
const emptyPage: StatusPageInput = { slug: "", title: "", description: null, enabled: true, monitors: [] };

export function pageUrl(slug: string): string {
  return `${location.origin}/s/${slug}`;
}

export function SharingSection({ settings, pages, monitors, busy, onToggleHomepage, onAdd, onEdit, onDelete }: {
  settings: SiteSettings;
  pages: StatusPage[];
  monitors: AdminMonitor[];
  busy: boolean;
  onToggleHomepage: (value: boolean) => void;
  onAdd: () => void;
  onEdit: (page: StatusPage) => void;
  onDelete: (page: StatusPage) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const homepageCount = monitors.filter((monitor) => monitor.showOnHomepage).length;

  async function copy(page: StatusPage) {
    await navigator.clipboard.writeText(pageUrl(page.slug));
    setCopied(page.id);
    window.setTimeout(() => setCopied((current) => (current === page.id ? null : current)), 1500);
  }

  return (
    <section className="sharing-section">
      <div className="section-heading"><div><h2>Sharing</h2><p className="muted">Choose what the public homepage shows, and share separate pages with each audience.</p></div><button className="primary-button" onClick={onAdd}>Add status page</button></div>

      <label className="toggle-row">
        <input type="checkbox" role="switch" checked={settings.homepageShowAll} disabled={busy} onChange={(event) => onToggleHomepage(event.target.checked)} />
        <span className="toggle-copy">
          <strong>Show monitors on homepage</strong>
          <span>{settings.homepageShowAll
            ? `${homepageCount} of ${monitors.length} monitors are visible at ${location.origin}. Choose which in each monitor's settings.`
            : "The homepage shows no monitors. Only people with a status page link can see services."}</span>
        </span>
      </label>

      <div className="admin-list">
        {pages.map((page) => (
          <article className="admin-row page-row" key={page.id}>
            <div className="row-status"><span className={`status-dot ${page.enabled ? "up" : "neutral"}`} /><div><strong>{page.title}</strong><span>{pageUrl(page.slug)}</span></div></div>
            <span className={`status-badge ${page.enabled ? "up" : "neutral"}`}><span />{page.enabled ? "Shared" : "Disabled"}</span>
            <span className="hide-mobile">{page.monitors.length} monitor{page.monitors.length === 1 ? "" : "s"}</span>
            <div className="row-actions">
              <button className="icon-button" disabled={!page.enabled} onClick={() => void copy(page)}>{copied === page.id ? "Copied" : "Copy link"}</button>
              <a className="icon-button" href={pageUrl(page.slug)} target="_blank" rel="noreferrer">Open</a>
              <button className="icon-button" onClick={() => onEdit(page)}>Edit</button>
              <button className="icon-button danger" disabled={busy} onClick={() => onDelete(page)}>Delete</button>
            </div>
          </article>
        ))}
        {pages.length === 0 && <div className="empty-state"><h2>No status pages yet</h2><p>Create a page for each audience with only the services they should see.</p></div>}
      </div>
    </section>
  );
}

export function StatusPageDialog({ page, monitors, busy, onClose, onSave }: {
  page: StatusPage | null;
  monitors: AdminMonitor[];
  busy: boolean;
  onClose: () => void;
  onSave: (input: StatusPageInput) => void;
}) {
  const [form, setForm] = useState<StatusPageInput>(page ?? emptyPage);
  const [suffix, setSuffix] = useState<string | null>(null);
  const selected = new Map(form.monitors.map((monitor) => [monitor.monitorId, monitor]));
  const slugChanged = page !== null && form.slug !== page.slug;

  function field<K extends keyof StatusPageInput>(key: K, value: StatusPageInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleMonitor(monitorId: string, checked: boolean) {
    // Keep the page in the same order as the monitor list.
    const next = monitors
      .filter((monitor) => (monitor.id === monitorId ? checked : selected.has(monitor.id)))
      .map((monitor) => selected.get(monitor.id) ?? { monitorId: monitor.id, displayName: null });
    field("monitors", next);
  }

  function rename(monitorId: string, displayName: string) {
    field("monitors", form.monitors.map((monitor) => monitor.monitorId === monitorId ? { ...monitor, displayName: displayName || null } : monitor));
  }

  function generateSlug() {
    // Replace a previously generated suffix rather than stacking another one.
    const base = suffix && form.slug.endsWith(`-${suffix}`) ? form.slug.slice(0, -suffix.length - 1) : form.slug.replace(/-+$/, "");
    const next = randomToken(8);
    setSuffix(base ? next : null);
    field("slug", base ? `${base}-${next}` : randomToken(12));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ ...form, description: form.description?.trim() || null });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="page-dialog-title">
        <div className="modal-title"><div><p className="eyebrow">Sharing</p><h2 id="page-dialog-title">{page ? "Edit status page" : "New status page"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="wide">Title<input required maxLength={80} value={form.title} onChange={(e) => field("title", e.target.value)} placeholder="Acme services" /></label>
            <label className="wide">Link
              <div className="slug-field">
                <span>/s/</span>
                <input required minLength={3} maxLength={64} value={form.slug} onChange={(e) => field("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="acme" />
                <button className="secondary-button" type="button" onClick={generateSlug} title="Add random characters so the link cannot be guessed">Generate</button>
              </div>
              {form.slug.length > 0 && form.slug.length < SHORT_SLUG_LENGTH && <span className="field-hint warn">Short links are easy to guess. Use Generate to add random characters.</span>}
              {slugChanged && <span className="field-hint warn">Saving stops the old link from working immediately.</span>}
            </label>
            <label className="wide">Description <span>(optional)</span><input maxLength={280} value={form.description ?? ""} onChange={(e) => field("description", e.target.value || null)} placeholder="Live status of the services we run for you." /></label>
          </div>

          <h3 className="dialog-subheading">Monitors on this page</h3>
          <p className="muted field-note">Display names replace your internal names on this page only. The service's domain is still shown.</p>
          <div className="page-monitor-list">
            {monitors.map((monitor) => {
              const entry = selected.get(monitor.id);
              return (
                <div className="page-monitor" key={monitor.id}>
                  <label className="inline-check"><input type="checkbox" checked={Boolean(entry)} onChange={(e) => toggleMonitor(monitor.id, e.target.checked)} />{monitor.name}</label>
                  <input aria-label={`Display name for ${monitor.name}`} disabled={!entry} maxLength={80} value={entry?.displayName ?? ""} onChange={(e) => rename(monitor.id, e.target.value)} placeholder={monitor.name} />
                </div>
              );
            })}
            {monitors.length === 0 && <p className="muted">Add a monitor first.</p>}
          </div>

          <div className="check-row"><label><input type="checkbox" checked={form.enabled} onChange={(e) => field("enabled", e.target.checked)} /> Page is shared (turn off to disable the link)</label></div>
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save page"}</button></div>
        </form>
      </section>
    </div>
  );
}

function randomToken(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join("");
}
