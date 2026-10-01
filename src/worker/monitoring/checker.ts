import type { FailureKind } from "../../shared/types";
import type { MonitorRow } from "../db/types";

const MAX_ASSERTION_BYTES = 64 * 1024;

export interface CheckResult {
  successful: boolean;
  checkedAt: number;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
  failureKind: FailureKind | null;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
}

export async function checkMonitor(monitor: MonitorRow): Promise<CheckResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const startedAt = performance.now();

  let httpStatus: number | null = null;
  let responseHeaders: Record<string, string> = {};
  try {
    const response = await fetch(monitor.url, {
      method: monitor.method,
      redirect: monitor.follow_redirects === 1 ? "follow" : "manual",
      signal: AbortSignal.timeout(monitor.timeout_ms),
      headers: {
        Accept: monitor.expected_keyword ? "text/plain, application/json;q=0.9, */*;q=0.1" : "*/*",
        "User-Agent": "Pulse-Uptime-Monitor/0.1",
      },
    });
    httpStatus = response.status;
    responseHeaders = diagnosticHeaders(response.headers);
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

    if (
      response.status < monitor.expected_status_min ||
      response.status > monitor.expected_status_max
    ) {
      const responseBody = await failureExcerpt(response);
      return {
        successful: false,
        checkedAt,
        latencyMs,
        httpStatus: response.status,
        failureKind: "http",
        responseBody,
        responseHeaders,
        error: `Expected HTTP ${monitor.expected_status_min}-${monitor.expected_status_max}, received ${response.status}.`,
      };
    }

    if (monitor.expected_keyword) {
      const body = await readBoundedBody(response, MAX_ASSERTION_BYTES);
      if (!body.includes(monitor.expected_keyword)) {
        return {
          successful: false,
          checkedAt,
          latencyMs,
          httpStatus: response.status,
          failureKind: "keyword",
          responseBody: new TextDecoder().decode(new TextEncoder().encode(body).subarray(0, 2048)),
          responseHeaders,
          error: `Expected response text was not found in the first ${MAX_ASSERTION_BYTES / 1024} KiB.`,
        };
      }
    } else {
      await safelyCancelBody(response);
    }

    return {
      successful: true,
      checkedAt,
      latencyMs,
      httpStatus: response.status,
      error: null,
      failureKind: null,
      responseBody: null,
      responseHeaders: {},
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      successful: false,
      checkedAt,
      latencyMs,
      httpStatus,
      failureKind: isTimeout(error) ? "timeout" : httpStatus === null ? "network" : "body",
      responseBody: null,
      responseHeaders,
      error: describeFetchError(error, monitor.timeout_ms),
    };
  }
}

async function readBoundedBody(response: Response, byteLimit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let content = "";
  let finished = false;

  try {
    while (totalBytes < byteLimit) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      const remaining = byteLimit - totalBytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      totalBytes += chunk.byteLength;
      content += decoder.decode(chunk, { stream: true });
    }
    content += decoder.decode();
    return content;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The peer may already have closed the body; the check result remains valid.
      }
    }
    reader.releaseLock();
  }
}

async function safelyCancelBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Releasing the connection is best-effort after response headers were received.
  }
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (isTimeout(error)) {
    return `Timed out after ${timeoutMs} ms.`;
  }
  if (error instanceof Error) {
    return `Request failed: ${error.message.slice(0, 220)}`;
  }
  return "Request failed for an unknown reason.";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function diagnosticHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "retry-after", "cf-ray", "x-request-id", "x-correlation-id"]) {
    const value = headers.get(name);
    if (value) result[name] = value.slice(0, 256);
  }
  return result;
}

async function failureExcerpt(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/|json|xml/i.test(contentType)) {
    await safelyCancelBody(response);
    return null;
  }
  try {
    return await readBoundedBody(response, 2048);
  } catch {
    // Preserve the HTTP failure even when its response body cannot be read.
    return null;
  }
}
