import { prisma } from './prisma.js';

/**
 * Periodic TTL cleanup for token tables: expired refresh tokens and used/
 * expired password-reset rows would otherwise grow unboundedly. Runs hourly;
 * rows are kept for a grace window after expiry so concurrent requests that
 * read them just before expiry still see consistent state.
 */
const GRACE_MS = 24 * 60 * 60 * 1000; // purge 24h after expiry

export async function purgeExpiredTokens(): Promise<{ refresh: number; reset: number }> {
  const cutoff = new Date(Date.now() - GRACE_MS);
  const refresh = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { not: null, lt: cutoff } }],
    },
  });
  const reset = await prisma.passwordReset.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { not: null, lt: cutoff } }],
    },
  });
  if (refresh.count || reset.count) {
    console.log(`[ttl] purged ${refresh.count} refresh tokens, ${reset.count} password resets`);
  }
  return { refresh: refresh.count, reset: reset.count };
}

const HOUR_MS = 60 * 60 * 1000;

export function startTokenCleanupLoop(): void {
  void purgeExpiredTokens(); // run once at boot
  setInterval(() => {
    purgeExpiredTokens().catch((error) => console.error('[ttl] token purge failed', error));
  }, HOUR_MS);
}
