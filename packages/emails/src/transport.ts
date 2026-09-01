import type React from "react";
import { render } from "react-email";
import { Resend } from "resend";

import { env } from "./env";

/**
 * Mail transport — Resend, or SMTP.
 *
 * WHY THIS EXISTS. Upstream sends through Resend and only Resend: there is no
 * SMTP path anywhere in the tree, and every env schema requires RESEND_API_KEY
 * before a service will boot. Self-hosters who already have an SMTP relay — SES,
 * Postfix, anything — had to run a proxy that impersonates the Resend HTTP API
 * to use it.
 *
 * THE SHAPE IS RESEND'S, DELIBERATELY. `MailTransport` is the slice of the
 * Resend client that EmailClient actually calls, so a Resend instance satisfies
 * it as-is and the ten send methods in client.tsx are untouched. Their retry
 * logic keys on `error.name`, so SmtpTransport returns the same names with the
 * same retryable/non-retryable meaning — anything else would silently change
 * when a failed send is retried.
 */

export type Address = string | string[];

export interface SendPayload {
  from: string;
  to: Address;
  subject: string;
  react?: React.JSX.Element;
  html?: string;
  text?: string;
  // Both spellings are in use here: client.tsx passes `replyTo` (Resend v6) and
  // send.ts's Emails interface passes `reply_to`. Accept either.
  replyTo?: Address;
  reply_to?: Address;
  cc?: Address;
  bcc?: Address;
  headers?: Record<string, string>;
}

export interface SendOptions {
  idempotencyKey?: string;
}

export interface SendError {
  name: string;
  message: string;
}

export interface SendResult {
  data: { id: string } | null;
  error: SendError | null;
}

export interface BatchResult {
  data: { data: { id: string }[] } | null;
  error: SendError | null;
}

export interface MailTransport {
  emails: {
    send(payload: SendPayload, options?: SendOptions): Promise<SendResult>;
  };
  batch: {
    send(payloads: SendPayload[], options?: SendOptions): Promise<BatchResult>;
  };
}

// Resend's non-retryable set, mirrored here because SmtpTransport has to
// classify its own failures into the same two buckets. A permanent SMTP
// rejection (5xx: unknown mailbox, blocked sender) can never succeed on retry,
// while a 4xx or a dropped connection usually can.
const PERMANENT = "validation_error";
const TRANSIENT = "application_error";

function list(a: Address | undefined): string[] {
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

/**
 * SES rejects a From it has not verified, and the templates hardcode
 * `notifications@notifications.openstatus.dev`. SMTP_FROM replaces the address
 * while keeping whatever display name the template chose, so a subscriber still
 * reads "Basaltic Status" rather than a bare mailbox.
 */
function resolveFrom(requested: string): string {
  if (!env.SMTP_FROM) return requested;
  // Rewriting is the default: the templates hardcode a From that a relay will
  // not have verified, so not rewriting is the opt-in.
  if (env.SMTP_FROM_FORCE === false) return requested || env.SMTP_FROM;
  const match = requested?.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match?.[1]) return `${match[1]} <${env.SMTP_FROM}>`;
  return env.SMTP_FROM;
}

export class SmtpTransport implements MailTransport {
  // biome-ignore lint/suspicious/noExplicitAny: nodemailer types are optional
  private transporter: any;
  // Honouring Idempotency-Key matters because the retry path in client.tsx is
  // what fires after a transient failure: without it, one flaky send becomes
  // two deliveries of the same status report to every subscriber. Process-wide
  // rather than per-instance, because call sites build an EmailClient per
  // request — see createMailTransport.
  private readonly sent = new Map<string, { id: string; at: number }>();
  private readonly ttlMs = 24 * 60 * 60 * 1000;

  private async client() {
    if (!this.transporter) {
      const mod = await import("nodemailer");
      // biome-ignore lint/suspicious/noExplicitAny: CJS interop
      const nodemailer: any = (mod as any).default ?? mod;
      const port = env.SMTP_PORT ?? 587;
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        // Implicit TLS on 465, STARTTLS everywhere else. Named rather than
        // inferred so a relay on a non-standard port can still be told which.
        secure: env.SMTP_SECURE ?? port === 465,
        requireTLS: true,
        auth:
          env.SMTP_USER && env.SMTP_PASSWORD
            ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
            : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 60_000,
      });
    }
    return this.transporter;
  }

  private replay(key: string | undefined): string | null {
    if (!key) return null;
    const hit = this.sent.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.sent.delete(key);
      return null;
    }
    return hit.id;
  }

  private remember(key: string | undefined, id: string) {
    if (!key) return;
    for (const [k, v] of this.sent) {
      if (Date.now() - v.at > this.ttlMs) this.sent.delete(k);
    }
    this.sent.set(key, { id, at: Date.now() });
  }

  private async deliver(payload: SendPayload): Promise<string> {
    const to = list(payload.to);
    if (to.length === 0) throw Object.assign(new Error("`to` is required"), { permanent: true });

    // The templates pass React elements and expect the provider to render them.
    // A plain-text alternative is generated from the same element rather than
    // left empty: a HTML-only message scores worse with every spam filter, and
    // these are exactly the mails that must not land in a junk folder.
    let html = payload.html;
    let text = payload.text;
    if (payload.react) {
      html = await render(payload.react);
      if (!text) text = await render(payload.react, { plainText: true });
    }
    if (!html && !text) {
      throw Object.assign(new Error("one of `react`, `html` or `text` is required"), {
        permanent: true,
      });
    }

    const transporter = await this.client();
    const info = await transporter.sendMail({
      from: resolveFrom(payload.from),
      to,
      cc: list(payload.cc),
      bcc: list(payload.bcc),
      replyTo: list(payload.replyTo ?? payload.reply_to),
      subject: payload.subject,
      html,
      text,
      headers: payload.headers,
    });
    return String(info?.messageId ?? crypto.randomUUID());
  }

  private classify(err: unknown): SendError {
    const e = err as { message?: string; responseCode?: number; permanent?: boolean };
    const permanent = e?.permanent === true || (e?.responseCode !== undefined && e.responseCode >= 500);
    return {
      name: permanent ? PERMANENT : TRANSIENT,
      message: e?.message ?? String(err),
    };
  }

  emails = {
    send: async (payload: SendPayload, options?: SendOptions): Promise<SendResult> => {
      const replayed = this.replay(options?.idempotencyKey);
      if (replayed) return { data: { id: replayed }, error: null };
      try {
        const id = await this.deliver(payload);
        this.remember(options?.idempotencyKey, id);
        return { data: { id }, error: null };
      } catch (err) {
        return { data: null, error: this.classify(err) };
      }
    },
  };

  batch = {
    send: async (payloads: SendPayload[], options?: SendOptions): Promise<BatchResult> => {
      const out: { id: string }[] = [];
      for (let i = 0; i < payloads.length; i++) {
        // Resend derives one key per batch item; the same derivation here keeps
        // a partially-delivered batch from re-sending the items that landed.
        const key = options?.idempotencyKey ? `${options.idempotencyKey}:${i}` : undefined;
        const replayed = this.replay(key);
        if (replayed) {
          out.push({ id: replayed });
          continue;
        }
        try {
          const id = await this.deliver(payloads[i]);
          this.remember(key, id);
          out.push({ id });
        } catch (err) {
          // Resend fails a batch as a unit, and client.tsx's retry was written
          // against that. Matching it keeps the retry semantics unchanged.
          return { data: null, error: this.classify(err) };
        }
      }
      return { data: { data: out }, error: null };
    },
  };
}

/**
 * SMTP when SMTP_HOST is set, Resend otherwise. Fails loudly when neither is
 * configured rather than at the first send, which would be an outage
 * notification that silently never went out.
 */
let smtpTransport: SmtpTransport | null = null;

export function createMailTransport(opts?: { apiKey?: string }): MailTransport {
  if (env.SMTP_HOST) {
    // Deliberately a singleton — see the note on SmtpTransport.sent.
    if (!smtpTransport) smtpTransport = new SmtpTransport();
    return smtpTransport;
  }
  const apiKey = opts?.apiKey || env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No mail transport configured. Set SMTP_HOST (with SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM) to send over SMTP, or RESEND_API_KEY to send through Resend.",
    );
  }
  return new Resend(apiKey) as unknown as MailTransport;
}
