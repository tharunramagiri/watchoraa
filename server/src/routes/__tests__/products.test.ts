import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { ProductInfo } from '../products.js';

process.env.DATABASE_URL ||= 'postgresql://suhasitarani@localhost:5432/blindnav';
process.env.CORS_ORIGIN ||= 'http://127.0.0.1:4173';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let app: Express;
const suffix = Date.now();
const userEmail = `products-${suffix}@example.com`;
let userToken = '';
let userId = '';

const FAKE_PRODUCT: ProductInfo = {
  found: true,
  name: 'Test Chocolate Bar 100g',
  brand: 'TestBrand',
  quantity: '100 g',
  allergens: ['en:milk', 'en:nuts'],
};

// Injectable provider: counts calls so cache behavior is observable.
let providerCalls = 0;
const fakeProvider = async (barcode: string): Promise<ProductInfo> => {
  providerCalls += 1;
  if (barcode === '0000000000000') return { found: false };
  if (barcode === '9999999999999') throw new Error('upstream down');
  return FAKE_PRODUCT;
};

beforeAll(async () => {
  const { createApp } = await import('../../app.js');
  const { makeProductsRouter } = await import('../products.js');
  const { apiRouter } = await import('../index.js');
  // Mount the injectable-provider router under a test path.
  apiRouter.use('/products-test', makeProductsRouter(fakeProvider));
  app = createApp();
  const { prisma } = await import('../../lib/prisma.js');
  const { signToken } = await import('../../lib/auth.js');
  const user = await prisma.user.create({ data: { email: userEmail, passwordHash: 'x', fullName: 'Products User', role: 'BLIND_USER' } });
  userId = user.id;
  userToken = signToken({ sub: user.id, email: user.email });
});

afterAll(async () => {
  const { prisma } = await import('../../lib/prisma.js');
  await prisma.auditLog.deleteMany({ where: { actorId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('GET /api/products-test/:barcode', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/products-test/3017620422003');
    expect(res.status).toBe(401);
  });

  it('rejects non-numeric or wrong-length barcodes', async () => {
    const bad = await request(app).get('/api/products-test/abc').set('Authorization', `Bearer ${userToken}`);
    expect(bad.status).toBe(400);
    const short = await request(app).get('/api/products-test/123').set('Authorization', `Bearer ${userToken}`);
    expect(short.status).toBe(400);
  });

  it('returns product info once, then serves a cached copy without re-calling the provider', async () => {
    const first = await request(app).get('/api/products-test/3017620422003').set('Authorization', `Bearer ${userToken}`);
    expect(first.status).toBe(200);
    expect(first.body.product.name).toContain('Chocolate');
    expect(first.body.cached).toBe(false);

    const second = await request(app).get('/api/products-test/3017620422003').set('Authorization', `Bearer ${userToken}`);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    expect(providerCalls).toBe(1);
  });

  it('reports not-found honestly', async () => {
    const res = await request(app).get('/api/products-test/0000000000000').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.product.found).toBe(false);
  });

  it('fails with 502 (not fabricated data) when the upstream provider errors', async () => {
    const res = await request(app).get('/api/products-test/9999999999999').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('not reachable');
  });
});
