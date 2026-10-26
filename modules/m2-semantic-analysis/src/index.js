#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M2 : Analyse sémantique
 * ------------------------------------------------------------
 * Reçoit les blocs bruts (M1) et les enrichit sémantiquement
 * via Groq (LLM) + fallback heuristique pur JS.
 *
 * Contraintes :
 *  - 0.1 : Groq free tier (gratuit, sans CB).
 *  - 0.2 : isolation (timeout, circuit breaker, fallback).
 *
 * Usage :
 *   node src/index.js              # serveur (port 3002)
 *   node src/index.js --test       # tests intégrés
 *   node src/index.js --selftest   # smoke test
 *
 * Env :
 *   GROQ_API_KEY=gsk_...           # optionnel (fallback sinon)
 *   GROQ_MODEL=llama-3.3-70b-versatile
 * ============================================================
 */
import { chunkBlocks } from '@docforge/shared-llm-chunking';
import cors from '@fastify/cors';
import 'dotenv/config';
import Fastify from 'fastify';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'node:url';

// ============================================================
// 1. CONTRAT v1
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/semantic-analysis.json',
  type: 'object',
  required: ['version', 'blocks', 'meta'],
  properties: {
    version: { const: '1.0' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['level', 'type', 'content'],
        properties: {
          level: { enum: ['h1', 'h2', 'h3', 'body', 'caption'] },
          type: { enum: ['text', 'list', 'table', 'quote'] },
          content: { type: 'string' },
          rows: { type: 'array', items: { type: 'array' } },
        },
      },
    },
    meta: {
      type: 'object',
      required: ['llm_used', 'fallback_used', 'model'],
      properties: {
        llm_used: { type: 'boolean' },
        fallback_used: { type: 'boolean' },
        model: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ============================================================
// 2. CLIENT GROQ (lazy)
// ============================================================
let groqClient = null;

function getGroqClient() {
  if (groqClient) return groqClient;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  groqClient = new Groq({ apiKey, timeout: 20000, maxRetries: 1 });
  return groqClient;
}

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// ============================================================
// 3. PROMPT SYSTÈME
// ============================================================
const SYSTEM_PROMPT = `Tu es un moteur de structuration documentaire de haut niveau, expert en rédaction professionnelle et en mise en page éditoriale. Ton rôle est de transformer un texte brut en une structure JSON parfaite pour un rapport de direction.

RÈGLES ABSOLUES (à ne jamais enfreindre) :
1. ZÉRO INVENTION : Tu ne dois jamais inventer de chiffres, de noms ou de faits.
2. ZÉRO SUPPRESSION : Tu ne dois JAMAIS supprimer ou modifier le texte original. Le contenu de chaque bloc doit être conservé mot pour mot.
3. ATTRIBUTION DES NIVEAUX : h1 pour les titres principaux, h2 pour les sections, h3 pour les sous-sections, body pour le texte courant, caption pour les légendes.
4. AJOUT DE TABLEAUX RÉCAPITULATIFS (IMPORTANT) :
   - Si un bloc de type "text" contient 2 indicateurs chiffrés ou plus (ex: "CA de 15M, bénéfice de 3M, 12 employés"), tu DOIS :
     a) GARDER le bloc "text" original INTACT (ne rien supprimer, ne rien reformuler).
     b) AJOUTER juste après un NOUVEAU bloc de type "table" qui récapitule ces chiffres.
   - Le tableau doit avoir les colonnes ["Indicateur", "Valeur"].
   - Ne crée un tableau QUE si tu identifies au moins 2 indicateurs chiffrés distincts.
   - Si un bloc contient déjà des lignes "Clé : Valeur", transforme-le en tableau (dans ce cas, le texte original est déjà structuré, donc pas besoin de le dupliquer).
5. ORDRE : Conserve l'ordre logique des blocs. Un tableau ajouté doit venir immédiatement APRÈS le bloc de texte dont il récapitule les chiffres.
6. SORTIE : JSON strict, aucun texte avant/après.

EXEMPLE DE TRANSFORMATION (ajout sans suppression) :
- Entrée : "Le chiffre d'affaires est de 15M, le bénéfice de 3M et nous avons 12 employés."
- Sortie :
  { "level": "body", "type": "text", "content": "Le chiffre d'affaires est de 15M, le bénéfice de 3M et nous avons 12 employés." },
  { "level": "body", "type": "table", "content": "", "rows": [["Indicateur", "Valeur"], ["Chiffre d'affaires", "15M"], ["Bénéfice", "3M"], ["Employés", "12"]] }

FORMAT DE SORTIE :
{
  "blocks": [
    { "level": "h1", "type": "text", "content": "..." },
    { "level": "body", "type": "text", "content": "..." },
    { "level": "body", "type": "table", "content": "", "rows": [["Indicateur", "Valeur"], ["CA", "15M"]] }
  ]
}`;

// ============================================================
// 4. FALLBACK HEURISTIQUE
// ============================================================
export function analyzeWithHeuristics(blocks) {
  const out = [];
  for (const block of blocks) {
    const content = String(block.content || '').trim();
    if (!content) continue;

    let level = block.level || 'body';
    let type = block.type || 'text';

    // Re-classification légère
    if (/^(titre|title|chapitre|section)\b/i.test(content)) level = 'h1';
    else if (/^(sous-titre|subsection)\b/i.test(content)) level = 'h2';
    else if (content.length < 80 && content === content.toUpperCase() && /[A-Z]/.test(content)) level = 'h2';
    else if (content.length < 120 && !/[.!?]$/.test(content) && content.split(' ').length <= 10) level = 'h2';

    // Détection tableau clé:valeur (≥2 lignes cohérentes)
    const lines = content.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const kvLines = lines.filter((l) => /^[^:]{2,40}:\s*.+$/.test(l));
    if (kvLines.length >= 2 && kvLines.length === lines.length) {
      const rows = lines.map((l) => {
        const idx = l.indexOf(':');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      });
      out.push({ level, type: 'table', content: '', rows });
      continue;
    }

    if (/^[-*•]\s+/.test(content) || /^\d+[.)]\s+/.test(content)) type = 'list';
    else if (/^["«"].*["»]$/.test(content)) type = 'quote';

    out.push({ level, type, content });
  }
  return out;
}

// ============================================================
// 5. ANALYSE VIA GROQ
// ============================================================
export async function analyzeWithGroq(blocks) {
  const client = getGroqClient();
  if (!client) throw new Error('GROQ_API_KEY manquante');

  // Chunking : on découpe en batches de ~6000 tokens
  const batches = chunkBlocks(blocks, { maxTokensPerBatch: 6000 });
  const allBlocks = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            blocks: batch,
            context: `Batch ${i + 1}/${batches.length} — traite UNIQUEMENT ces ${batch.length} blocs.`,
          }),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Groq : réponse non-JSON sur batch ${i + 1}`);
    }
    if (!Array.isArray(parsed.blocks)) {
      throw new Error(`Groq : "blocks" manquant sur batch ${i + 1}`);
    }

    // Vérification critique : le batch doit contenir TOUS ses blocs (sauf si tables ajoutées)
    // On accepte parsed.blocks.length >= batch.length (M2 peut ajouter des tableaux récapitulatifs)
    if (parsed.blocks.length < batch.length) {
      throw new Error(
        `Groq a produit ${parsed.blocks.length} blocs sur batch ${i + 1} au lieu de ${batch.length} minimum`
      );
    }

    allBlocks.push(...parsed.blocks);
  }

  return allBlocks;
}

// ============================================================
// 6. CIRCUIT BREAKER
// ============================================================
function createBreaker(fn, { timeout = 25000, threshold = 3, cooldown = 30000 } = {}) {
  let failures = 0;
  let openUntil = 0;

  return {
    async fire(...args) {
      if (Date.now() < openUntil) {
        throw new Error('Circuit breaker OPEN');
      }
      try {
        const result = await Promise.race([
          fn(...args),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout ${timeout}ms`)), timeout)
          ),
        ]);
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
    _status() {
      return { failures, open: Date.now() < openUntil, openUntil };
    },
  };
}

const groqBreaker = createBreaker(analyzeWithGroq, { timeout: 120000 }); // 2 min

// ============================================================
// 7. SERVICE PRINCIPAL
// ============================================================
export async function analyze({ blocks, useLLM = true }) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw Object.assign(new Error('blocks[] requis et non vide'), { statusCode: 400 });
  }

  const warnings = [];
  let finalBlocks = null;
  let llmUsed = false;
  let fallbackUsed = false;

  if (useLLM && process.env.GROQ_API_KEY) {
    try {
      finalBlocks = await groqBreaker.fire(blocks);
      llmUsed = true;
    } catch (err) {
      warnings.push(`Groq indisponible : ${err.message}`);
      fallbackUsed = true;
    }
  } else {
    if (!process.env.GROQ_API_KEY) warnings.push('GROQ_API_KEY absente');
    fallbackUsed = true;
  }

  if (!llmUsed) finalBlocks = analyzeWithHeuristics(blocks);

  return {
    version: '1.0',
    blocks: finalBlocks,
    meta: {
      llm_used: llmUsed,
      fallback_used: fallbackUsed,
      model: llmUsed ? DEFAULT_MODEL : 'heuristic',
      warnings,
    },
  };
}

// ============================================================
// 8. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger });
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ status: 'ok', module: 'M2' }));
  app.get('/m2/contract', async () => CONTRACT_V1);
  app.get('/m2/breaker', async () => groqBreaker._status());

  app.post(
    '/m2/analyze',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blocks'],
          properties: {
            blocks: { type: 'array', minItems: 1 },
            useLLM: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await analyze(req.body);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }
    }
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M2');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm2' });
  });

  return app;
}

// ============================================================
// 9. TESTS INTÉGRÉS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');

  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  t('heuristique : H1 et listes', async () => {
    const out = analyzeWithHeuristics([
      { level: 'h1', type: 'text', content: 'Titre' },
      { level: 'body', type: 'list', content: '- a' },
    ]);
    assert.equal(out[0].level, 'h1');
    assert.equal(out[1].type, 'list');
  });

  t('heuristique : tableau clé:valeur', async () => {
    const out = analyzeWithHeuristics([
      { level: 'body', type: 'text', content: 'Nom : Alice\nÂge : 30\nVille : Cotonou' },
    ]);
    assert.equal(out[0].type, 'table');
    assert.equal(out[0].rows.length, 3);
    assert.deepEqual(out[0].rows[0], ['Nom', 'Alice']);
  });

  t('analyze : blocks vide → 400', async () => {
    await assert.rejects(() => analyze({ blocks: [] }), /blocks\[\] requis/);
  });

  t('analyze sans clé Groq → fallback', async () => {
    const old = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await analyze({ blocks: [{ level: 'h1', type: 'text', content: 'T' }] });
    assert.equal(res.meta.fallback_used, true);
    assert.equal(res.meta.llm_used, false);
    assert.equal(res.meta.model, 'heuristic');
    if (old) process.env.GROQ_API_KEY = old;
  });

  t('route /m2/analyze respecte le contrat', async () => {
    const old = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m2/analyze',
      payload: { blocks: [{ level: 'h1', type: 'text', content: 'Test' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.version, '1.0');
    assert.ok(Array.isArray(body.blocks));
    assert.ok(body.meta);
    await app.close();
    if (old) process.env.GROQ_API_KEY = old;
  });

  t('route /health répond', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().module, 'M2');
    await app.close();
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
// 10. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M2…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M2…\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    const analyzeRes = await app.inject({
      method: 'POST',
      url: '/m2/analyze',
      payload: { blocks: [{ level: 'h1', type: 'text', content: 'Titre' }] },
    });
    console.log('health  :', health.statusCode, health.json());
    console.log('analyze :', analyzeRes.statusCode, '→', analyzeRes.json().meta);
    await app.close();
    process.exit(health.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3002);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 M2 Analyse sémantique → http://localhost:${port}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /m2/contract`);
    console.log(`   GET  /m2/breaker`);
    console.log(`   POST /m2/analyze  { "blocks": [...], "useLLM": true }`);
    if (!process.env.GROQ_API_KEY) {
      console.log(`\n⚠️  GROQ_API_KEY absente → fallback heuristique actif`);
      console.log(`   Clé gratuite : https://console.groq.com`);
    } else {
      console.log(`\n✅ Groq configuré (modèle : ${DEFAULT_MODEL})`);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig} → arrêt propre M2`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}