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

export async function sendInviteEmail(
  emailClient: Resend,
  to: string,
  name: string,
  firmName: string,
  invitedByName: string,
  inviteToken: string,
  baseUrl: string
) {
  const inviteUrl = `${baseUrl}/accept-invite?token=${inviteToken}`;
  return emailClient.emails.send({
    from: "Counsel <invites@counsel-app.co.uk>",
    to,
    subject: `You've been invited to join ${firmName} on Counsel`,
    html: `
      <p>Hi ${name},</p>
      <p>${invitedByName} has invited you to join <strong>${firmName}</strong> on Counsel.</p>
      <p><a href="${inviteUrl}" style="background:#1a1a2e;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block">Accept invitation &amp; set password</a></p>
      <p>This link expires in 7 days. If you weren't expecting this, ignore this email.</p>
      <p>— Counsel</p>
    `,
  });
}
