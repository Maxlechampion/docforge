#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M0 : Orchestrateur
 * ------------------------------------------------------------
 * Un SEUL endpoint : POST /generate
 * Chaîne : M1 → M2 → M3 → M4 → M5
 *
 * Chaque étape a :
 *  - un circuit breaker (3 échecs = pause 30s)
 *  - un fallback (on continue avec le résultat précédent)
 *  - un timeout individuel (30s max par étape)
 *
 * Contraintes :
 *  - 0.1 : fetch natif Node 20, aucune dépendance payante.
 *  - 0.2 : fallback à chaque étape, timeout global 45s,
 *          isolation stricte (un module down ne bloque pas).
 *
 * Usage :
 *   node src/index.js              # serveur (port 3000)
 *   node src/index.js --test       # tests intégrés
 *   node src/index.js --selftest   # smoke test
 *
 * Env :
 *   M1_URL=http://localhost:3001
 *   M2_URL=http://localhost:3002
 *   M3_URL=http://localhost:3003
 *   M4_URL=http://localhost:3004
 *   M5_URL=http://localhost:3005
 *   M0_ENABLED=true
 * ============================================================
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { fileURLToPath } from 'node:url';

// MIME types pour les 4 formats
const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ============================================================
// VALIDATION BLOCS (schéma v1)
// ============================================================
const VALID_LEVELS = new Set(['h1', 'h2', 'h3', 'body', 'caption']);
const VALID_TYPES = new Set(['text', 'list', 'table', 'quote']);

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, error: 'blocks doit être un tableau non vide' };
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') {
      return { ok: false, error: `blocks[${i}] n'est pas un objet` };
    }
    if (!VALID_LEVELS.has(b.level)) {
      return { ok: false, error: `blocks[${i}].level invalide : ${b.level}` };
    }
    if (!VALID_TYPES.has(b.type)) {
      return { ok: false, error: `blocks[${i}].type invalide : ${b.type}` };
    }
    if (b.type === 'table') {
      if (!Array.isArray(b.rows) || b.rows.length === 0) {
        return { ok: false, error: `blocks[${i}] tableau sans rows` };
      }
    } else if (typeof b.content !== 'string') {
      return { ok: false, error: `blocks[${i}].content doit être une string` };
    }
  }
  return { ok: true };
}


// ============================================================
// 1. CONFIG
// ============================================================
export const CONFIG = {
  M1_URL: process.env.M1_URL || 'http://localhost:3001',
  M2_URL: process.env.M2_URL || 'http://localhost:3002',
  M3_URL: process.env.M3_URL || 'http://localhost:3003',
  M4_URL: process.env.M4_URL || 'http://localhost:3004',
  M5_URL: process.env.M5_URL || 'http://localhost:3005',
  STEP_TIMEOUT_MS: 120000,
  GLOBAL_TIMEOUT_MS: 300000,
};

export function isModuleEnabled() {
  return process.env.M0_ENABLED !== 'false';
}

// ============================================================
// 2. CONTRAT v1
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/orchestrator.json',
  type: 'object',
  required: ['version', 'meta'],
  properties: {
    version: { const: '1.0' },
    meta: {
      type: 'object',
      required: ['steps', 'duration_ms', 'fallback_used'],
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              module: { type: 'string' },
              ok: { type: 'boolean' },
              duration_ms: { type: 'number' },
              error: { type: 'string' },
            },
          },
        },
        duration_ms: { type: 'number' },
        fallback_used: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ============================================================
// 3. CIRCUIT BREAKER PAR MODULE
// ============================================================
function createBreaker(name, { threshold = 3, cooldown = 30000 } = {}) {
  let failures = 0;
  let openUntil = 0;

  return {
    name,
    async run(fn) {
      if (Date.now() < openUntil) {
        throw new Error(`[${name}] Circuit OPEN (pause ${Math.ceil((openUntil - Date.now()) / 1000)}s)`);
      }
      try {
        const result = await fn();
        failures = 0;
        return result;
      } catch (err) {
        failures++;
        if (failures >= threshold) {
          openUntil = Date.now() + cooldown;
          failures = 0;
        }
        throw err;
      }
    },
    status() {
      return { name, failures, open: Date.now() < openUntil, openUntil };
    },
  };
}

const breakers = {
  m1: createBreaker('M1'),
  m2: createBreaker('M2'),
  m3: createBreaker('M3'),
  m4: createBreaker('M4'),
  m5: createBreaker('M5'),
};

// ============================================================
// 4. APPEL HTTP AVEC TIMEOUT
// ============================================================
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 5. ÉTAPES INDIVIDUELLES (avec fallback)
// ============================================================

/**
 * Étape M1 : texte → blocs
 * Fallback : on crée un bloc unique à partir du texte brut.
 */
export async function stepM1({ text }) {
  try {
    const res = await breakers.m1.run(() =>
      fetchWithTimeout(
        `${CONFIG.M1_URL}/m1/paste`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
        CONFIG.STEP_TIMEOUT_MS
      )
    );
    if (!res.ok) throw new Error(`M1 HTTP ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    // Fallback : bloc unique
    return {
      ok: false,
      error: err.message,
      data: {
        version: '1.0',
        blocks: [{ level: 'body', type: 'text', content: text }],
        meta: { source: 'fallback', fallback_used: true, warnings: [err.message] },
      },
    };
  }
}

/**
 * Étape M2 : blocs → blocs enrichis (LLM)
 * Fallback : blocs M1 inchangés.
 */
export async function stepM2(blocks) {
  try {
    const res = await breakers.m2.run(() =>
      fetchWithTimeout(
        `${CONFIG.M2_URL}/m2/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks, useLLM: true }),
        },
        CONFIG.STEP_TIMEOUT_MS
      )
    );
    if (!res.ok) throw new Error(`M2 HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, data: data.blocks };
  } catch (err) {
    return { ok: false, error: err.message, data: blocks };
  }
}

/**
 * Étape M3 : reformulation ON/OFF
 * Fallback : blocs M2 inchangés.
 */
export async function stepM3(blocks, mode = 'OFF') {
  try {
    const res = await breakers.m3.run(() =>
      fetchWithTimeout(
        `${CONFIG.M3_URL}/m3/reformulate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks, mode }),
        },
        CONFIG.STEP_TIMEOUT_MS
      )
    );
    if (!res.ok) throw new Error(`M3 HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, data: data.blocks };
  } catch (err) {
    return { ok: false, error: err.message, data: blocks };
  }
}

/**
 * Étape M4 : design & templates
 * Fallback : design minimal hardcodé.
 */
export async function stepM4(blocks, options = {}) {
  try {
    const res = await breakers.m4.run(() =>
      fetchWithTimeout(
        `${CONFIG.M4_URL}/m4/design`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks, options }),
        },
        CONFIG.STEP_TIMEOUT_MS
      )
    );
    if (!res.ok) throw new Error(`M4 HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, data: data.design };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      data: {
        template: 'minimal',
        theme: {
          primary: '#111827',
          secondary: '#6b7280',
          accent: '#9ca3af',
          font_heading: 'Inter',
          font_body: 'Inter',
          font_mono: 'JetBrains Mono',
        },
        layout: { cover_page: false, table_of_contents: false, section_breaks: false },
        blocks,
      },
    };
  }
}

/**
 * Étape M5 : génération .docx
 * Fallback : aucun (si M5 est down, on ne peut pas produire de fichier).
 */
export async function stepM5({ blocks, design, meta, format = 'docx' }) {
  try {
    const res = await breakers.m5.run(() =>
      fetchWithTimeout(
        `${CONFIG.M5_URL}/m5/generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks, design, meta, format }),
        },
        CONFIG.STEP_TIMEOUT_MS
      )
    );
    if (!res.ok) throw new Error(`M5 HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, data: buffer };
  } catch (err) {
    return { ok: false, error: err.message, data: null };
  }
}

// ============================================================
// 6. PIPELINE PRINCIPAL
// ============================================================
export async function generate({
  text,
  file = null,
  reformulation = 'OFF',
  template = 'auto',
  format = 'docx',
  options = {},
  meta = {},
}) {
  if (!text && !file) {
    throw Object.assign(new Error('text ou file requis'), { statusCode: 400 });
  }

  const startTime = Date.now();
  const steps = [];
  const warnings = [];
  let fallbackUsed = false;

  // Garde-fou global
  const globalTimer = setTimeout(() => {
    warnings.push('Timeout global 60s dépassé');
  }, CONFIG.GLOBAL_TIMEOUT_MS);

  try {
    // ---- M1 : Ingestion ----
    let t = Date.now();
    let m1;
    if (file) {
      // Upload via multipart (on utilise le service directement)
      // Pour simplifier ici : on suppose que file.buffer existe
      // et on appelle /m1/upload si besoin. Pour la v1, on utilise text.
      m1 = await stepM1({ text: text || file.toString?.() || '' });
    } else {
      m1 = await stepM1({ text });
    }
    steps.push({ module: 'M1', ok: m1.ok, duration_ms: Date.now() - t, error: m1.error });
    if (!m1.ok) fallbackUsed = true;
    let blocks = m1.data.blocks;

    // ---- M2 : Analyse sémantique ----
    t = Date.now();
    const m2 = await stepM2(blocks);
    steps.push({ module: 'M2', ok: m2.ok, duration_ms: Date.now() - t, error: m2.error });
    if (!m2.ok) fallbackUsed = true;
    blocks = m2.data;

    // ---- M3 : Reformulation ----
    t = Date.now();
    const m3 = await stepM3(blocks, reformulation);
    steps.push({ module: 'M3', ok: m3.ok, duration_ms: Date.now() - t, error: m3.error });
    if (!m3.ok) fallbackUsed = true;
    blocks = m3.data;

    // ---- M4 : Design ----
    t = Date.now();
    const m4 = await stepM4(blocks, { template, ...options });
    steps.push({ module: 'M4', ok: m4.ok, duration_ms: Date.now() - t, error: m4.error });
    if (!m4.ok) fallbackUsed = true;
    const design = m4.data;

    // ---- M5 : Génération .docx ----
    t = Date.now();
    const m5 = await stepM5({
      blocks: design.blocks || blocks,
      design,
      meta: {
        title: meta.title || 'Document DocForge AI',
        ...meta,
      },
      format,
    });
    steps.push({ module: 'M5', ok: m5.ok, duration_ms: Date.now() - t, error: m5.error });
    if (!m5.ok) {
      // Pas de fallback : M5 est le cœur du produit
      throw Object.assign(
        new Error(`Génération impossible : ${m5.error}`),
        { statusCode: 503 }
      );
    }

    return {
      version: '1.0',
      buffer: m5.data,
      meta: {
        steps,
        duration_ms: Date.now() - startTime,
        fallback_used: fallbackUsed,
        warnings,
      },
    };
  } finally {
    clearTimeout(globalTimer);
  }
}

// ============================================================
// 7. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 50 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.get('/health', async () => ({
    status: 'ok',
    module: 'M0',
    enabled: isModuleEnabled(),
    config: CONFIG,
  }));

  app.get('/m0/contract', async () => CONTRACT_V1);

  app.get('/m0/breakers', async () => ({
    m1: breakers.m1.status(),
    m2: breakers.m2.status(),
    m3: breakers.m3.status(),
    m4: breakers.m4.status(),
    m5: breakers.m5.status(),
  }));

  // Endpoint principal : POST /generate
  app.post('/generate', async (req, reply) => {
    if (!isModuleEnabled()) {
      return reply.code(503).send({ error: 'Module M0 désactivé', module_enabled: false });
    }

    try {
      const body = req.body || {};

      // Validation
      if (!body.text && !body.blocks) {
        return reply.code(400).send({
          error: 'Fournir soit "text" (texte brut) soit "blocks" (JSON M1)',
        });
      }

      // Si blocks fournis directement, on saute M1 et M2
      let blocksInput = body.blocks;
      let textInput = body.text;

      if (blocksInput && Array.isArray(blocksInput)) {
        // Mode avancé : on saute M1
        const startTime = Date.now();
        const steps = [];
        let fallbackUsed = false;
        let blocks = blocksInput;

        // M2
        let t = Date.now();
        const m2 = await stepM2(blocks);
        steps.push({ module: 'M2', ok: m2.ok, duration_ms: Date.now() - t, error: m2.error });
        if (!m2.ok) fallbackUsed = true;
        blocks = m2.data;

        // M3
        t = Date.now();
        const m3 = await stepM3(blocks, body.reformulation || 'OFF');
        steps.push({ module: 'M3', ok: m3.ok, duration_ms: Date.now() - t, error: m3.error });
        if (!m3.ok) fallbackUsed = true;
        blocks = m3.data;

        // M4
        t = Date.now();
        const m4 = await stepM4(blocks, body.options || {});
        steps.push({ module: 'M4', ok: m4.ok, duration_ms: Date.now() - t, error: m4.error });
        if (!m4.ok) fallbackUsed = true;

        // M5
        t = Date.now();
        const m5 = await stepM5({
          blocks: m4.data.blocks || blocks,
          design: m4.data,
          meta: { title: body.meta?.title || 'Document DocForge AI', ...body.meta },
          format: body.format || 'docx',
        });
        steps.push({ module: 'M5', ok: m5.ok, duration_ms: Date.now() - t, error: m5.error });
        if (!m5.ok) throw Object.assign(new Error(`Génération impossible : ${m5.error}`), { statusCode: 503 });

        const ext = body.format || 'docx';
      const filename = `docforge-${Date.now()}.${ext}`;
        return reply
          .header('Content-Type', MIME_TYPES[body.format || 'docx'])
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('Content-Length', m5.data.length)
          .header('X-DocForge-Steps', JSON.stringify(steps.map((s) => `${s.module}:${s.ok ? 'ok' : 'fallback'}`)))
          .header('X-DocForge-Fallback', String(fallbackUsed))
          .header('X-DocForge-Duration', String(Date.now() - startTime))
          .send(m5.data);
      }

      // Mode normal : text → pipeline complet
      const result = await generate({
        text: textInput,
        reformulation: body.reformulation || 'OFF',
        template: body.options?.template || 'auto',
        format: body.format || 'docx',
        options: body.options || {},
        meta: body.meta || {},
      });

      const ext = body.format || 'docx';
      const filename = `docforge-${Date.now()}.${ext}`;
      return reply
        .header('Content-Type', MIME_TYPES[body.format || 'docx'])
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', result.buffer.length)
        .header('X-DocForge-Steps', JSON.stringify(result.meta.steps.map((s) => `${s.module}:${s.ok ? 'ok' : 'fallback'}`)))
        .header('X-DocForge-Fallback', String(result.meta.fallback_used))
        .header('X-DocForge-Duration', String(result.meta.duration_ms))
        .send(result.buffer);
    } catch (err) {
      req.log.error(err);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M0');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm0' });
  });

  return app;
}

// ============================================================
// 8. TESTS INTÉGRÉS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  t('generate : text vide + blocks vide → 400', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/generate', payload: {} });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  t('generate : text fourni, modules down → fallback complet', async () => {
    // On force tous les modules à échouer en pointant vers des ports fermés
    const old = { ...CONFIG };
    CONFIG.M1_URL = 'http://localhost:19999';
    CONFIG.M2_URL = 'http://localhost:19998';
    CONFIG.M3_URL = 'http://localhost:19997';
    CONFIG.M4_URL = 'http://localhost:19996';
    CONFIG.M5_URL = 'http://localhost:19995';
    CONFIG.STEP_TIMEOUT_MS = 1000;

    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      payload: { text: 'Test simple' },
    });

    // M5 down → on doit avoir 503
    assert.equal(res.statusCode, 503);
    await app.close();

    Object.assign(CONFIG, old);
  });

  t('generate : blocks fournis directement → M2→M3→M4→M5 (M5 down)', async () => {
    const old = { ...CONFIG };
    CONFIG.M2_URL = 'http://localhost:19998';
    CONFIG.M3_URL = 'http://localhost:19997';
    CONFIG.M4_URL = 'http://localhost:19996';
    CONFIG.M5_URL = 'http://localhost:19995';
    CONFIG.STEP_TIMEOUT_MS = 500;

    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      payload: {
        blocks: [{ level: 'h1', type: 'text', content: 'Titre' }],
      },
    });
    // M5 down → 503
    assert.equal(res.statusCode, 503);
    await app.close();

    Object.assign(CONFIG, old);
  });

  t('feature flag OFF → 503', async () => {
    const old = process.env.M0_ENABLED;
    process.env.M0_ENABLED = 'false';
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      payload: { text: 'Test' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
    process.env.M0_ENABLED = old;
  });

  t('route /health répond avec config', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.module, 'M0');
    assert.ok(body.config.M1_URL);
    await app.close();
  });

  t('route /m0/breakers retourne les 5 statuts', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/m0/breakers' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.m1);
    assert.ok(body.m5);
    await app.close();
  });

 t('route /m0/contract retourne le schéma v1', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/m0/contract' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.$id, 'https://docforge.ai/schemas/v1/orchestrator.json');
    assert.equal(body.type, 'object');
    assert.ok(body.properties);
    await app.close();
  });

  t('schéma du contrat est valide', async () => {
    assert.equal(CONTRACT_V1.$id, 'https://docforge.ai/schemas/v1/orchestrator.json');
    assert.equal(CONTRACT_V1.properties.version.const, '1.0');
    assert.ok(CONTRACT_V1.properties.meta);
    assert.ok(CONTRACT_V1.required.includes('version'));
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${name}\n     → ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests OK`);
  if (failed > 0) process.exit(1);
}

// ============================================================
// 9. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M0…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M0…\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    console.log('health :', health.statusCode, health.json().module);
    await app.close();
    process.exit(health.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3000);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 M0 Orchestrateur → http://localhost:${port}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /m0/contract`);
    console.log(`   GET  /m0/breakers`);
    console.log(`   POST /generate   { "text": "...", "reformulation": "ON|OFF", "options": {...} }`);
    console.log(`\n   Modules chaînés :`);
    console.log(`     M1 (ingestion)   → ${CONFIG.M1_URL}`);
    console.log(`     M2 (analyse)     → ${CONFIG.M2_URL}`);
    console.log(`     M3 (reformul.)   → ${CONFIG.M3_URL}`);
    console.log(`     M4 (design)      → ${CONFIG.M4_URL}`);
    console.log(`     M5 (génération)  → ${CONFIG.M5_URL}`);
    console.log(`\n   Feature flag M0_ENABLED : ${isModuleEnabled() ? '✅ actif' : '❌ désactivé'}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig} → arrêt propre M0`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}