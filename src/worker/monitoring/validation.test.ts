import { describe, expect, it } from "vitest";
import { parseMonitorInput, ValidationError, validateMonitorUrl } from "./validation";

describe("validateMonitorUrl", () => {
  it("normalizes a public HTTP URL and removes fragments", () => {
    expect(validateMonitorUrl("https://example.com/health#internal")).toBe("https://example.com/health");
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.1.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
  ])("rejects local or private target %s", (url) => {
    expect(() => validateMonitorUrl(url)).toThrow(ValidationError);
  });

  it("does not overblock unrelated public address ranges", () => {
    expect(validateMonitorUrl("https://203.1.2.3/")).toBe("https://203.1.2.3/");
    expect(validateMonitorUrl("https://198.51.99.1/")).toBe("https://198.51.99.1/");
  });

  it("rejects embedded credentials and unusual ports", () => {
    expect(() => validateMonitorUrl("https://user:secret@example.com/")).toThrow(ValidationError);
    expect(() => validateMonitorUrl("https://example.com:22/")).toThrow(ValidationError);
  });
});

describe("parseMonitorInput", () => {
  it("applies economical defaults", () => {
    expect(parseMonitorInput({ name: "Web", url: "https://example.com" })).toMatchObject({
      method: "GET",
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      timeoutMs: 10_000,
      intervalSeconds: 60,
      followRedirects: false,
      paused: false,
    });
  });

  it("does not allow a body assertion on HEAD", () => {
    expect(() => parseMonitorInput({ name: "Web", url: "https://example.com", method: "HEAD", expectedKeyword: "ok" })).toThrow(ValidationError);
  });
});
