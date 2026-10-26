#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M3 : Reformulation ON/OFF
 * ------------------------------------------------------------
 * Mode OFF : passe-plat pur (aucun appel LLM, 0 token).
 *            Garantit une fidélité absolue au texte original.
 * Mode ON  : reformulation professionnelle via Groq, avec
 *            prompt strict anti-hallucination.
 *
 * Contraintes :
 *  - 0.1 : Groq free tier.
 *  - 0.2 : feature flag, circuit breaker, fallback propre.
 *
 * Usage :
 *   node src/index.js              # serveur (port 3003)
 *   node src/index.js --test       # tests intégrés
 *   node src/index.js --selftest   # smoke test
 *
 * Env :
 *   GROQ_API_KEY=gsk_...
 *   GROQ_MODEL=openai/gpt-oss-120b
 *   M3_ENABLED=true                # feature flag
 * ============================================================
 */
import { chunkBlocks } from '@docforge/shared-llm-chunking';
import 'dotenv/config';
import Fastify from 'fastify';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';

// ============================================================
// 1. CONTRAT v1
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/reformulation.json',
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
      required: ['mode', 'llm_used', 'fallback_used', 'module_enabled'],
      properties: {
        mode: { enum: ['ON', 'OFF'] },
        llm_used: { type: 'boolean' },
        fallback_used: { type: 'boolean' },
        module_enabled: { type: 'boolean' },
        model: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ============================================================
// 2. FEATURE FLAG (désactivation à chaud — §4.3.2)
// ============================================================
export function isModuleEnabled() {
  return process.env.M3_ENABLED !== 'false';
}

// ============================================================
// 3. CLIENT GROQ (lazy)
// ============================================================
let groqClient = null;

function getGroqClient() {
  if (groqClient) return groqClient;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  groqClient = new Groq({ apiKey, timeout: 25000, maxRetries: 1 });
  return groqClient;
}

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

// ============================================================
// 4. PROMPT SYSTÈME (reformulation strictement contrôlée)
// ============================================================
const REFORMULATION_PROMPT = `Tu es un éditeur littéraire professionnel francophone, expert en rédaction de rapports de direction, de livres blancs et de documents institutionnels. Ta mission est de réécrire un texte brut pour en faire un texte d'excellence, tout en respectant scrupuleusement son esprit, ses faits et ses chiffres.
RÈGLE 0 — NETTOYAGE DES SYMBOLES MARKDOWN :
Le texte peut contenir des artefacts de copier-coller : **gras**, *italique*, # titres, --- séparateurs, [liens](url), emojis, ● puces. TU DOIS les ignorer complètement et produire un texte propre sans aucun de ces symboles. Le document final ne doit contenir QUE du texte français normal, avec ponctuation correcte.
ÉTAPE 1 — NETTOYAGE (silencieux, mental) :
- Ignore tous les symboles parasites, caractères bizarres, artefacts de copier-coller.
- Traite le texte comme s'il avait été tapé proprement par un professionnel.

ÉTAPE 2 — RÉÉCRITURE (avec tes propres mots) :
- Réécris chaque phrase pour qu'elle soit irréprochable : orthographe, grammaire, style, élégance.
- Utilise un vocabulaire riche et soutenu (niveau cabinet de conseil).
- Harmonise le ton : formel, professionnel, assuré.
- Coupe les phrases trop longues, fusionne les phrases hachées.
- Supprime les répétitions, les hésitations, les tics de langage.

RÈGLES ABSOLUES (à ne jamais enfreindre) :
1. NE JAMAIS inventer de fait, chiffre, nom ou date.
2. NE JAMAIS supprimer une information factuelle (chiffre, nom propre, date, montant).
3. NE JAMAIS changer le sens du texte original.
4. NE JAMAIS modifier les "level" ou "type" des blocs.
5. NE JAMAIS toucher aux tableaux (garde-les tels quels).
6. Conserver l'ordre des blocs.

EXEMPLES DE RÉÉCRITURE ATTENDUE :

Exemple 1 :
- Entrée : "on a fait un chiffre d'affaire de 15M cette année, c'est trop bien. les employés ils sont 12 et ils travaillent bien."
- Sortie : "L'exercice écoulé s'est conclu par un chiffre d'affaires de 15 millions de FCFA, un résultat des plus encourageants. L'effectif, composé de 12 collaborateurs, se distingue par son engagement remarquable."

Exemple 2 :
- Entrée : "le bénéfice il est de 3,2M. on doit faire plus de marketing pour avoir plus de clients."
- Sortie : "Le bénéfice net s'établit à 3,2 millions de FCFA. Il apparaît dès lors indispensable de renforcer notre stratégie marketing afin d'élargir notre base clients."

Exemple 3 :
- Entrée : "c'est une année difficile mais on va y arriver"
- Sortie : "L'exercice écoulé a présenté des défis notables, que nous saurons néanmoins surmonter."

FORMAT DE SORTIE OBLIGATOIRE : JSON strict.
{
  "blocks": [
    { "level": "...", "type": "...", "content": "..." },
    { "level": "...", "type": "table", "content": "", "rows": [...] }
  ]
}`;
// ============================================================
// 5. FONCTIONS DE REFORMULATION
// ============================================================
/**
 * Mode OFF : passe-plat pur. Retourne les blocs inchangés, sans appel LLM.
 * Contrainte cahier des charges : "ne pas modifier le contenu".
 */
export function reformulateOff(blocks) {
  return blocks.map((b) => {
    const copy = { ...b };
    if (b.rows) copy.rows = b.rows.map((r) => [...r]);
    else delete copy.rows;
    return copy;
  });
}

/**
 * Mode ON : reformulation via Groq.
 */
export async function reformulateOn(blocks) {
  const client = getGroqClient();
  if (!client) throw new Error('GROQ_API_KEY manquante');

  // Chunking : batches de ~6000 tokens
  const batches = chunkBlocks(blocks, { maxTokensPerBatch: 6000 });
  const allBlocks = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      max_tokens: 8000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REFORMULATION_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            blocks: batch,
            context: `Batch ${i + 1}/${batches.length} — traite UNIQUEMENT ces ${batch.length} blocs. Retourne EXACTEMENT ${batch.length} blocs.`,
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

    // Vérification stricte en M3 : même nombre de blocs
    if (parsed.blocks.length !== batch.length) {
      throw new Error(
        `Batch ${i + 1} : Groq a produit ${parsed.blocks.length} blocs au lieu de ${batch.length}`
      );
    }

    allBlocks.push(...parsed.blocks);
  }

  return allBlocks;
}

// ============================================================
// 6. CIRCUIT BREAKER (pattern identique à M2)
// ============================================================
function createBreaker(fn, { timeout = 30000, threshold = 3, cooldown = 30000 } = {}) {
  let failures = 0;
  let openUntil = 0;

  return {
    async fire(...args) {
      if (Date.now() < openUntil) throw new Error('Circuit breaker OPEN');
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

const groqBreaker = createBreaker(reformulateOn);

// ============================================================
// 7. SERVICE PRINCIPAL
// ============================================================
export async function reformulate({ blocks, mode = 'OFF' }) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw Object.assign(new Error('blocks[] requis et non vide'), { statusCode: 400 });
  }
  if (!['ON', 'OFF'].includes(mode)) {
    throw Object.assign(new Error('mode doit être "ON" ou "OFF"'), { statusCode: 400 });
  }

  const moduleEnabled = isModuleEnabled();
  const warnings = [];

  // Feature flag OFF → passe-plat forcé, quelle que soit la demande
  if (!moduleEnabled) {
    warnings.push('Module M3 désactivé par feature flag → mode OFF forcé');
    return {
      version: '1.0',
      blocks: reformulateOff(blocks),
      meta: {
        mode: 'OFF',
        llm_used: false,
        fallback_used: true,
        module_enabled: false,
        model: 'none',
        warnings,
      },
    };
  }

  // Mode OFF : passe-plat pur, zéro appel LLM
  if (mode === 'OFF') {
    return {
      version: '1.0',
      blocks: reformulateOff(blocks),
      meta: {
        mode: 'OFF',
        llm_used: false,
        fallback_used: false,
        module_enabled: true,
        model: 'none',
        warnings,
      },
    };
  }

  // Mode ON : tentative LLM avec fallback
  let finalBlocks;
  let llmUsed = false;
  let fallbackUsed = false;

  if (process.env.GROQ_API_KEY) {
    try {
      finalBlocks = await groqBreaker.fire(blocks);
      llmUsed = true;
    } catch (err) {
      warnings.push(`Groq indisponible : ${err.message}`);
      fallbackUsed = true;
    }
  } else {
    warnings.push('GROQ_API_KEY absente');
    fallbackUsed = true;
  }

  // Fallback : on renvoie les blocs INCHANGÉS (jamais de contenu corrompu)
  if (!llmUsed) {
    finalBlocks = reformulateOff(blocks);
  }

  return {
    version: '1.0',
    blocks: finalBlocks,
    meta: {
      mode: 'ON',
      llm_used: llmUsed,
      fallback_used: fallbackUsed,
      module_enabled: true,
      model: llmUsed ? DEFAULT_MODEL : 'none',
      warnings,
    },
  };
}

// ============================================================
// 8. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger });

  // CORS : autorise le front (localhost:3005) à appeler ce module
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    status: 'ok',
    module: 'M3',
    enabled: isModuleEnabled(),
  }));
  app.get('/m3/contract', async () => CONTRACT_V1);
  app.get('/m3/breaker', async () => groqBreaker._status());

  app.post(
    '/m3/reformulate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blocks'],
          properties: {
            blocks: { type: 'array', minItems: 1 },
            mode: { type: 'string', enum: ['ON', 'OFF'], default: 'OFF' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await reformulate(req.body);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }
    }
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M3');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm3' });
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

  const sampleBlocks = [
    { level: 'h1', type: 'text', content: 'Titre' },
    { level: 'body', type: 'text', content: 'Le texte original ne doit pas changer.' },
    { level: 'body', type: 'table', content: '', rows: [['A', '1'], ['B', '2']] },
  ];

  t('mode OFF : passe-plat pur (contenu identique)', async () => {
    const res = await reformulate({ blocks: sampleBlocks, mode: 'OFF' });
    assert.equal(res.meta.mode, 'OFF');
    assert.equal(res.meta.llm_used, false);
    assert.equal(res.meta.fallback_used, false);
    assert.deepEqual(res.blocks, sampleBlocks);
  });

  t('mode OFF : aucune altération même avec faute', async () => {
    const input = [{ level: 'body', type: 'text', content: 'il é tô b1' }];
    const res = await reformulate({ blocks: input, mode: 'OFF' });
    assert.equal(res.blocks[0].content, 'il é tô b1');
  });

  t('mode OFF : tableaux préservés', async () => {
    const input = [{ level: 'body', type: 'table', content: '', rows: [['X', 'Y']] }];
    const res = await reformulate({ blocks: input, mode: 'OFF' });
    assert.deepEqual(res.blocks[0].rows, [['X', 'Y']]);
  });

  t('mode invalide → 400', async () => {
    await assert.rejects(
      () => reformulate({ blocks: sampleBlocks, mode: 'MAYBE' }),
      /mode doit être/
    );
  });

  t('blocks vide → 400', async () => {
    await assert.rejects(() => reformulate({ blocks: [] }), /blocks\[\] requis/);
  });

  t('feature flag OFF → mode OFF forcé', async () => {
    const old = process.env.M3_ENABLED;
    process.env.M3_ENABLED = 'false';
    const res = await reformulate({ blocks: sampleBlocks, mode: 'ON' });
    assert.equal(res.meta.module_enabled, false);
    assert.equal(res.meta.mode, 'OFF');
    assert.equal(res.meta.llm_used, false);
    assert.equal(res.meta.fallback_used, true);
    process.env.M3_ENABLED = old;
  });

  t('mode ON sans GROQ_API_KEY → fallback sur blocs originaux', async () => {
    const old = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await reformulate({ blocks: sampleBlocks, mode: 'ON' });
    assert.equal(res.meta.mode, 'ON');
    assert.equal(res.meta.llm_used, false);
    assert.equal(res.meta.fallback_used, true);
    // Vérifie que le contenu n'a pas été altéré (pas de corruption)
    assert.deepEqual(res.blocks, sampleBlocks);
    if (old) process.env.GROQ_API_KEY = old;
  });

  t('route /m3/reformulate respecte le contrat', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m3/reformulate',
      payload: { blocks: sampleBlocks, mode: 'OFF' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.version, '1.0');
    assert.equal(body.meta.mode, 'OFF');
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
    console.log('🧪 Tests M3…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M3…\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    const r = await app.inject({
      method: 'POST',
      url: '/m3/reformulate',
      payload: { blocks: [{ level: 'h1', type: 'text', content: 'T' }], mode: 'OFF' },
    });
    console.log('health    :', health.statusCode, health.json());
    console.log('reform OFF:', r.statusCode, r.json().meta);
    await app.close();
    process.exit(health.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3003);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 M3 Reformulation → http://localhost:${port}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /m3/contract`);
    console.log(`   GET  /m3/breaker`);
    console.log(`   POST /m3/reformulate  { "blocks": [...], "mode": "ON|OFF" }`);
    console.log(`\n   Feature flag M3_ENABLED : ${isModuleEnabled() ? '✅ actif' : '❌ désactivé'}`);
    if (!process.env.GROQ_API_KEY) {
      console.log(`   ⚠️  GROQ_API_KEY absente → mode ON tombera en fallback`);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig} → arrêt propre M3`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}