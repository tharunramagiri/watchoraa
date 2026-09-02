import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.DATABASE_URL ||= 'postgresql://suhasitarani@localhost:5432/blindnav';
process.env.CORS_ORIGIN ||= 'http://127.0.0.1:4173';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let app: Express;
const suffix = Date.now();
const userEmail = `things-${suffix}@example.com`;
let userToken = '';
let userId = '';
let thingId = '';

beforeAll(async () => {
  const { createApp } = await import('../../app.js');
  app = createApp();
  const { prisma } = await import('../../lib/prisma.js');
  const { signToken } = await import('../../lib/auth.js');
  const user = await prisma.user.create({ data: { email: userEmail, passwordHash: 'x', fullName: 'Things User', role: 'BLIND_USER' } });
  userId = user.id;
  userToken = signToken({ sub: user.id, email: user.email });
});

afterAll(async () => {
  const { prisma } = await import('../../lib/prisma.js');
  await prisma.taughtThing.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('Find-my-things API', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/things');
    expect(res.status).toBe(401);
  });

  it('teaches a thing and returns it', async () => {
    const res = await request(app)
      .post('/api/things')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Red Water Bottle', description: 'A tall red metal bottle with a black cap' });
    expect(res.status).toBe(201);
    expect(res.body.thing.name).toBe('Red Water Bottle');
    thingId = res.body.thing.id;
  });

  it('re-teaching the same name updates instead of duplicating', async () => {
    const res = await request(app)
      .post('/api/things')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'red water bottle', description: 'updated description with a sticker' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const list = await request(app).get('/api/things').set('Authorization', `Bearer ${userToken}`);
    expect(list.body.things.filter((t: { name: string }) => t.name.toLowerCase() === 'red water bottle').length).toBe(1);
  });

  it('searches case-insensitively with exact matches first', async () => {
    await request(app)
      .post('/api/things')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'White Cane Case', description: 'folding cane pouch' });
    const res = await request(app).get('/api/things?q=RED%20%20WATER').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.things[0]?.name).toBe('Red Water Bottle');
  });

  it('deletes own things but not other users', async () => {
    const del = await request(app).delete(`/api/things/${thingId}`).set('Authorization', `Bearer ${userToken}`);
    expect(del.status).toBe(204);
    const gone = await request(app).get(`/api/things`).set('Authorization', `Bearer ${userToken}`);
    expect(gone.body.things.some((t: { id: string }) => t.id === thingId)).toBe(false);
  });

  it('validates input', async () => {
    const bad = await request(app).post('/api/things').set('Authorization', `Bearer ${userToken}`).send({ name: '', description: '' });
    expect(bad.status).toBe(400);
  });
});
