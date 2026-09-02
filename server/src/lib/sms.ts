import twilio from 'twilio';

/**
 * SMS delivery for safety-critical alerts (SOS, journey escalation).
 * Twilio credentials come from env; when unset, sendSms reports `false`
 * (logged server-side, never thrown) so the alert pipeline can degrade to
 * email-only and the audit log reflects what actually reached a human.
 */

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

export function smsConfigured(): boolean {
  return Boolean(accountSid && authToken && fromNumber);
}

export async function sendSms(to: string, body: string): Promise<boolean> {
  if (!smsConfigured()) {
    console.warn(`[sms] Twilio not configured — SMS for ${to} not sent: ${body.slice(0, 120)}`);
    return false;
  }
  if (!to.trim()) return false;
  const client = twilio(accountSid!, authToken!);
  await client.messages.create({ from: fromNumber!, to, body: body.slice(0, 1600) });
  return true;
}
