/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./api";
import type { AdminMonitor, PublicStatusResponse, StatusPage, StatusPageInput } from "../shared/types";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const adminHeaders = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };
const hour = Math.floor(Date.now() / 3_600_000) * 3600;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(path, init, testEnv));
}

async function admin<T>(path: string, method: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await call(path, { method, headers: adminHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: response.status === 204 ? (null as T) : await response.json() as T };
}

async function createMonitor(name: string, showOnHomepage: boolean): Promise<AdminMonitor> {
  const { body } = await admin<{ monitor: AdminMonitor }>("/api/admin/monitors", "POST", {
    name, url: `https://${name.toLowerCase()}.example.com/health`, showOnHomepage,
  });
  return body.monitor;
}

async function setHomepage(homepageShowAll: boolean): Promise<void> {
  expect((await admin("/api/admin/settings", "PUT", { homepageShowAll })).status).toBe(200);
}

async function publicStatus(path = "/api/status"): Promise<PublicStatusResponse> {
  const response = await call(path);
  expect(response.status).toBe(200);
  return response.json();
}

function pageInput(overrides: Partial<StatusPageInput> = {}): StatusPageInput {
  return { slug: "acme-x7k2p9qa", title: "Acme services", description: "For Acme", enabled: true, monitors: [], ...overrides };
}

let billing: AdminMonitor;
let internal: AdminMonitor;

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM status_pages"),
    testEnv.DB.prepare("DELETE FROM monitors"),
  ]);
  await setHomepage(true);
  billing = await createMonitor("Billing", true);
  internal = await createMonitor("Internal", false);
});

describe("homepage visibility", () => {
  it("lists only monitors marked for the homepage, and new monitors default to hidden", async () => {
    const created = await createMonitor("Default", false);
    expect(created.showOnHomepage).toBe(false);
    const status = await publicStatus();
    expect(status.listed).toBe(true);
    expect(status.monitors.map((monitor) => monitor.name)).toEqual(["Billing"]);
    expect((await call(`/api/status/monitors/${internal.id}/checks?hour=${hour}`)).status).toBe(404);
    expect((await call(`/api/status/monitors/${billing.id}/checks?hour=${hour}`)).status).toBe(200);
  });

  it("hides every monitor and its details when the homepage toggle is off", async () => {
    await setHomepage(false);
    const status = await publicStatus();
    expect(status).toMatchObject({ listed: false, monitors: [] });
    expect((await call(`/api/status/monitors/${billing.id}/checks?hour=${hour}`)).status).toBe(404);
  });
});

describe("status pages", () => {
  it("shows only the page's monitors under their display names", async () => {
    const { status, body } = await admin<{ page: StatusPage }>("/api/admin/pages", "POST", pageInput({
      monitors: [{ monitorId: internal.id, displayName: "Payments" }],
    }));
    expect(status).toBe(201);
    expect(body.page.monitors).toEqual([{ monitorId: internal.id, displayName: "Payments" }]);

    const response = await call("/api/pages/acme-x7k2p9qa");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const page = await response.json() as PublicStatusResponse;
    expect(page).toMatchObject({ siteName: "Acme services", description: "For Acme", listed: true });
    expect(page.monitors.map((monitor) => monitor.name)).toEqual(["Payments"]);
    expect(JSON.stringify(page)).not.toContain("Billing");

    const details = await call(`/api/pages/acme-x7k2p9qa/monitors/${internal.id}/checks?hour=${hour}`);
    expect(await details.json()).toMatchObject({ monitorName: "Payments" });
    expect((await call(`/api/pages/acme-x7k2p9qa/monitors/${billing.id}/checks?hour=${hour}`)).status).toBe(404);
  });

  it("stops serving disabled pages and old links", async () => {
    const { body } = await admin<{ page: StatusPage }>("/api/admin/pages", "POST", pageInput({ monitors: [{ monitorId: billing.id, displayName: null }] }));
    await admin(`/api/admin/pages/${body.page.id}`, "PUT", pageInput({ slug: "acme-newlink1", monitors: body.page.monitors }));
    expect((await call("/api/pages/acme-x7k2p9qa")).status).toBe(404);
    expect((await call("/api/pages/acme-newlink1")).status).toBe(200);

    await admin(`/api/admin/pages/${body.page.id}`, "PUT", pageInput({ slug: "acme-newlink1", enabled: false, monitors: body.page.monitors }));
    expect((await call("/api/pages/acme-newlink1")).status).toBe(404);
    expect((await call(`/api/pages/acme-newlink1/monitors/${billing.id}/checks?hour=${hour}`)).status).toBe(404);
  });

  it("validates links and monitors", async () => {
    await admin("/api/admin/pages", "POST", pageInput());
    expect((await admin("/api/admin/pages", "POST", pageInput())).status).toBe(409);
    for (const slug of ["ab", "Has Space", "-acme", "acme--x", "admin"]) {
      expect((await admin("/api/admin/pages", "POST", pageInput({ slug }))).status).toBe(400);
    }
    expect((await admin("/api/admin/pages", "POST", pageInput({ slug: "other-page", monitors: [{ monitorId: "missing", displayName: null }] }))).status).toBe(400);
    expect((await call("/api/admin/pages")).status).toBe(401);
  });

  it("reports page counts and removes deleted monitors from pages", async () => {
    await admin("/api/admin/pages", "POST", pageInput({ monitors: [{ monitorId: billing.id, displayName: null }, { monitorId: internal.id, displayName: null }] }));
    const { body } = await admin<{ monitors: AdminMonitor[] }>("/api/admin/monitors", "GET");
    expect(body.monitors.map((monitor) => monitor.pageCount)).toEqual([1, 1]);

    await admin(`/api/admin/monitors/${internal.id}`, "DELETE");
    const page = await publicStatus("/api/pages/acme-x7k2p9qa");
    expect(page.monitors.map((monitor) => monitor.name)).toEqual(["Billing"]);
  });
});
