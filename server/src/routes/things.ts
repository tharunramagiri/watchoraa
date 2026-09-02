// Find-my-things: users teach Watchora their personal objects (a red water
// bottle, the white cane case) by capturing it once; the stored description
// powers later "find my ___" lookups. Envision calls this "teach a face";
// we do objects — no biometrics, no people identification, ever.

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

export const thingsRouter = Router();
thingsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
});

const nameQuery = z.object({
  q: z.string().max(80).optional(),
});

// Normalize for lookup: case-insensitive, whitespace-collapsed.
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

thingsRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const parsed = nameQuery.safeParse(request.query);
    const q = parsed.success && parsed.data.q ? norm(parsed.data.q) : null;

    const things = await prisma.taughtThing.findMany({
      where: { userId: request.userId },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const matches = q ? things.filter((t) => norm(t.name).includes(q)) : things;
    // Exact normalized match first when searching.
    matches.sort((a, b) => Number(norm(b.name) === q) - Number(norm(a.name) === q));
    response.json({ things: matches });
  }),
);

thingsRouter.post(
  '/',
  asyncHandler(async (request, response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const name = parsed.data.name.trim();
    const existing = await prisma.taughtThing.findFirst({
      where: { userId: request.userId!, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      // Re-teaching an existing name updates its description instead of duplicating.
      const thing = await prisma.taughtThing.update({
        where: { id: existing.id },
        data: { description: parsed.data.description.trim() },
      });
      response.status(200).json({ thing, updated: true });
      return;
    }
    const thing = await prisma.taughtThing.create({
      data: { userId: request.userId!, name, description: parsed.data.description.trim() },
    });
    response.status(201).json({ thing });
  }),
);

thingsRouter.delete(
  '/:id',
  asyncHandler(async (request, response) => {
    const id = String(request.params.id);
    const existing = await prisma.taughtThing.findUnique({ where: { id } });
    if (!existing || existing.userId !== request.userId) {
      response.status(404).json({ error: 'Thing not found' });
      return;
    }
    await prisma.taughtThing.delete({ where: { id } });
    response.status(204).send();
  }),
);
