import { Resend } from "resend";
import type { Env } from "../types";

export function createEmailClient(env: Env): Resend {
  return new Resend(env.RESEND_API_KEY);
}

export async function sendDeadlineReminder(
  emailClient: Resend,
  to: string,
  lawyerName: string,
  caseTitle: string,
  clientName: string,
  deadlineDate: string,
  caseRef: string
) {
  return emailClient.emails.send({
    from: "Counsel <reminders@counsel-app.co.uk>",
    to,
    subject: `Deadline reminder: ${caseTitle} — ${deadlineDate}`,
    html: `
      <p>Hi ${lawyerName},</p>
      <p>This is a reminder that <strong>${caseTitle}</strong> (${caseRef}) for client <strong>${clientName}</strong> has a deadline on <strong>${deadlineDate}</strong>.</p>
      <p>Please ensure all outstanding tasks are completed before the deadline.</p>
      <p>— Counsel</p>
    `,
  });
}

export async function sendPasswordResetEmail(
  emailClient: Resend,
  to: string,
  name: string,
  resetToken: string,
  baseUrl: string
) {
  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
  return emailClient.emails.send({
    from: "Counsel <security@counsel-app.co.uk>",
    to,
    subject: "Password reset — Counsel",
    html: `
      <p>Hi ${name},</p>
      <p>A password reset was requested for your Counsel account.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      <p>— Counsel</p>
    `,
  });
}
