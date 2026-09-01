import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * RESEND_API_KEY is optional because SMTP is a first-class alternative — see
 * transport.ts. Requiring it here is what made an SMTP-only install impossible
 * to boot at all: the schema rejected the environment before any code could
 * decide which transport to use. createMailTransport() enforces the real rule,
 * which is that ONE of the two must be configured.
 */
export const env = createEnv({
  server: {
    RESEND_API_KEY: z.string().optional(),

    // Setting SMTP_HOST selects SMTP; leaving it unset keeps Resend.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    // Implicit TLS. Defaults to true on 465 and false elsewhere (STARTTLS is
    // required either way), so this is only needed for a relay on an
    // unconventional port.
    SMTP_SECURE: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    // The envelope sender. Relays reject a From they have not verified and the
    // templates hardcode their own, so this replaces the address while keeping
    // the template's display name.
    SMTP_FROM: z.string().optional(),
    // Unset means rewrite, which is the safe default; only "false" opts out.
    SMTP_FROM_FORCE: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  },
  runtimeEnv: {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_FROM: process.env.SMTP_FROM,
    SMTP_FROM_FORCE: process.env.SMTP_FROM_FORCE,
  },
  skipValidation: process.env.NODE_ENV === "test",
});
