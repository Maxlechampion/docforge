import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, analyzeWithHeuristics } from '../src/index.js';

test('m2 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M2');
  await app.close();
});

test('m2 — heuristique : H1 préservé', async () => {
  const out = analyzeWithHeuristics([
    { level: 'h1', type: 'text', content: 'Titre' },
  ]);
  assert.equal(out[0].level, 'h1');
});

test('m2 — heuristique : détection tableau clé:valeur', async () => {
  const out = analyzeWithHeuristics([
    { level: 'body', type: 'text', content: 'Nom : Alice\nÂge : 30\nVille : Cotonou' },
  ]);
  assert.equal(out[0].type, 'table');
  assert.equal(out[0].rows.length, 3);
  assert.deepEqual(out[0].rows[0], ['Nom', 'Alice']);
});

test('m2 — /m2/analyze blocks vide → 400', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST', url: '/m2/analyze', payload: { blocks: [] },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});
