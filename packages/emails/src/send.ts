import type React from "react";
import { render } from "react-email";

import { type MailTransport, createMailTransport } from "./transport";

// Constructed on first use rather than at module load: createMailTransport
// throws when neither transport is configured, and an import-time throw would
// take down a service that may never send an email.
let transport: MailTransport | null = null;
export const resend = (): MailTransport => {
  if (!transport) transport = createMailTransport();
  return transport;
};

export interface Emails {
  react: React.JSX.Element;
  subject: string;
  to: string[];
  from: string;
  reply_to?: string;
}

export type EmailHtml = {
  html: string;
  subject: string;
  to: string;
  from: string;
  reply_to?: string;
};
export const sendEmail = async (email: Emails) => {
  if (process.env.NODE_ENV !== "production") return;
  await resend().emails.send(email);
};

export const sendBatchEmailHtml = async (emails: EmailHtml[]) => {
  if (process.env.NODE_ENV !== "production") return;
  await resend().batch.send(emails);
};

// TODO: delete in favor of sendBatchEmailHtml
export const sendEmailHtml = async (emails: EmailHtml[]) => {
  if (process.env.NODE_ENV !== "production") return;

  // Was a hand-rolled POST to api.resend.com, which ignored whatever transport
  // the install is configured with — on an SMTP install it sent nothing and
  // reported nothing.
  await resend().batch.send(emails);
};

export const sendWithRender = async (email: Emails) => {
  if (process.env.NODE_ENV !== "production") return;
  const html = await render(email.react);
  await resend().emails.send({
    ...email,
    html,
  });
};
