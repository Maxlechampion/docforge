import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, design, TEMPLATES } from '../src/index.js';

const financeBlocks = [
  { level: 'h1', type: 'text', content: 'Bilan financier 2026' },
  { level: 'body', type: 'text', content: 'Chiffre d\'affaires : 15M FCFA.' },
];

test('m4 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M4');
  await app.close();
});

test('m4 — template consulting forcé', async () => {
  const res = await design({ blocks: financeBlocks, options: { template: 'consulting' } });
  assert.equal(res.design.template, 'consulting');
  assert.equal(res.design.theme.primary, '#1e40af');
});

test('m4 — 5 templates déclarés', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [
    'academic', 'annual-report', 'consulting', 'minimal', 'startup',
  ]);
});

test('m4 — logo préservé', async () => {
  const res = await design({
    blocks: financeBlocks,
    options: { template: 'consulting', logo: 'data:image/png;base64,xxx' },
  });
  assert.ok(res.design.logo);
  assert.equal(res.design.logo.dataUri, 'data:image/png;base64,xxx');
});
