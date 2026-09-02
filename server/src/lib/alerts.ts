import { recordAudit } from './audit.js';
import { prisma } from './prisma.js';

/**
 * Best-effort safety alerts to a user's trusted contacts (SOS trigger,
 * "I'm lost"). Channels: SMS (Twilio) when the contact has a phone number
 * and Twilio is configured, plus email. Never throws: notification failure
 * must not block or fail the safety request itself. Per-channel delivery
 * outcomes are audited so the operator can see whether alerts actually
 * reached humans — and the client can surface "who was notified" honestly.
 */
export async function notifyTrustedContacts(
  userId: string,
  kind: 'SOS' | 'LOST',
  context: { journeyId?: string; sessionId?: string } = {},
): Promise<void> {
  try {
    const [user, contacts] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }),
      prisma.trustedContact.findMany({
        where: { userId, canReceiveAlerts: true },
        select: { email: true, phone: true },
      }),
    ]);
    if (!user || contacts.length === 0) return;

    const name = user.fullName || 'A person you assist';
    const when = new Date().toISOString();
    const smsLines = contacts.filter((c) => c.phone?.trim());
    const emailLines = contacts.filter((c) => c.email?.trim());

    const { sendSms, smsConfigured } = await import('./sms.js');
    const { sendEmergencyAlertEmail } = await import('./notify.js');

    const smsResults = smsConfigured()
      ? await Promise.allSettled(
          smsLines.map((c) => sendSms(c.phone!.trim(), `${name} has triggered a ${kind} alert in Watchora at ${when}. Open the caregiver portal to see their location.`)),
        )
      : [];
    const emailResults = await Promise.allSettled(
      emailLines.map((c) => sendEmergencyAlertEmail(c.email!, name, kind, { when, journeyUrl: context.journeyId ? `${process.env.PUBLIC_APP_URL ?? ''}/caregiver` : undefined })),
    );

    const countOk = <T>(results: PromiseSettledResult<T>[], ok: (v: T) => boolean) =>
      results.filter((r) => r.status === 'fulfilled' && ok(r.value)).length;

    await recordAudit({
      actorId: userId,
      action: kind === 'SOS' ? 'emergency.contacts_notified' : 'safe_journey.contacts_notified',
      entityType: 'User',
      entityId: userId,
      metadata: {
        kind,
        recipients: contacts.length,
        sms: { attempted: smsLines.length, delivered: countOk(smsResults, (v) => v === true), configured: smsConfigured() },
        email: { attempted: emailLines.length, delivered: countOk(emailResults, (v) => v === true), configured: Boolean(process.env.SMTP_HOST) },
        journeyId: context.journeyId ?? null,
        sessionId: context.sessionId ?? null,
      },
    });
  } catch (error) {
    console.error('[alerts] trusted-contact notification failed', error);
  }
}
