import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, reformulate, reformulateOff } from '../src/index.js';

test('m3 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M3');
  await app.close();
});

test('m3 — mode OFF : passe-plat pur', async () => {
  const blocks = [
    { level: 'body', type: 'text', content: 'Texte inchangé.' },
    { level: 'body', type: 'table', content: '', rows: [['A', '1']] },
  ];
  const res = await reformulate({ blocks, mode: 'OFF' });
  assert.equal(res.meta.mode, 'OFF');
  assert.equal(res.meta.llm_used, false);
  assert.deepEqual(res.blocks, blocks);
});

test('m3 — reformulateOff préserve les tableaux', () => {
  const input = [{ level: 'body', type: 'table', content: '', rows: [['X', 'Y']] }];
  const out = reformulateOff(input);
  assert.deepEqual(out[0].rows, [['X', 'Y']]);
});

test('m3 — mode invalide → 400', async () => {
  await assert.rejects(
    () => reformulate({ blocks: [{ level: 'body', type: 'text', content: 'x' }], mode: 'MAYBE' }),
    /mode doit être/
  );
});
