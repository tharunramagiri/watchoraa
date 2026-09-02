import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

export const journeysRouter = Router();
journeysRouter.use(requireAuth);

const createSchema = z.object({
  destination: z.string().min(1).max(200),
  mode: z.enum(['NAVIGATION', 'ASSISTANT', 'READING', 'ENVIRONMENT']),
});

journeysRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const journeys = await prisma.journey.findMany({
      where: { userId: request.userId },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    response.json({ journeys });
  }),
);

journeysRouter.post(
  '/',
  asyncHandler(async (request, response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    // One-active-journey invariant (same as /api/safe-journey): multiple
    // ACTIVE journeys break the caregiver live-location lookup and the
    // escalation state machine.
    const active = await prisma.journey.findFirst({
      where: { userId: request.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (active) {
      response.status(409).json({ error: 'You already have an active journey. End it before starting a new one.' });
      return;
    }
    const journey = await prisma.journey.create({
      data: { ...parsed.data, status: 'ACTIVE', userId: request.userId! },
    });
    response.status(201).json({ journey });
  }),
);
