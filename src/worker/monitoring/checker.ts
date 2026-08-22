import type { MonitorRow } from "../db/types";

const MAX_ASSERTION_BYTES = 64 * 1024;

export interface CheckResult {
  successful: boolean;
  checkedAt: number;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
}

export async function checkMonitor(monitor: MonitorRow): Promise<CheckResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const startedAt = performance.now();

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
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

    if (
      response.status < monitor.expected_status_min ||
      response.status > monitor.expected_status_max
    ) {
      await safelyCancelBody(response);
      return {
        successful: false,
        checkedAt,
        latencyMs,
        httpStatus: response.status,
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
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      successful: false,
      checkedAt,
      latencyMs,
      httpStatus: null,
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
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Timed out after ${timeoutMs} ms.`;
  }
  if (error instanceof Error) {
    return `Request failed: ${error.message.slice(0, 220)}`;
  }
  return "Request failed for an unknown reason.";
}
