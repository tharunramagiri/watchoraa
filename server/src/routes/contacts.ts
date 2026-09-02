import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().max(200).optional(),
  canReceiveAlerts: z.boolean().default(true),
  canSeeLocation: z.boolean().default(false),
});

contactsRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const contacts = await prisma.trustedContact.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: 'asc' },
    });
    response.json({ contacts });
  }),
);

contactsRouter.post(
  '/',
  asyncHandler(async (request, response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    // Emails are the join key for caregiver matching — store normalized so
    // Care@x.com and care@x.com can never silently break alert delivery.
    const data = { ...parsed.data, email: parsed.data.email?.trim().toLowerCase() };
    const contact = await prisma.trustedContact.create({
      data: { ...data, userId: request.userId! },
    });
    response.status(201).json({ contact });
  }),
);

// Per-contact consent toggle: a blind user may grant (or revoke) live
// location visibility for a specific caregiver. This is the consent side of
// the caregiver map feature — the location endpoint only ever returns a
// position when BOTH this flag AND the active journey's shareLive are true.
contactsRouter.patch(
  '/:id',
  asyncHandler(async (request, response) => {
    const parsed = z
      .object({
        canSeeLocation: z.boolean().optional(),
        canReceiveAlerts: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const id = String(request.params.id);
    const existing = await prisma.trustedContact.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.userId) {
      response.status(404).json({ error: 'Contact not found' });
      return;
    }

    const contact = await prisma.trustedContact.update({
      where: { id },
      data: parsed.data,
    });
    response.json({ contact });
  }),
);

contactsRouter.post(
  '/:id/invite',
  asyncHandler(async (request, response) => {
    const id = String(request.params.id);
    const existing = await prisma.trustedContact.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.userId) {
      response.status(404).json({ error: 'Contact not found' });
      return;
    }
    if (!existing.email) {
      response.status(400).json({ error: 'Add an email address to this contact before inviting them.' });
      return;
    }
    const me = await prisma.user.findUnique({ where: { id: request.userId }, select: { fullName: true } });
    const { sendCaregiverInviteEmail } = await import('../lib/notify.js');
    const delivered = await sendCaregiverInviteEmail(existing.email, me?.fullName || 'A Watchora user').catch(() => false);
    await recordAudit({
      actorId: request.userId,
      action: 'contact.invite_sent',
      entityType: 'TrustedContact',
      entityId: existing.id,
      metadata: { email: existing.email, delivered },
    });
    // Honest response: the client can tell the user whether the invite
    // actually went out (delivery: 'email') or the operator must configure
    // SMTP first (delivery: 'unconfigured').
    response.json({
      ok: true,
      delivery: delivered ? 'email' : process.env.SMTP_HOST ? 'failed' : 'unconfigured',
    });
  }),
);

contactsRouter.delete(
  '/:id',
  asyncHandler(async (request, response) => {
    const id = String(request.params.id);
    const existing = await prisma.trustedContact.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.userId) {
      response.status(404).json({ error: 'Contact not found' });
      return;
    }

    await prisma.trustedContact.delete({ where: { id } });
    response.status(204).send();
  }),
);
