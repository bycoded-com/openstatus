import { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";

/**
 * A small SMTP submission client.
 *
 * WHY NOT NODEMAILER. @openstatus/emails is compiled into three different
 * runtimes, and apps/workflows is a `deno compile` binary built from an esbuild
 * bundle. nodemailer is CJS and reaches for `require("node:zlib")` at load, which
 * a compiled ESM bundle cannot satisfy — the workflows binary died on startup
 * with "Dynamic require of node:zlib is not supported" the moment the dependency
 * entered the graph. node:net and node:tls are static imports of builtins, so
 * they bundle cleanly and behave the same under Node, Deno and Bun.
 *
 * The surface is deliberately submission-only: connect, greet, upgrade,
 * authenticate, send one message, quit. No pooling, no queue, no DSN parsing.
 */

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (465). Anything else negotiates STARTTLS, which is required. */
  secure: boolean;
  user?: string;
  pass?: string;
  timeoutMs?: number;
}

export interface SmtpMessage {
  /** Header From, e.g. `Basaltic Status <status@example.com>`. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  messageId: string;
}

/** Carries the SMTP reply code so callers can tell 4xx (retry) from 5xx (do not). */
export class SmtpError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
  }
}

type Socket = net.Socket | tls.TLSSocket;

/** `Name <a@b>` → `a@b`. The envelope takes the address alone. */
export function bareAddress(input: string): string {
  const match = input.match(/<([^>]+)>/);
  return (match?.[1] ?? input).trim();
}

/**
 * RFC 2047 for anything outside ASCII. Without this a subject carrying an
 * accent — which any Portuguese incident title will — arrives as mojibake.
 */
function encodeHeader(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range test
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function connect(opts: SmtpOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = opts.secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.createConnection({ host: opts.host, port: opts.port });
    const onError = (err: Error) => reject(err);
    socket.once("error", onError);
    socket.once(opts.secure ? "secureConnect" : "connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/**
 * One command, one reply. A reply is multi-line while the code is followed by
 * `-`, so read until a line has a space in that position; anything else and a
 * server's capability list would be mistaken for the response to EHLO.
 */
function converse(socket: Socket, line: string | null, timeoutMs: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new SmtpError(`timeout waiting for reply to ${line?.split(" ")[0] ?? "greeting"}`, 0));
    }, timeoutMs);
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      cleanup();
      const code = Number.parseInt(last.slice(0, 3), 10);
      resolve({ code, text: lines.join(" ") });
    };
    socket.on("data", onData);
    socket.on("error", onError);
    if (line !== null) socket.write(`${line}\r\n`);
  });
}

async function expect(
  socket: Socket,
  line: string | null,
  ok: number[],
  timeoutMs: number,
): Promise<{ code: number; text: string }> {
  const reply = await converse(socket, line, timeoutMs);
  if (!ok.includes(reply.code)) {
    throw new SmtpError(`${line?.split(" ")[0] ?? "greeting"}: ${reply.text}`, reply.code);
  }
  return reply;
}

export function buildMessage(msg: SmtpMessage): string {
  const headers: string[] = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
  ];
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.join(", ")}`);
  if (msg.replyTo?.length) headers.push(`Reply-To: ${msg.replyTo.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: <${msg.messageId}@${bareAddress(msg.from).split("@")[1] ?? "localhost"}>`);
  for (const [key, value] of Object.entries(msg.headers ?? {})) {
    // A caller-supplied header must never rewrite the envelope.
    if (
      ["from", "to", "cc", "bcc", "subject", "date", "message-id", "mime-version", "content-type"].includes(
        key.toLowerCase(),
      )
    ) {
      continue;
    }
    headers.push(`${key}: ${encodeHeader(value)}`);
  }
  headers.push("MIME-Version: 1.0");

  let body: string;
  if (msg.html && msg.text) {
    const boundary = `b${msg.messageId}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      msg.text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      msg.html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else if (msg.html) {
    headers.push("Content-Type: text/html; charset=utf-8");
    body = msg.html;
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8");
    body = msg.text ?? "";
  }

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Normalise line endings and dot-stuff, so a body line of "." cannot end DATA. */
function forData(message: string): string {
  return message
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export async function sendMail(opts: SmtpOptions, msg: SmtpMessage): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let socket = await connect(opts);
  socket.setTimeout(timeoutMs);

  try {
    await expect(socket, null, [220], timeoutMs);
    const ehlo = `EHLO ${bareAddress(msg.from).split("@")[1] ?? "localhost"}`;
    let greeting = await expect(socket, ehlo, [250], timeoutMs);

    if (!opts.secure) {
      // Required, not opportunistic: these are submission credentials, and a
      // relay that will not upgrade is one we must not authenticate against.
      if (!/STARTTLS/i.test(greeting.text)) {
        throw new SmtpError("server does not advertise STARTTLS", 0);
      }
      await expect(socket, "STARTTLS", [220], timeoutMs);
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket: socket as net.Socket, servername: opts.host }, () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      socket.setTimeout(timeoutMs);
      greeting = await expect(socket, ehlo, [250], timeoutMs);
    }

    if (opts.user && opts.pass) {
      const token = Buffer.from(`\0${opts.user}\0${opts.pass}`, "utf8").toString("base64");
      await expect(socket, `AUTH PLAIN ${token}`, [235], timeoutMs);
    }

    await expect(socket, `MAIL FROM:<${bareAddress(msg.from)}>`, [250], timeoutMs);
    const rcpts = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])];
    for (const rcpt of rcpts) {
      await expect(socket, `RCPT TO:<${bareAddress(rcpt)}>`, [250, 251], timeoutMs);
    }
    await expect(socket, "DATA", [354], timeoutMs);
    await expect(socket, `${forData(buildMessage(msg))}\r\n.`, [250], timeoutMs);
    await converse(socket, "QUIT", timeoutMs).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}
