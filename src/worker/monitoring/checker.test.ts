import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMonitor } from "./checker";
import type { MonitorRow } from "../db/types";

const monitor: MonitorRow = {
  id: "check", name: "API", url: "https://example.com/health", method: "GET",
  expected_status_min: 200, expected_status_max: 299, expected_keyword: null,
  timeout_ms: 1000, interval_seconds: 60, follow_redirects: 0, paused: 0,
  created_at: 0, updated_at: 0,
};
afterEach(() => vi.restoreAllMocks());

describe("failed response diagnostics", () => {
  it("bounds text excerpts and captures only allowed headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(10000), {
      status: 503, headers: { "Content-Type": "text/plain", "Set-Cookie": "secret", "X-Request-ID": "trace-id" },
    }));
    const result = await checkMonitor(monitor);
    expect(result).toMatchObject({ successful: false, httpStatus: 503, failureKind: "http", responseBody: "x".repeat(2048), responseHeaders: { "content-type": "text/plain", "x-request-id": "trace-id" } });
  });
  it("records keyword mismatches even with HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable"));
    expect(await checkMonitor({ ...monitor, expected_keyword: "healthy" })).toMatchObject({ successful: false, httpStatus: 200, failureKind: "keyword", responseBody: "unavailable" });
  });
  it("preserves an HTTP error when reading its body fails", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("body disconnected")); } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 502, headers: { "Content-Type": "text/plain" } }));
    expect(await checkMonitor(monitor)).toMatchObject({ httpStatus: 502, failureKind: "http", responseBody: null });
  });
  it("preserves HTTP status for a body read failure after headers arrived", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("body disconnected")); } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    expect(await checkMonitor({ ...monitor, expected_keyword: "healthy" })).toMatchObject({ httpStatus: 200, failureKind: "body" });
  });
  it.each([
    [new DOMException("timed out", "TimeoutError"), "timeout"],
    [new Error("DNS lookup failed"), "network"],
  ])("classifies requests without an HTTP response", async (error, failureKind) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    expect(await checkMonitor(monitor)).toMatchObject({ successful: false, httpStatus: null, failureKind, responseBody: null });
  });
  it("does not retain successful bodies or binary failure bodies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response("healthy"));
    expect(await checkMonitor(monitor)).toMatchObject({ successful: true, responseBody: null, responseHeaders: {} });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 500, headers: { "Content-Type": "application/octet-stream" } }));
    expect(await checkMonitor(monitor)).toMatchObject({ successful: false, httpStatus: 500, responseBody: null });
  });
});
