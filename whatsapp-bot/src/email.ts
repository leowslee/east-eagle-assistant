// Sends email from the assistant's mailbox (Google Workspace SMTP with an app password).
// The agent only calls this after an approver has replied YES.

import nodemailer, { type Transporter } from "nodemailer";

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: { path: string; filename: string }[];
}

export interface Mailer {
  readonly from: string;
  send(email: OutgoingEmail): Promise<string>; // returns the message id
}

export class SmtpMailer implements Mailer {
  private transport: Transporter;

  constructor(readonly from: string, appPassword: string, private displayName: string) {
    this.transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: from, pass: appPassword.replace(/\s/g, "") },
    });
  }

  async send(email: OutgoingEmail): Promise<string> {
    const info = await this.transport.sendMail({
      from: { name: this.displayName, address: this.from },
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      text: email.text,
      attachments: email.attachments,
    });
    return info.messageId;
  }
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function checkAddresses(list: unknown): string[] {
  const arr = (Array.isArray(list) ? list : list ? [list] : []).map((x) => String(x).trim()).filter(Boolean);
  for (const a of arr) if (!EMAIL_RE.test(a)) throw new Error(`Not an email address: ${a}`);
  return arr;
}
