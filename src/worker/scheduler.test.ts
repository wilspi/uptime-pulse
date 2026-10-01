/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledChecks } from "./scheduler";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
// Avoid the top of the hour so pruning does not run.
const minute = (Math.floor(Date.now() / 3_600_000) * 3600 + 120) * 1000;

async function addMonitors(count: number, followRedirects: boolean): Promise<void> {
  await testEnv.DB.batch(Array.from({ length: count }, (_, index) => testEnv.DB.prepare(
    `INSERT INTO monitors (id, name, url, method, follow_redirects, created_at, updated_at)
     VALUES (?1, ?1, 'https://example.com/health', 'GET', ?2, 0, 0)`,
  ).bind(`monitor-${index}`, followRedirects ? 1 : 0)));
}

async function checkedCount(): Promise<number> {
  return (await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM monitor_state").first<number>("total")) ?? 0;
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM monitors").run();
  await testEnv.DB.prepare("DELETE FROM runtime_locks").run();
});
afterEach(() => vi.restoreAllMocks());

describe("scheduled checks", () => {
  it("records failure runs and incidents from preloaded context", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    await addMonitors(1, false);
    for (let index = 0; index < 3; index += 1) {
      await testEnv.DB.prepare("UPDATE monitor_state SET last_checked_at = 0").run();
      await runScheduledChecks(testEnv, minute + index * 60_000);
    }
    const run = await testEnv.DB.prepare("SELECT failed_checks, recovered_at FROM check_runs").first();
    expect(run).toEqual({ failed_checks: 3, recovered_at: null });
    const incident = await testEnv.DB.prepare("SELECT initial_error, resolved_at FROM incidents").first();
    expect(incident).toMatchObject({ initial_error: "Expected HTTP 200-399, received 503.", resolved_at: null });
  });

  it("checks all 20 monitors in one invocation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await addMonitors(20, false);
    await runScheduledChecks(testEnv, minute);
    expect(await checkedCount()).toBe(20);
  });

  it("defers monitors that would exceed the subrequest budget", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await addMonitors(12, true);
    await runScheduledChecks(testEnv, minute);
    expect(await checkedCount()).toBe(10);
    await runScheduledChecks(testEnv, minute + 60_000);
    expect(await checkedCount()).toBe(12);
  });
});
