import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, ingestPaste } from '../src/index.js';

test('m1-ingestion — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'm1');
  await app.close();
});

test('m1-ingestion — paste avec H1 + liste', async () => {
  const res = await ingestPaste({ text: '# Titre\n- point A\n- point B\nParagraphe.' });
  assert.equal(res.version, '1.0');
  assert.equal(res.blocks[0].level, 'h1');
  assert.equal(res.blocks[1].type, 'list');
  assert.equal(res.meta.source, 'paste');
});

test('m1-ingestion — paste vide rejette', async () => {
  await assert.rejects(() => ingestPaste({ text: '   ' }), /text requis/);
});

test('m1-ingestion — /m1/paste respecte contrat', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST', url: '/m1/paste',
    payload: { text: '# T\n- a' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.version, '1.0');
  assert.ok(Array.isArray(body.blocks));
  await app.close();
});
