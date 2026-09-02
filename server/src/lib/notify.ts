import { createTransport } from 'nodemailer';

/**
 * Email delivery for safety-critical notifications (password reset, SOS alerts
 * to trusted contacts). Uses SMTP when configured; otherwise degrades to a
 * server-side log so self-hosted operators can still act, and reports
 * `false` so callers know the message was not delivered to a human.
 */
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? '587');
  return {
    host,
    port,
    secure: port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? 'Watchora <no-reply@watchora.app>',
  };
}

async function sendMail(to: string, subject: string, text: string, html: string, fromOverride?: string): Promise<boolean> {
  const config = readSmtpConfig();
  if (!config) {
    // No SMTP configured: log server-side (never returned over HTTP) so the
    // operator can complete the flow from the machine's own logs.
    console.warn(`[notify] SMTP not configured — message for ${to} follows:\n${subject}\n${text}`);
    return false;
  }
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transport.sendMail({ from: fromOverride ?? config.from, to, subject, text, html });
  return true;
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<boolean> {
  const base = process.env.PUBLIC_APP_URL ?? '';
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const subject = 'Reset your Watchora password';
  const text = [
    'Someone (hopefully you) requested a password reset for your Watchora account.',
    '',
    `This link works once and expires in one hour: ${resetUrl}`,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
  const html = [
    '<p>Someone (hopefully you) requested a password reset for your Watchora account.</p>',
    `<p><a href="${resetUrl}">Reset your password</a> — the link works once and expires in one hour.</p>`,
    '<p>If you did not request this, you can safely ignore this email.</p>',
  ].join('\n');
  return sendMail(to, subject, text, html);
}

const EMERGENCY_FROM = process.env.SMTP_FROM ?? 'Watchora Alerts <alerts@watchora.app>';

/**
 * Notifies a trusted contact that the person they look after has opened an
 * emergency SOS or marked themselves lost. Delivery is best-effort: failures
 * are logged and reported to the caller so the journey/session record can
 * reflect reality instead of a blind "they've been notified" promise.
 */
export async function sendEmergencyAlertEmail(to: string, personName: string, kind: 'SOS' | 'LOST', details: { when: string; journeyUrl?: string }): Promise<boolean> {
  const subject = `[Watchora] ${kind}: ${personName} needs attention`;
  const lines = [
    `${personName} has triggered a ${kind} alert in Watchora.`,
    '',
    `Triggered at: ${details.when}`,
    details.journeyUrl ? `Track their live location: ${details.journeyUrl}` : 'Open the caregiver portal to see their latest shared location.',
    '',
    'If you can reach them directly (call/message), please do so now.',
  ];
  return sendMail(to, subject, lines.join('\n'), `<p>${lines.join('<br/>')}</p>`, EMERGENCY_FROM);
}

/**
 * Invites someone to become a caregiver for a Watchora user. The link lands
 * on the signup page; when they register with this email, the user's existing
 * TrustedContact row (matched case-insensitively) connects them automatically.
 */
export async function sendCaregiverInviteEmail(to: string, personName: string): Promise<boolean> {
  const base = process.env.PUBLIC_APP_URL ?? '';
  const signupUrl = `${base}/signup`;
  const subject = `${personName} invited you to their care circle on Watchora`;
  const lines = [
    `${personName} has listed you as a trusted contact in Watchora, an assistive app for blind and low-vision people.`,
    '',
    `As their caregiver you can see their live location during journeys (with their explicit consent) and receive their SOS alerts.`,
    '',
    `Create your free account with this email address to connect: ${signupUrl}`,
    '',
    'If you were not expecting this, you can safely ignore this email.',
  ];
  const html = [
    `<p>${personName} has listed you as a trusted contact in Watchora, an assistive app for blind and low-vision people.</p>`,
    `<p>As their caregiver you can see their live location during journeys (with their explicit consent) and receive their SOS alerts.</p>`,
    `<p><a href="${signupUrl}">Create your free account</a> with this email address to connect.</p>`,
    '<p>If you were not expecting this, you can safely ignore this email.</p>',
  ].join('\n');
  return sendMail(to, subject, lines.join('\n'), html);
}
