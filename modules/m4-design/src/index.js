#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M4 : Design & Templates
 * ------------------------------------------------------------
 * Reçoit les blocs enrichis (sortie M2 + M3) et produit un
 * PLAN DE DESIGN consommable par M5 :
 *   - template choisi (parmi 5)
 *   - thème (couleurs, polices)
 *   - layout (couverture, sommaire, sauts de section)
 *   - logo (data URI + position) ← NOUVEAU
 *   - hints de design par bloc
 *
 * Contraintes :
 *  - 0.1 : Groq free tier + polices Google Fonts (OFL).
 *  - 0.2 : feature flag, circuit breaker, fallback minimal.
 *
 * Usage :
 *   node src/index.js              # serveur (port 3004)
 *   node src/index.js --test       # tests intégrés
 *   node src/index.js --selftest   # smoke test
 *
 * Env :
 *   GROQ_API_KEY=gsk_...
 *   GROQ_MODEL=openai/gpt-oss-20b
 *   M4_ENABLED=true
 * ============================================================
 */

import 'dotenv/config';
import Fastify from 'fastify';
import Groq from 'groq-sdk';
import cors from '@fastify/cors';
import { fileURLToPath } from 'node:url';

// ============================================================
// 1. CONTRAT v1
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/design.json',
  type: 'object',
  required: ['version', 'design', 'meta'],
  properties: {
    version: { const: '1.0' },
    design: {
      type: 'object',
      required: ['template', 'theme', 'layout', 'blocks'],
      properties: {
        template: { type: 'string' },
        theme: {
          type: 'object',
          required: ['primary', 'secondary', 'font_heading', 'font_body'],
          properties: {
            primary: { type: 'string' },
            secondary: { type: 'string' },
            accent: { type: 'string' },
            font_heading: { type: 'string' },
            font_body: { type: 'string' },
            font_mono: { type: 'string' },
          },
        },
        layout: {
          type: 'object',
          required: ['cover_page', 'table_of_contents', 'section_breaks'],
          properties: {
            cover_page: { type: 'boolean' },
            table_of_contents: { type: 'boolean' },
            section_breaks: { type: 'boolean' },
            logo_position: { type: 'string' },
          },
        },
        blocks: { type: 'array' },
        logo: {
          type: ['object', 'null'],
          properties: {
            dataUri: { type: 'string' },
            position: { type: 'string', enum: ['header', 'footer', 'cover'] },
          },
        },
      },
    },
    meta: {
      type: 'object',
      required: ['detected_sector', 'llm_used', 'fallback_used', 'module_enabled'],
      properties: {
        detected_sector: { type: 'string' },
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
// 2. FEATURE FLAG
// ============================================================
export function isModuleEnabled() {
  return process.env.M4_ENABLED !== 'false';
}

// ============================================================
// 3. CLIENT GROQ (lazy)
// ============================================================
let groqClient = null;

function getGroqClient() {
  if (groqClient) return groqClient;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  groqClient = new Groq({ apiKey, timeout: 20000, maxRetries: 1 });
  return groqClient;
}

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

// ============================================================
// 4. TEMPLATES (Kimi-style, tous gratuits)
// ============================================================
export const TEMPLATES = {
  consulting: {
    theme: {
      primary: '#1e40af',
      secondary: '#64748b',
      accent: '#0ea5e9',
      font_heading: 'Inter',
      font_body: 'Inter',
      font_mono: 'JetBrains Mono',
    },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  },
  startup: {
    theme: {
      primary: '#7c3aed',
      secondary: '#f97316',
      accent: '#ec4899',
      font_heading: 'Poppins',
      font_body: 'Inter',
      font_mono: 'Fira Code',
    },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  },
  'annual-report': {
    theme: {
      primary: '#b45309',
      secondary: '#1f2937',
      accent: '#f59e0b',
      font_heading: 'Merriweather',
      font_body: 'Source Sans 3',
      font_mono: 'Source Code Pro',
    },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  },
  academic: {
    theme: {
      primary: '#14532d',
      secondary: '#fef3c7',
      accent: '#65a30d',
      font_heading: 'Lora',
      font_body: 'Source Sans 3',
      font_mono: 'IBM Plex Mono',
    },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  },
  minimal: {
    theme: {
      primary: '#111827',
      secondary: '#6b7280',
      accent: '#9ca3af',
      font_heading: 'Inter',
      font_body: 'Inter',
      font_mono: 'JetBrains Mono',
    },
    layout: { cover_page: false, table_of_contents: false, section_breaks: false },
  },
};

// ============================================================
// 5. DÉTECTION DE SECTEUR (heuristique par mots-clés)
// ============================================================
const SECTOR_KEYWORDS = {
  finance: ['chiffre d\'affaires', 'bénéfice', 'bilan', 'budget', 'fiscal', 'rentabilité', 'investissement', 'actionnaire', 'croissance', 'marge'],
  marketing: ['marketing', 'campagne', 'client', 'marque', 'audience', 'conversion', 'lead', 'vente', 'engagement', 'communication'],
  academic: ['recherche', 'mémoire', 'thèse', 'université', 'hypothèse', 'méthodologie', 'bibliographie', 'analyse', 'théorie', 'citation'],
  tech: ['api', 'code', 'algorithme', 'données', 'serveur', 'développement', 'architecture', 'bug', 'feature', 'sprint'],
  hr: ['recrutement', 'employé', 'rh', 'salaire', 'formation', 'carrière', 'talent', 'équipe', 'collaborateur', 'management'],
};

export function detectSectorHeuristic(blocks) {
  const text = blocks
    .map((b) => (b.content || '') + ' ' + (b.rows?.flat().join(' ') || ''))
    .join(' ')
    .toLowerCase();
  const scores = {};
  for (const [sector, words] of Object.entries(SECTOR_KEYWORDS)) {
    scores[sector] = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'general';
}

// ============================================================
// 6. DÉTECTION PAR LLM
// ============================================================
const SECTOR_PROMPT = `Tu reçois une liste de blocs documentaires.
Détermine à quel secteur appartient ce document. Réponds en JSON strict.

SECTEURS POSSIBLES : finance, marketing, academic, tech, hr, general

FORMAT : { "sector": "finance" }`;

export async function detectSectorLLM(blocks) {
  const client = getGroqClient();
  if (!client) throw new Error('GROQ_API_KEY manquante');

  const completion = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SECTOR_PROMPT },
      { role: 'user', content: JSON.stringify({ blocks: blocks.slice(0, 10) }) },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  return parsed.sector || 'general';
}

// ============================================================
// 7. MAPPING SECTEUR → TEMPLATE
// ============================================================
const SECTOR_TO_TEMPLATE = {
  finance: 'consulting',
  marketing: 'startup',
  academic: 'academic',
  tech: 'minimal',
  hr: 'consulting',
  general: 'consulting',
};

// ============================================================
// 8. CONSTRUCTION DU DESIGN (avec conservation du logo)
// ============================================================
export function buildDesign({ template, blocks, options = {} }) {
  const chosen = TEMPLATES[template] || TEMPLATES.consulting;

  // Override couleurs si fournies
  const theme = { ...chosen.theme };
  if (options.colors?.primary) theme.primary = options.colors.primary;
  if (options.colors?.secondary) theme.secondary = options.colors.secondary;

  // Layout + logo
  const layout = { ...chosen.layout };
  let logo = null;

  if (options.logo) {
    layout.logo_position = options.logo_position || 'header';
    logo = {
      dataUri: options.logo,
      position: layout.logo_position,
    };
  }

  // Hints par bloc (préparation M5)
  const decoratedBlocks = blocks.map((b, idx) => ({
    ...b,
    _design_hint: {
      is_first_h1: b.level === 'h1' && !blocks.slice(0, idx).some((x) => x.level === 'h1'),
      is_section_start: b.level === 'h1' || b.level === 'h2',
      render_as: b.type === 'table' ? 'table' : b.type === 'list' ? 'bullets' : 'paragraph',
    },
  }));

  return {
    template: TEMPLATES[template] ? template : 'consulting',
    theme,
    layout,
    logo,
    blocks: decoratedBlocks,
  };
}

// ============================================================
// 9. CIRCUIT BREAKER
// ============================================================
function createBreaker(fn, { timeout = 20000, threshold = 3, cooldown = 30000 } = {}) {
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

const sectorBreaker = createBreaker(detectSectorLLM);

// ============================================================
// 10. SERVICE PRINCIPAL
// ============================================================
export async function design({ blocks, options = {} }) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw Object.assign(new Error('blocks[] requis et non vide'), { statusCode: 400 });
  }

  const moduleEnabled = isModuleEnabled();
  const warnings = [];

  // Feature flag OFF → design minimal hardcodé
  if (!moduleEnabled) {
    warnings.push('Module M4 désactivé → design minimal par défaut');
    return {
      version: '1.0',
      design: buildDesign({ template: 'minimal', blocks, options }),
      meta: {
        detected_sector: 'general',
        llm_used: false,
        fallback_used: true,
        module_enabled: false,
        model: 'none',
        warnings,
      },
    };
  }

  const requestedTemplate = options.template || 'auto';
  let finalTemplate;
  let detectedSector = 'general';
  let llmUsed = false;
  let fallbackUsed = false;

  // Si template explicite, pas besoin de détection
  if (requestedTemplate !== 'auto' && TEMPLATES[requestedTemplate]) {
    finalTemplate = requestedTemplate;
    detectedSector = detectSectorHeuristic(blocks);
  } else {
    // Détection via LLM (avec fallback heuristique)
    if (process.env.GROQ_API_KEY) {
      try {
        detectedSector = await sectorBreaker.fire(blocks);
        llmUsed = true;
      } catch (err) {
        warnings.push(`Groq indisponible : ${err.message}`);
        detectedSector = detectSectorHeuristic(blocks);
        fallbackUsed = true;
      }
    } else {
      warnings.push('GROQ_API_KEY absente → détection heuristique');
      detectedSector = detectSectorHeuristic(blocks);
      fallbackUsed = true;
    }
    finalTemplate = SECTOR_TO_TEMPLATE[detectedSector] || 'consulting';
  }

  return {
    version: '1.0',
    design: buildDesign({ template: finalTemplate, blocks, options }),
    meta: {
      detected_sector: detectedSector,
      llm_used: llmUsed,
      fallback_used: fallbackUsed,
      module_enabled: true,
      model: llmUsed ? DEFAULT_MODEL : 'heuristic',
      warnings,
    },
  };
}

// ============================================================
// 11. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger });

  // CORS : autorise le front (localhost:3005) à appeler ce module
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    status: 'ok',
    module: 'M4',
    enabled: isModuleEnabled(),
    templates: Object.keys(TEMPLATES),
  }));

  app.get('/m4/contract', async () => CONTRACT_V1);
  app.get('/m4/templates', async () => ({
    templates: Object.keys(TEMPLATES),
    details: TEMPLATES,
  }));
  app.get('/m4/breaker', async () => sectorBreaker._status());

  app.post(
    '/m4/design',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blocks'],
          properties: {
            blocks: { type: 'array', minItems: 1 },
            options: {
              type: 'object',
              properties: {
                template: {
                  type: 'string',
                  enum: ['auto', 'consulting', 'startup', 'annual-report', 'academic', 'minimal'],
                  default: 'auto',
                },
                logo: { type: 'string', nullable: true },
                logo_position: {
                  type: 'string',
                  enum: ['header', 'footer', 'cover'],
                  default: 'header',
                },
                colors: {
                  type: 'object',
                  properties: {
                    primary: { type: 'string' },
                    secondary: { type: 'string' },
                  },
                  nullable: true,
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await design(req.body);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }
    }
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M4');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm4' });
  });

  return app;
}

// ============================================================
// 12. TESTS INTÉGRÉS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  const financeBlocks = [
    { level: 'h1', type: 'text', content: 'Bilan financier 2026' },
    { level: 'body', type: 'text', content: 'Le chiffre d\'affaires a progressé. Bénéfice net : 3M FCFA.' },
  ];

  const marketingBlocks = [
    { level: 'h1', type: 'text', content: 'Campagne marketing Q4' },
    { level: 'body', type: 'text', content: 'Notre audience cible. Conversion et engagement.' },
  ];

  t('template consulting forcé → thème correct', async () => {
    const res = await design({ blocks: financeBlocks, options: { template: 'consulting' } });
    assert.equal(res.design.template, 'consulting');
    assert.equal(res.design.theme.primary, '#1e40af');
    assert.equal(res.design.theme.font_heading, 'Inter');
  });

  t('template auto + contenu finance → détecte consulting', async () => {
    const old = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await design({ blocks: financeBlocks, options: { template: 'auto' } });
    assert.equal(res.meta.detected_sector, 'finance');
    assert.equal(res.design.template, 'consulting');
    if (old) process.env.GROQ_API_KEY = old;
  });

  t('template auto + contenu marketing → détecte startup', async () => {
    const old = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await design({ blocks: marketingBlocks, options: { template: 'auto' } });
    assert.equal(res.meta.detected_sector, 'marketing');
    assert.equal(res.design.template, 'startup');
    if (old) process.env.GROQ_API_KEY = old;
  });

  t('logo fourni → logo conservé dans le design', async () => {
    const res = await design({
      blocks: financeBlocks,
      options: { template: 'consulting', logo: 'data:image/png;base64,xxx' },
    });
    assert.ok(res.design.logo);
    assert.equal(res.design.logo.dataUri, 'data:image/png;base64,xxx');
    assert.equal(res.design.logo.position, 'header');
    assert.equal(res.design.layout.logo_position, 'header');
  });

  t('couleurs custom → override du thème', async () => {
    const res = await design({
      blocks: financeBlocks,
      options: { template: 'consulting', colors: { primary: '#ff0000', secondary: '#00ff00' } },
    });
    assert.equal(res.design.theme.primary, '#ff0000');
    assert.equal(res.design.theme.secondary, '#00ff00');
  });

  t('feature flag OFF → design minimal hardcodé', async () => {
    const old = process.env.M4_ENABLED;
    process.env.M4_ENABLED = 'false';
    const res = await design({ blocks: financeBlocks, options: { template: 'consulting' } });
    assert.equal(res.meta.module_enabled, false);
    assert.equal(res.meta.fallback_used, true);
    assert.equal(res.design.template, 'minimal');
    process.env.M4_ENABLED = old;
  });

  t('blocks vide → 400', async () => {
    await assert.rejects(() => design({ blocks: [] }), /blocks\[\] requis/);
  });

  t('route /m4/design respecte le contrat', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m4/design',
      payload: { blocks: financeBlocks, options: { template: 'consulting' } },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.version, '1.0');
    assert.equal(body.design.template, 'consulting');
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
// 13. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M4…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M4…\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    console.log('health :', health.statusCode, health.json());
    await app.close();
    process.exit(health.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3004);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 M4 Design → http://localhost:${port}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /m4/templates`);
    console.log(`   POST /m4/design`);
    console.log(`\n   Templates disponibles : ${Object.keys(TEMPLATES).join(', ')}`);
    console.log(`   Feature flag M4_ENABLED : ${isModuleEnabled() ? '✅ actif' : '❌ désactivé'}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig} → arrêt propre M4`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}