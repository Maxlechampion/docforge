import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, generate } from '../src/index.js';

const sampleDesign = {
  template: 'consulting',
  theme: { primary: '#1e40af', secondary: '#64748b', accent: '#0ea5e9',
           font_heading: 'Inter', font_body: 'Inter', font_mono: 'JetBrains Mono' },
  layout: { cover_page: true, table_of_contents: true, section_breaks: true },
};

const sampleBlocks = [
  { level: 'h1', type: 'text', content: 'Titre' },
  { level: 'body', type: 'text', content: 'Paragraphe.' },
  { level: 'body', type: 'list', content: 'Point A' },
  { level: 'body', type: 'table', content: '',
    rows: [['Col A', 'Col B'], ['V1', 'V2']] },
];

test('m5 — /health répond avec 4 formats', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().formats, ['docx', 'pdf', 'xlsx', 'pptx']);
  await app.close();
});

test('m5 — DOCX signature ZIP', async () => {
  const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, format: 'docx' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
});

test('m5 — PDF signature %PDF', async () => {
  const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, format: 'pdf' });
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});

test('m5 — XLSX signature ZIP', async () => {
  const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, format: 'xlsx' });
  assert.equal(buf[0], 0x50);
});

test('m5 — PPTX signature ZIP', async () => {
  const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, format: 'pptx' });
  assert.equal(buf[0], 0x50);
});

test('m5 — format invalide → erreur', async () => {
  await assert.rejects(
    () => generate({ blocks: sampleBlocks, design: sampleDesign, format: 'exe' }),
    /non supporté/
  );
});
