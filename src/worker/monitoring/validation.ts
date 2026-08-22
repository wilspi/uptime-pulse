import type { MonitorInput, MonitorMethod } from "../../shared/types";

const ALLOWED_INTERVALS = new Set([60, 300, 900]);
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseMonitorInput(value: unknown): MonitorInput {
  if (!isRecord(value)) {
    throw new ValidationError("The request body must be a JSON object.");
  }

  const name = requiredString(value.name, "name", 80);
  const url = validateMonitorUrl(requiredString(value.url, "url", 2048));
  const method = parseMethod(value.method);
  const expectedStatusMin = integerInRange(
    value.expectedStatusMin,
    "expectedStatusMin",
    100,
    599,
    200,
  );
  const expectedStatusMax = integerInRange(
    value.expectedStatusMax,
    "expectedStatusMax",
    100,
    599,
    399,
  );

  if (expectedStatusMin > expectedStatusMax) {
    throw new ValidationError("The minimum expected status cannot exceed the maximum.");
  }

  const expectedKeyword = optionalString(value.expectedKeyword, "expectedKeyword", 200);
  if (method === "HEAD" && expectedKeyword) {
    throw new ValidationError("A response keyword cannot be checked with the HEAD method.");
  }

  const timeoutMs = integerInRange(value.timeoutMs, "timeoutMs", 1000, 30000, 10000);
  const intervalSeconds = integerInRange(
    value.intervalSeconds,
    "intervalSeconds",
    60,
    900,
    60,
  );
  if (!ALLOWED_INTERVALS.has(intervalSeconds)) {
    throw new ValidationError("The interval must be 60, 300, or 900 seconds.");
  }

  return {
    name,
    url,
    method,
    expectedStatusMin,
    expectedStatusMax,
    expectedKeyword,
    timeoutMs,
    intervalSeconds: intervalSeconds as 60 | 300 | 900,
    followRedirects: booleanValue(value.followRedirects, false),
    paused: booleanValue(value.paused, false),
  };
}

export function validateMonitorUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("Enter a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Only HTTP and HTTPS monitors are supported.");
  }
  if (url.username || url.password) {
    throw new ValidationError("Credentials are not allowed inside monitor URLs.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new ValidationError("Only ports 80, 443, 8080, and 8443 are allowed.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) {
    throw new ValidationError("Private, local, and reserved network targets are not allowed.");
  }

  url.hash = "";
  return url.toString();
}

function parseMethod(value: unknown): MonitorMethod {
  if (value === undefined) return "GET";
  if (value === "GET" || value === "HEAD") return value;
  throw new ValidationError("The method must be GET or HEAD.");
}

function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    return true;
  }

  if (hostname.includes(":")) {
    const compact = hostname.replace(/^0+/, "");
    return (
      compact === "::" ||
      compact === "::1" ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      /^fe[89ab]/.test(compact) ||
      compact.startsWith("2001:db8")
    );
  }

  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a, b, c] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters.`);
  }
  return trimmed || null;
}

function integerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ValidationError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ValidationError("Boolean fields must be true or false.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
