/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./api";
import { recordCheck } from "./db/record-check";
import type { MonitorRow } from "./db/types";
import type { CheckResult } from "./monitoring/checker";
import type { CheckDetailsResponse } from "../shared/types";
import { getPublicStatus } from "./status";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const hour = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
const monitor: MonitorRow = {
  id: "details-test", name: "Test API", url: "https://example.com/private?token=hidden",
  method: "GET", expected_status_min: 200, expected_status_max: 299,
  expected_keyword: null, timeout_ms: 10000, interval_seconds: 60,
  follow_redirects: 0, paused: 0, created_at: hour - 3600, updated_at: hour - 3600,
};
const failed: CheckResult = {
  checkedAt: hour + 60, successful: false, latencyMs: 80, httpStatus: 503,
  error: "private failure details", failureKind: "http", responseBody: "private upstream body",
  responseHeaders: { "x-request-id": "private-trace" },
};
const timedOut: CheckResult = {
  ...failed, latencyMs: 10000, httpStatus: null, error: "Timed out after 10000 ms.",
  failureKind: "timeout", responseBody: null, responseHeaders: {},
};
const passed: CheckResult = { ...failed, successful: true, httpStatus: 200, error: null, failureKind: null, responseBody: null, responseHeaders: {} };
const adminHeaders = { Authorization: "Bearer test-admin-token" };

async function details(admin = false, at = hour): Promise<CheckDetailsResponse> {
  const res = await app.request(`/api/${admin ? "admin" : "status"}/monitors/${monitor.id}/checks?hour=${at}`, { headers: admin ? adminHeaders : {} }, testEnv);
  expect(res.status).toBe(200);
  return res.json();
}

async function record(results: CheckResult[]): Promise<void> {
  for (const [index, result] of results.entries()) {
    await recordCheck(testEnv, monitor, { ...result, checkedAt: hour + 60 + index * 60 });
  }
}

async function runCount(): Promise<number> {
  return (await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM check_runs").first<number>("total")) ?? 0;
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM monitors").run();
  await testEnv.DB.prepare(`INSERT INTO monitors
    (id, name, url, method, expected_status_min, expected_status_max, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'GET', 200, 299, ?4, ?4)`)
    .bind(monitor.id, monitor.name, monitor.url, monitor.created_at).run();
});

describe("failure runs and diagnostics API", () => {
  it("stores nothing extra for passing checks", async () => {
    await record([passed, passed, passed]);
    expect(await runCount()).toBe(0);
    expect(await details()).toMatchObject({ totalChecks: 3, failedChecks: 0, runs: [], downtimeSeconds: 0 });
  });

  it("collapses same-cause failures into one run and splits on a new cause", async () => {
    await record([failed, failed, timedOut, passed, failed]);
    expect(await runCount()).toBe(3);
    const data = await details(true);
    expect(data).toMatchObject({ totalChecks: 5, failedChecks: 4 });
    // Newest first.
    expect(data.runs.map((run) => [run.failureKind, run.failedChecks, run.outcome])).toEqual([
      ["http", 1, "ongoing"], ["timeout", 1, "passed"], ["http", 2, "changed"],
    ]);
    expect(data.runs[2]).toMatchObject({ startedAt: hour + 60, endedAt: hour + 120, passedAt: null });
    expect(data.runs[1]).toMatchObject({ passedAt: hour + 240, averageLatencyMs: 10000 });
  });

  it("exposes only safe public diagnostics", async () => {
    await record([failed, passed]);
    const publicData = await details();
    expect(publicData.runs).toEqual([expect.objectContaining({ reason: "Unexpected HTTP 503", failedChecks: 1 })]);
    expect(JSON.stringify(publicData)).not.toContain("private");
    expect(publicData.runs[0]).not.toHaveProperty("expectedStatusMin");
    expect(publicData).not.toHaveProperty("configChanges");
    const privateData = await details(true);
    expect(privateData.runs[0]).toMatchObject({ error: failed.error, responseBody: failed.responseBody, responseHeaders: failed.responseHeaders, expectedStatusMin: 200 });
    expect((await app.request(`/api/admin/monitors/${monitor.id}/checks?hour=${hour}`, {}, testEnv)).status).toBe(401);
  });

  it("describes incidents with first error, confirmation delay, downtime and alerts", async () => {
    await record([{ ...failed, error: "first failure" }, failed, failed, passed, passed]);
    const incident = await testEnv.DB.prepare("SELECT * FROM incidents WHERE monitor_id = ?1").bind(monitor.id)
      .first<{ id: string; initial_error: string; last_error: string; resolved_at: number }>();
    expect(incident).toMatchObject({ initial_error: "first failure", last_error: failed.error, resolved_at: hour + 300 });

    const hourData = await details(true);
    expect(hourData.downtimeSeconds).toBe(240);
    expect(hourData.incidents[0]).toMatchObject({ startedAt: hour + 60, confirmedAt: hour + 180 });
    expect(hourData.incidents[0].alerts?.map((alert) => [alert.kind, alert.status])).toEqual([["down", "pending"], ["recovered", "pending"]]);

    const response = await app.request(`/api/admin/incidents/${incident!.id}`, { headers: adminHeaders }, testEnv);
    expect(await response.json()).toMatchObject({ failedChecks: 3, totalChecks: null, downtimeSeconds: 240 });
    expect((await details()).incidents[0]).toMatchObject({ initialError: null, lastError: null });
  });

  it("shows hourly counts when failure details were not recorded", async () => {
    await testEnv.DB.prepare(`INSERT INTO metrics_hourly
      (monitor_id, bucket_start, total_checks, successful_checks, failed_checks, total_latency_ms, min_latency_ms, max_latency_ms)
      VALUES (?1, ?2, 10, 8, 2, 800, 50, 200)`).bind(monitor.id, hour).run();
    expect(await details()).toMatchObject({ totalChecks: 10, failedChecks: 2, runs: [], latency: { averageMs: 100, minMs: 50, maxMs: 200 } });
  });

  it("includes runs that span into the hour and excludes those outside it", async () => {
    await recordCheck(testEnv, monitor, { ...failed, checkedAt: hour - 120 });
    await recordCheck(testEnv, monitor, { ...failed, checkedAt: hour - 60 });
    await recordCheck(testEnv, monitor, { ...passed, checkedAt: hour - 1 });
    expect((await details()).runs).toEqual([]);
    await recordCheck(testEnv, monitor, { ...timedOut, checkedAt: hour + 3500 });
    await recordCheck(testEnv, monitor, { ...timedOut, checkedAt: hour + 3700 });
    const spanning = await details(false, hour + 3600);
    expect(spanning.runs).toEqual([expect.objectContaining({ startedAt: hour + 3500, failedChecks: 2 })]);
  });

  it("validates ranges and missing records", async () => {
    for (const query of ["hour=bad", `hour=${hour + 1}`, `hour=${hour - 91 * 86400}`]) {
      expect((await app.request(`/api/status/monitors/${monitor.id}/checks?${query}`, {}, testEnv)).status).toBe(400);
    }
    expect((await app.request(`/api/status/monitors/missing/checks?hour=${hour}`, {}, testEnv)).status).toBe(404);
    expect((await app.request("/api/admin/incidents/missing", { headers: adminHeaders }, testEnv)).status).toBe(404);
  });

  it("keeps the current hour and exactly the previous 23 hourly buckets", async () => {
    for (const timestamp of [hour - 24 * 3600, hour - 23 * 3600, hour]) {
      await recordCheck(testEnv, monitor, { ...passed, checkedAt: timestamp });
    }
    const status = await getPublicStatus(testEnv, hour);
    expect(status.monitors[0].metrics.map((metric) => metric.timestamp)).toEqual([hour - 23 * 3600, hour]);
  });
});
