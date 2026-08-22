import { connect } from "cloudflare:sockets";

const CONNECTION_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

export interface MailMessage {
  subject: string;
  body: string;
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
    await channel.write(`${buildMessage(env, message)}\r\n.\r\n`);
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

function buildMessage(env: Env, message: MailMessage): string {
  const subject = encodeHeader(message.subject);
  const body = wrapBase64(base64Utf8(normalizeBody(message.body)));
  const messageId = `<${crypto.randomUUID()}@${messageIdDomain(env.SMTP_FROM)}>`;

  return [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `From: ${env.SMTP_FROM}`,
    `To: ${env.SMTP_TO}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ]
    .map(dotStuff)
    .join("\r\n");
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
