import type { SiteSettings, StatusPage, StatusPageInput } from "../shared/types";
import { ValidationError } from "./monitoring/validation";

interface PageRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface PageMonitorRow {
  page_id: string;
  monitor_id: string;
  display_name: string | null;
}

export class ConflictError extends Error {}

export async function listStatusPages(env: Env): Promise<StatusPage[]> {
  const [pages, monitors] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM status_pages ORDER BY created_at ASC"),
    env.DB.prepare(
      "SELECT page_id, monitor_id, display_name FROM status_page_monitors ORDER BY position ASC",
    ),
  ]);
  const monitorRows = monitors.results as PageMonitorRow[];
  return (pages.results as PageRow[]).map((row) => mapPage(row, monitorRows));
}

export async function getStatusPage(env: Env, id: string): Promise<StatusPage | null> {
  const [pages, monitors] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM status_pages WHERE id = ?1").bind(id),
    env.DB.prepare(
      `SELECT page_id, monitor_id, display_name FROM status_page_monitors
        WHERE page_id = ?1 ORDER BY position ASC`,
    ).bind(id),
  ]);
  const row = (pages.results as PageRow[])[0];
  return row ? mapPage(row, monitors.results as PageMonitorRow[]) : null;
}

/** Statements that write a page and replace its monitor list. Throws if the input is inconsistent. */
export async function savePageStatements(
  env: Env,
  id: string,
  input: StatusPageInput,
  now: number,
  isNew: boolean,
): Promise<D1PreparedStatement[]> {
  const [slugOwner, knownMonitors] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM status_pages WHERE slug = ?1 AND id != ?2").bind(input.slug, id),
    env.DB.prepare("SELECT COUNT(*) AS total FROM monitors WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(input.monitors.map((monitor) => monitor.monitorId))),
  ]);
  if (slugOwner.results.length > 0) {
    throw new ConflictError("Another status page already uses that link.");
  }
  if ((knownMonitors.results as { total: number }[])[0]?.total !== input.monitors.length) {
    throw new ValidationError("One or more selected monitors no longer exist.");
  }

  return [
    isNew
      ? env.DB.prepare(
          `INSERT INTO status_pages (id, slug, title, description, enabled, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
        ).bind(id, input.slug, input.title, input.description, input.enabled ? 1 : 0, now)
      : env.DB.prepare(
          `UPDATE status_pages
              SET slug = ?2, title = ?3, description = ?4, enabled = ?5, updated_at = ?6
            WHERE id = ?1`,
        ).bind(id, input.slug, input.title, input.description, input.enabled ? 1 : 0, now),
    env.DB.prepare("DELETE FROM status_page_monitors WHERE page_id = ?1").bind(id),
    ...input.monitors.map((monitor, position) =>
      env.DB.prepare(
        `INSERT INTO status_page_monitors (page_id, monitor_id, display_name, position)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(id, monitor.monitorId, monitor.displayName, position),
    ),
  ];
}

/** An enabled page by its link; disabled and unknown pages look identical to callers. */
export async function findEnabledPage(env: Env, slug: string): Promise<PageRow | null> {
  return env.DB.prepare("SELECT * FROM status_pages WHERE slug = ?1 AND enabled = 1")
    .bind(slug.toLowerCase())
    .first<PageRow>();
}

/** The name a page shows for a monitor, or null when the monitor is not on that page. */
export async function pageMonitorName(env: Env, pageId: string, monitorId: string): Promise<string | null> {
  return env.DB.prepare(
    `SELECT COALESCE(pm.display_name, m.name) AS name
       FROM status_page_monitors pm
       JOIN monitors m ON m.id = pm.monitor_id
      WHERE pm.page_id = ?1 AND pm.monitor_id = ?2`,
  )
    .bind(pageId, monitorId)
    .first<string>("name");
}

export async function getSiteSettings(env: Env): Promise<SiteSettings> {
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key = 'homepage_show_all'")
    .first<string>("value");
  return { homepageShowAll: value === "1" };
}

export function saveSiteSettingsStatement(env: Env, settings: SiteSettings): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('homepage_show_all', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(settings.homepageShowAll ? "1" : "0");
}

function mapPage(row: PageRow, monitors: PageMonitorRow[]): StatusPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    enabled: row.enabled === 1,
    monitors: monitors
      .filter((monitor) => monitor.page_id === row.id)
      .map((monitor) => ({ monitorId: monitor.monitor_id, displayName: monitor.display_name })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
