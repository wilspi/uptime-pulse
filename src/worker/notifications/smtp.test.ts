import { describe, expect, it } from "vitest";
import { buildMimeMessage } from "./smtp";

const mailEnvironment = {
  SITE_NAME: "Uptime Pulse",
  SMTP_FROM: "alerts@example.com",
  SMTP_TO: "owner@example.com",
};

describe("SMTP MIME messages", () => {
  it("includes rich and plain alert bodies with the project credit", () => {
    const mime = buildMimeMessage(mailEnvironment, {
      kind: "down",
      subject: "[Uptime Pulse] API <primary> is down",
      body: [
        "API <primary> has been confirmed down by Uptime Pulse.",
        "",
        "URL: https://example.com/health?ready=true&live=true",
        "Latest error: Expected <healthy> & got unavailable",
      ].join("\n"),
    });

    expect(mime).toContain("Content-Type: multipart/alternative;");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');

    const [plainText, html] = decodeAlternativeParts(mime);
    expect(plainText).toContain("API <primary> has been confirmed down");
    expect(plainText).toContain("Built with ❤️ by @wilspi");
    expect(html).toContain("Incident alert");
    expect(html).toContain("API &lt;primary&gt; is down");
    expect(html).toContain("Expected &lt;healthy&gt; &amp; got unavailable");
    expect(html).toContain('href="https://example.com/health?ready=true&amp;live=true"');
    expect(html).toContain("https://github.com/wilspi/uptime-pulse");
    expect(html).not.toContain("API <primary>");
  });

  it.each([
    ["recovered", "Service recovered"],
    ["test", "Email test"],
  ] as const)("renders the %s presentation", (kind, label) => {
    const mime = buildMimeMessage(mailEnvironment, {
      kind,
      subject: `[Uptime Pulse] ${kind}`,
      body: `A ${kind} notification.`,
    });

    const [, html] = decodeAlternativeParts(mime);
    expect(html).toContain(label);
  });
});

function decodeAlternativeParts(mime: string): [string, string] {
  const encodedParts = [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--pulse-/g)]
    .map((match) => match[1].replace(/\r\n/g, ""));
  expect(encodedParts).toHaveLength(2);
  return encodedParts.map(decodeBase64Utf8) as [string, string];
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
