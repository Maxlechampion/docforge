import { test } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

test('m3-reformulation — health check répond', async () => {
  // Test placeholder : à remplacer par les vraies routes du module
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  await app.close();
});
