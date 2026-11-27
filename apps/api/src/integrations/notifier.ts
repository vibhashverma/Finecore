import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "pino";

/** Notifications: email to the Mailpit SANDBOX (nothing is delivered for real); SMS is a MOCK that only logs. */
export interface Notifier {
  email(to: string, subject: string, text: string, messageKey: string): Promise<void>;
  sms(toUserId: string, text: string): Promise<void>;
}

export class SandboxNotifier implements Notifier {
  private readonly smtp: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    private readonly logger: Logger,
  ) {
    const u = new URL(smtpUrl);
    this.smtp = nodemailer.createTransport({
      host: u.hostname,
      port: Number(u.port || 25),
      secure: u.protocol === "smtps:",
      ...(u.username
        ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } }
        : {}),
      connectionTimeout: 3000,
      socketTimeout: 5000,
    });
  }

  async email(to: string, subject: string, text: string, messageKey: string) {
    // A deterministic Message-ID lets the sandbox/recipient spot a retried (duplicate) send.
    await this.smtp.sendMail({
      from: this.from,
      to,
      subject: `[SIMULATED] ${subject}`,
      text,
      messageId: `<${messageKey}@fincore.test>`,
    });
  }

  async sms(toUserId: string, text: string) {
    this.logger.info(
      { channel: "sms", mock: true, user_id_hash: toUserId.slice(0, 8), length: text.length },
      "MOCK SMS sent",
    );
  }
}

/** Test double that records messages. */
export class RecordingNotifier implements Notifier {
  readonly emails: Array<{ to: string; subject: string; messageKey: string }> = [];
  readonly smsSent: string[] = [];
  failNext = 0;

  async email(to: string, subject: string, _text: string, messageKey: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated SMTP failure");
    }
    this.emails.push({ to, subject, messageKey });
  }

  async sms(toUserId: string) {
    this.smsSent.push(toUserId);
  }
}
