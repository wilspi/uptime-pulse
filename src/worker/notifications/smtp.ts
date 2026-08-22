import { connect } from "cloudflare:sockets";

const CONNECTION_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

export interface MailMessage {
  kind: "down" | "recovered" | "test";
  subject: string;
  body: string;
}

interface MailEnvironment {
  SITE_NAME: string;
  SMTP_FROM: string;
  SMTP_TO: string;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

export class SmtpError extends Error {
  readonly responseCode: number | null;
  readonly permanent: boolean;

  constructor(message: string, responseCode: number | null = null) {
    super(message);
    this.name = "SmtpError";
    this.responseCode = responseCode;
    this.permanent = responseCode !== null && responseCode >= 500 && responseCode <= 599;
  }
}

export function isSmtpConfigured(env: Env): boolean {
  const port = Number(env.SMTP_PORT);
  return (
    env.SMTP_HOST.trim().length > 0 &&
    env.SMTP_HOST.trim().toLowerCase() !== "smtp.example.com" &&
    (port === 465 || port === 587) &&
    env.SMTP_USERNAME.length > 0 &&
    env.SMTP_PASSWORD.length > 0 &&
    isMailbox(env.SMTP_FROM) &&
    isMailbox(env.SMTP_TO)
  );
}

export async function sendSmtpMail(env: Env, message: MailMessage): Promise<void> {
  const host = validateHostname(env.SMTP_HOST);
  const port = Number(env.SMTP_PORT);
  if (port !== 465 && port !== 587) {
    throw new SmtpError("SMTP_PORT must be 465 or 587.");
  }
  if (!isMailbox(env.SMTP_FROM) || !isMailbox(env.SMTP_TO)) {
    throw new SmtpError("SMTP_FROM and SMTP_TO must be valid single email addresses.");
  }
  if (!env.SMTP_USERNAME || !env.SMTP_PASSWORD) {
    throw new SmtpError("SMTP credentials are not configured.");
  }

  let socket = connect(
    { hostname: host, port },
    {
      secureTransport: port === 465 ? "on" : "starttls",
      allowHalfOpen: true,
    },
  );
  let channel: SmtpChannel | null = null;

  try {
    await withTimeout(socket.opened, CONNECTION_TIMEOUT_MS, "SMTP connection timed out.");
    channel = new SmtpChannel(socket.readable, socket.writable);
    await channel.expect([220]);

    let capabilities = await ehlo(channel);
    if (port === 587) {
      if (!capabilities.lines.some((line) => line.toUpperCase().includes("STARTTLS"))) {
        throw new SmtpError("The SMTP server did not advertise STARTTLS.");
      }
      await channel.command("STARTTLS", [220]);
      channel.release();
      socket = socket.startTls({ expectedServerHostname: host });
      await withTimeout(socket.opened, CONNECTION_TIMEOUT_MS, "SMTP TLS upgrade timed out.");
      channel = new SmtpChannel(socket.readable, socket.writable);
      capabilities = await ehlo(channel);
    }

    await authenticate(channel, capabilities, env.SMTP_USERNAME, env.SMTP_PASSWORD);
    await channel.command(`MAIL FROM:<${env.SMTP_FROM}>`, [250]);
    await channel.command(`RCPT TO:<${env.SMTP_TO}>`, [250, 251]);
    await channel.command("DATA", [354]);
    await channel.write(`${buildMimeMessage(env, message)}\r\n.\r\n`);
    await channel.expect([250]);
    await channel.command("QUIT", [221]);
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    const detail = error instanceof Error ? error.message : "Unknown SMTP failure";
    throw new SmtpError(detail);
  } finally {
    channel?.release();
    try {
      await socket.close();
    } catch {
      // The server commonly closes immediately after QUIT.
    }
  }
}

class SmtpChannel {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private released = false;

  constructor(readable: ReadableStream, writable: WritableStream) {
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
  }

  async command(command: string, acceptedCodes: number[]): Promise<SmtpResponse> {
    await this.write(`${command}\r\n`);
    return this.expect(acceptedCodes);
  }

  async write(value: string): Promise<void> {
    await withTimeout(
      this.writer.write(new TextEncoder().encode(value)),
      COMMAND_TIMEOUT_MS,
      "SMTP write timed out.",
    );
  }

  async expect(acceptedCodes: number[]): Promise<SmtpResponse> {
    const response = await this.readResponse();
    if (!acceptedCodes.includes(response.code)) {
      throw new SmtpError(
        `SMTP command failed with ${response.code}: ${response.lines.join(" ").slice(0, 400)}`,
        response.code,
      );
    }
    return response;
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    let code: number | null = null;

    while (lines.join("\n").length < MAX_RESPONSE_BYTES) {
      const line = await this.readLine();
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) throw new SmtpError(`Malformed SMTP response: ${line.slice(0, 200)}`);

      const lineCode = Number(match[1]);
      code ??= lineCode;
      if (lineCode !== code) throw new SmtpError("SMTP response used inconsistent status codes.");
      lines.push(match[3]);
      if (match[2] === " ") return { code, lines };
    }

    throw new SmtpError("SMTP response exceeded the safety limit.");
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  private async readLine(): Promise<string> {
    while (true) {
      const newline = this.buffer.indexOf("\r\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 2);
        return line;
      }

      const result = await withTimeout(
        this.reader.read(),
        COMMAND_TIMEOUT_MS,
        "SMTP response timed out.",
      );
      if (result.done) throw new SmtpError("SMTP server closed the connection unexpectedly.");
      this.buffer += this.decoder.decode(result.value, { stream: true });
      if (this.buffer.length > MAX_RESPONSE_BYTES) {
        throw new SmtpError("SMTP response exceeded the safety limit.");
      }
    }
  }
}

async function ehlo(channel: SmtpChannel): Promise<SmtpResponse> {
  return channel.command("EHLO pulse.local", [250]);
}

async function authenticate(
  channel: SmtpChannel,
  capabilities: SmtpResponse,
  username: string,
  password: string,
): Promise<void> {
  const advertised = capabilities.lines.join(" ").toUpperCase();
  const plainToken = base64Utf8(`\0${username}\0${password}`);

  if (advertised.includes("PLAIN")) {
    await channel.write(`AUTH PLAIN ${plainToken}\r\n`);
    const response = await channel.readResponse();
    if (response.code === 235) return;
    if (response.code === 334) {
      await channel.write(`${plainToken}\r\n`);
      await channel.expect([235]);
      return;
    }
    if (![500, 502, 504].includes(response.code)) {
      throw new SmtpError(
        `SMTP authentication failed with ${response.code}: ${response.lines.join(" ").slice(0, 300)}`,
        response.code,
      );
    }
  }

  if (!advertised.includes("LOGIN") && advertised.includes("AUTH")) {
    throw new SmtpError("The SMTP server does not support AUTH PLAIN or AUTH LOGIN.");
  }

  await channel.command("AUTH LOGIN", [334]);
  await channel.command(base64Utf8(username), [334]);
  await channel.command(base64Utf8(password), [235]);
}

export function buildMimeMessage(env: MailEnvironment, message: MailMessage): string {
  const subject = encodeHeader(message.subject);
  const plainText = [
    normalizeBody(message.body),
    "",
    "---",
    "Built with ❤️ by @wilspi",
    "https://github.com/wilspi/uptime-pulse",
  ].join("\r\n");
  const plainBody = wrapBase64(base64Utf8(plainText));
  const htmlBody = wrapBase64(base64Utf8(renderEmailHtml(env.SITE_NAME, message)));
  const messageId = `<${crypto.randomUUID()}@${messageIdDomain(env.SMTP_FROM)}>`;
  const boundary = `pulse-${crypto.randomUUID()}`;

  return [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `From: ${env.SMTP_FROM}`,
    `To: ${env.SMTP_TO}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "Auto-Submitted: auto-generated",
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    plainBody,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlBody,
    `--${boundary}--`,
  ]
    .flatMap((part) => part.split("\r\n"))
    .map(dotStuff)
    .join("\r\n");
}

function renderEmailHtml(siteName: string, message: MailMessage): string {
  const themes = {
    down: {
      accent: "#e11d48",
      soft: "#fff1f2",
      border: "#fecdd3",
      label: "Incident alert",
      icon: "!",
    },
    recovered: {
      accent: "#059669",
      soft: "#ecfdf5",
      border: "#a7f3d0",
      label: "Service recovered",
      icon: "✓",
    },
    test: {
      accent: "#2563eb",
      soft: "#eff6ff",
      border: "#bfdbfe",
      label: "Email test",
      icon: "✓",
    },
  } as const;
  const theme = themes[message.kind];
  const lines = message.body.replace(/\r\n/g, "\n").split("\n");
  const summaryIndex = lines.findIndex((line) => line.trim());
  const summary = summaryIndex >= 0 ? lines[summaryIndex].trim() : message.subject;
  const detailRows = lines
    .slice(summaryIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) return { label: "Details", value: line };
      return {
        label: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
      };
    });
  const titlePrefix = `[${siteName}] `;
  const title = message.subject.startsWith(titlePrefix)
    ? message.subject.slice(titlePrefix.length)
    : message.subject;
  const rows = detailRows
    .map(({ label, value }, index) => {
      const borderTop = index === 0 ? "" : "border-top:1px solid #e7eee9;";
      return `<tr>
        <td style="${borderTop}padding:14px 16px;color:#64756e;font-size:12px;font-weight:700;line-height:18px;text-transform:uppercase;letter-spacing:.06em;width:34%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="${borderTop}padding:14px 16px;color:#17251f;font-size:14px;font-weight:600;line-height:20px;word-break:break-word;vertical-align:top;">${renderDetailValue(label, value, theme.accent)}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>${escapeHtml(message.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#edf3ef;color:#17251f;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(summary)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#edf3ef;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #dbe6df;border-radius:18px;box-shadow:0 12px 36px rgba(16,42,31,.10);overflow:hidden;">
          <tr>
            <td style="padding:22px 26px;background-color:#0a2118;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="color:#f5fbf7;font-size:17px;font-weight:750;letter-spacing:-.02em;">
                    <span style="display:inline-block;width:10px;height:10px;margin-right:10px;border-radius:50%;background-color:#4ee3a2;box-shadow:0 0 12px rgba(78,227,162,.75);vertical-align:1px;"></span>${escapeHtml(siteName)}
                  </td>
                  <td align="right" style="color:#8db2a2;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;">Uptime alert</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 28px 26px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="width:38px;height:38px;border-radius:50%;background-color:${theme.soft};border:1px solid ${theme.border};color:${theme.accent};font-size:19px;font-weight:800;">${theme.icon}</td>
                  <td style="padding-left:13px;color:${theme.accent};font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.11em;">${theme.label}</td>
                </tr>
              </table>
              <h1 style="margin:22px 0 10px;color:#10231a;font-size:28px;line-height:35px;font-weight:780;letter-spacing:-.035em;">${escapeHtml(title)}</h1>
              <p style="margin:0;color:#5f7169;font-size:15px;line-height:24px;">${escapeHtml(summary)}</p>
            </td>
          </tr>
          ${rows ? `<tr><td style="padding:0 28px 32px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f7faf8;border:1px solid #e0e9e4;border-radius:12px;">${rows}</table></td></tr>` : ""}
          <tr>
            <td style="padding:22px 28px;background-color:#f7faf8;border-top:1px solid #e2ebe6;text-align:center;">
              <p style="margin:0 0 7px;color:#829189;font-size:11px;line-height:17px;">This is an automated notification from ${escapeHtml(siteName)}.</p>
              <p style="margin:0;color:#7a8d83;font-size:12px;line-height:18px;">Built with <span style="color:#e11d48;">&#10084;&#65039;</span> by <a href="https://github.com/wilspi/uptime-pulse" style="color:#187c58;font-weight:700;text-decoration:none;">@wilspi</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderDetailValue(label: string, value: string, accent: string): string {
  if (label.toLowerCase() === "url") {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        const escaped = escapeHtml(url.toString());
        return `<a href="${escaped}" style="color:${accent};text-decoration:underline;">${escapeHtml(value)}</a>`;
      }
    } catch {
      // Fall through to safely escaped text.
    }
  }
  return escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function validateHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    throw new SmtpError("SMTP_HOST is not a valid public hostname.");
  }
  return hostname;
}

function isMailbox(value: string): boolean {
  return (
    value.length <= 254 &&
    !/[\r\n<>]/.test(value) &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
  );
}

function encodeHeader(value: string): string {
  const safe = value.replace(/[\r\n]+/g, " ").slice(0, 300);
  return /^[\x20-\x7E]*$/.test(safe) ? safe : `=?UTF-8?B?${base64Utf8(safe)}?=`;
}

function normalizeBody(value: string): string {
  return value.replace(/\r?\n/g, "\n").replace(/\n/g, "\r\n");
}

function dotStuff(line: string): string {
  return line.startsWith(".") ? `.${line}` : line;
}

function messageIdDomain(address: string): string {
  const domain = address.split("@")[1];
  return domain && /^[a-z0-9.-]+$/i.test(domain) ? domain : "pulse.local";
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new SmtpError(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
