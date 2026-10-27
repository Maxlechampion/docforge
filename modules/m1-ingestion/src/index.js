#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M1 : Ingestion
 * ------------------------------------------------------------
 * Version corrigée : ESM pur, Node 20+, 0 dépendance cassée.
 *
 * Rôle : Upload fichier (.txt, .docx, .pdf, .pptx, images OCR)
 *        + collage de texte brut/enrichi.
 * Sortie : JSON structuré conforme au contrat v1.
 *
 * Contraintes respectées :
 *  - 0.1 Stack 100% gratuite.
 *  - 0.2 Isolation stricte : timeouts, fallbacks, health check,
 *        aucun crash global si un parseur échoue.
 *
 * Usage :
 *   node m1-ingestion.js              # serveur (port 3001)
 *   node m1-ingestion.js --test       # tests intégrés
 *   node m1-ingestion.js --selftest   # smoke test rapide
 * ============================================================
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import mammoth from 'mammoth';
import Tesseract from 'tesseract.js';
import JSZip from 'jszip';
import pdfParse from 'pdf-parse';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';

// ============================================================
// 1. CONTRAT D'INTERFACE (v1)
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/ingestion.json',
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
      required: ['source', 'fallback_used'],
      properties: {
        source: { enum: ['txt', 'docx', 'pdf', 'pptx', 'image', 'paste'] },
        filename: { type: 'string' },
        fallback_used: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ============================================================
// 2. UTILITAIRES
// ============================================================
/**
 * Nettoie les caractères parasites, les symboles bizarres,
 * les espaces multiples, les retours à la ligne excessifs.
 */
/**
 * Nettoie les caractères parasites, les symboles Markdown,
 * les artefacts de copier-coller (ChatGPT, Notion, web).
 */
/**
 * Nettoie les caractères parasites, les symboles Markdown, HTML,
 * et tous les artefacts de copier-coller depuis une page web ou une IA.
 */
function cleanRawText(text) {
  if (!text) return '';
  let cleaned = String(text);

  // ═══════════════════════════════════════════════════════
  // Filtrer les artefacts de conversation (ChatGPT, Claude…)
  // ═══════════════════════════════════════════════════════
  const artifactPatterns = [
    /^Éléments mémorisés mis à jour\s*$/gim,
    /^ChatGPT a dit\s*:?\s*$/gim,
    /^Vous avez dit\s*:?\s*$/gim,
    /^Please write in French language\.?\s*$/gim,
    /^Tu es un expert dans.*$/gim,
    /^Peut-on commencer\?.*$/gim,
    /^N'hésite pas à commencer.*$/gim,
    /^D'accord, commençons.*$/gim,
    /^Souhaites-tu.*\?\s*$/gim,
    /^Préfères-tu.*\?\s*$/gim,
    /^Que penses-tu.*\?\s*$/gim,
    /^Veux-tu que je.*\?\s*$/gim,
  ];
  for (const pattern of artifactPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // ═══════════════════════════════════════════════════════
  // Filtrer les caractères de contrôle Unicode (U+0080–U+009F)
  // ═══════════════════════════════════════════════════════
  cleaned = cleaned.replace(/[\u0080-\u009F]/g, '');

  // Filtrer les séquences de caractères bizarres (> 3 non-ASCII consécutifs)
  // MAIS garder les accents français (À-ÿ = U+00C0–U+00FF)
  cleaned = cleaned.replace(/[^\x00-\x7F\u00C0-\u017F\s]{3,}/g, '');


  // 1. Supprimer les balises HTML (<code>, <span>, <div>, etc.)
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  // 2. Supprimer les entités HTML (&nbsp;, &amp;, &lt;, etc.)
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&[a-z]+;/g, ''); // autres entités

  // 3. Supprimer les caractères de contrôle
  cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // 4. Normaliser les espaces spéciaux
  cleaned = cleaned.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

 

  // 6. Supprimer les symboles Markdown
  cleaned = cleaned.replace(/\*\*/g, '');
  cleaned = cleaned.replace(/\*/g, '');
  cleaned = cleaned.replace(/__/g, '');
  cleaned = cleaned.replace(/(?<!\w)_(?!\w)/g, '');
  cleaned = cleaned.replace(/~~/g, '');

  // 7. Supprimer les lignes de séparation (---, ***, ___)
  cleaned = cleaned.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // 8. Normaliser les puces (●, *, -, +, ▪, etc.) en "- "
  cleaned = cleaned.replace(/^\s*[-*+●•▪◦‣⁃]\s+/gm, '- ');

  // 9. Nettoyer les titres Markdown (# Titre)
  cleaned = cleaned.replace(/^(#{1,6})\s+(.+)$/gm, (m, hashes, title) => {
    const cleanTitle = title.replace(/[*_`]/g, '').trim();
    return `${hashes} ${cleanTitle}`;
  });

  // 10. Supprimer emojis et symboles exotiques
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
  cleaned = cleaned.replace(/[™®©℠]/g, '');
  cleaned = cleaned.replace(/[✓✔✗✘☑☐■□▪▫◆◇○●]/g, '');
  cleaned = cleaned.replace(/[→←↑↓⇒⇐⇑⇓➡⬅⬆⬇]/g, '->');
  cleaned = cleaned.replace(/[¶§†‡]/g, '');

  // 11. Supprimer les liens Markdown [texte](url) et images ![alt](url)
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 12. Normaliser guillemets et apostrophes
  cleaned = cleaned.replace(/[«»""„‟]/g, '"');
  cleaned = cleaned.replace(/['']/g, "'");
  cleaned = cleaned.replace(/[–—]/g, '-');
  cleaned = cleaned.replace(/…/g, '...');

  // 13. Supprimer les caractères non-ASCII restants (sauf accents français)
  cleaned = cleaned.replace(/[^\x20-\x7E\u00C0-\u00FF\u0152\u0153\u20AC€\n]/g, '');

  // 14. Normaliser retours à la ligne et espaces
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');

  // 15. Trim final
  cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');
  cleaned = cleaned.replace(/^\n+|\n+$/g, '');

  return cleaned;
}

/**
 * Convertit du texte brut en blocs structurés.
 * Détecte la hiérarchie SANS nécessiter de Markdown.
 */
function textToBlocks(text, warnings = []) {
  const blocks = [];
  text = cleanRawText(text);
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');

  const patterns = {
    mdH1: /^#\s+(.+)$/,
    mdH2: /^##\s+(.+)$/,
    mdH3: /^###\s+(.+)$/,
    h1Numbered: /^\d+\.\s+([A-ZÀ-Ý][A-ZÀ-Ý\s,'()\-:]{3,})$/,
    h2Numbered: /^\d+\.\d+\.?\s+(.+)$/,
    h3Numbered: /^\d+\.\d+\.\d+\.?\s+(.+)$/,
    bullet: /^[-*•▪◦‣⁃]\s+(.+)$/,
    numberedList: /^\d+[.)]\s+(.+)$/,
    quote: /^[«"](.+)["»]$/,
    tableRow: /^\|.+\|$/,
    tableSep: /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/,
  };

  const isLikelyH1 = (line) => {
    if (line.length < 3 || line.length > 120) return false;
    const letters = line.replace(/[^A-ZÀ-Ý]/g, "");
    if (letters.length < 4) return false;
    const totalLetters = line.replace(/[^A-Za-zÀ-Ý]/g, "").length;
    if (totalLetters === 0) return false;
    const upperRatio = letters.length / totalLetters;
    if (upperRatio < 0.85) return false;
    if (/[.!?;]$/.test(line) && !/:$/.test(line)) return false;
    return true;
  };

  const isLikelyH2 = (line) => {
    if (line.length < 3 || line.length > 80) return false;
    const words = line.split(/\s+/);
    if (words.length < 1 || words.length > 12) return false;
    const titleCaseCount = words.filter((w) => /^[A-ZÀ-Ý]/.test(w)).length;
    if (titleCaseCount < words.length * 0.5) return false;
    if (/[.!?;]$/.test(line)) return false;
    return true;
  };

  const isLikelyH3 = (line) => {
    if (line.length < 3 || line.length > 60) return false;
    if (!/^[A-ZÀ-Ý]/.test(line)) return false;
    if (/[.!?;]$/.test(line)) return false;
    const upperLetters = line.replace(/[^A-ZÀ-Ý]/g, "").length;
    const totalLetters = line.replace(/[^A-Za-zÀ-Ý]/g, "").length;
    if (totalLetters === 0) return false;
    if (upperLetters / totalLetters > 0.85) return false;
    return true;
  };

  let buffer = [];
  const flush = () => {
    const content = buffer.join(' ').trim();
    if (content) blocks.push({ level: 'body', type: 'text', content });
    buffer = [];
  };

  let tableBuffer = [];
  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer
      .filter((l) => !patterns.tableSep.test(l))
      .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length > 0) {
      blocks.push({ level: 'body', type: 'table', content: '', rows });
    }
    tableBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      flush();
      flushTable();
      continue;
    }

    if (patterns.tableRow.test(line) || patterns.tableSep.test(line)) {
      flush();
      tableBuffer.push(line);
      continue;
    } else if (tableBuffer.length > 0) {
      flushTable();
    }

    let m;
    if ((m = patterns.mdH3.exec(line))) { flush(); blocks.push({ level: 'h3', type: 'text', content: m[1].trim() }); continue; }
    if ((m = patterns.mdH2.exec(line))) { flush(); blocks.push({ level: 'h2', type: 'text', content: m[1].trim() }); continue; }
    if ((m = patterns.mdH1.exec(line))) { flush(); blocks.push({ level: 'h1', type: 'text', content: m[1].trim() }); continue; }

    if ((m = patterns.h3Numbered.exec(line))) {
      flush();
      blocks.push({ level: 'h3', type: 'text', content: line.trim() });
      continue;
    }

    if ((m = patterns.h2Numbered.exec(line))) {
      flush();
      blocks.push({ level: 'h2', type: 'text', content: line.trim() });
      continue;
    }

    if ((m = patterns.h1Numbered.exec(line))) {
      flush();
      blocks.push({ level: 'h1', type: 'text', content: line.trim() });
      continue;
    }

    if ((m = patterns.quote.exec(line))) {
      flush();
      blocks.push({ level: 'body', type: 'quote', content: m[1].trim() });
      continue;
    }

    if ((m = patterns.bullet.exec(line))) {
      flush();
      blocks.push({ level: 'body', type: 'list', content: m[1].trim() });
      continue;
    }

    if ((m = patterns.numberedList.exec(line)) && !/^\d+\.\s+[A-ZÀ-Ý][A-ZÀ-Ý\s,'()\-:]{3,}$/.test(line)) {
      flush();
      blocks.push({ level: 'body', type: 'list', content: line });
      continue;
    }

    const prevEmpty = i === 0 || lines[i - 1].trim() === '';
    const nextEmpty = i === lines.length - 1 || lines[i + 1].trim() === '';
    const isIsolated = prevEmpty && nextEmpty;

    if (isIsolated) {
      if (isLikelyH1(line)) {
        flush();
        blocks.push({ level: 'h1', type: 'text', content: line });
        continue;
      }
      if (isLikelyH2(line)) {
        flush();
        blocks.push({ level: 'h2', type: 'text', content: line });
        continue;
      }
      if (isLikelyH3(line)) {
        flush();
        blocks.push({ level: 'h3', type: 'text', content: line });
        continue;
      }
    }

    buffer.push(line);
  }

  flush();
  flushTable();

  if (blocks.length === 0 && text.trim()) {
    blocks.push({ level: 'body', type: 'text', content: text.trim() });
    warnings.push('Aucune structure détectée, contenu placé en bloc unique.');
  }

  return blocks;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${label} (${ms}ms)`)), ms)
    ),
  ]);
}

// ============================================================
// 3. PARSEURS PAR FORMAT
// ============================================================

const PARSE_TIMEOUT_MS = 20000;

async function parseTxt(buffer) {
  return { text: buffer.toString('utf-8'), warnings: [] };
}

async function parseDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: value, warnings: [] };
}

/**
 * PDF : extraction texte via les opérateurs Tj/TJ du PDF.
 * Fonctionne bien sur PDFs avec couche texte.
 * Sur PDFs scannés → renvoie warnings (fallback OCR image possible).
 */
async function parsePdf(buffer) {
  const warnings = [];
  try {
    // pdf-parse gère les PDFs avec couche texte (FlateDecode, CID fonts, etc.)
    const data = await withTimeout(pdfParse(buffer), PARSE_TIMEOUT_MS, 'pdf');
    const text = (data.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 10) {
      warnings.push(
        'PDF sans couche texte détectée (probablement scanné). Astuce : uploadez une image pour l\'OCR.'
      );
    }
    return { text, warnings };
  } catch (err) {
    warnings.push(`Extraction PDF en échec: ${err.message}`);
    return { text: '', warnings };
  }
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

async function parsePptx(buffer) {
  const warnings = [];
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slides = Object.keys(zip.files).filter((f) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(f)
    );
    let text = '';
    for (const s of slides.sort()) {
      const xml = await zip.files[s].async('string');
      const matches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]);
      if (matches.length) text += matches.join(' ') + '\n\n';
    }
    if (!text.trim()) warnings.push('PPTX: aucune chaîne de texte extraite.');
    return { text, warnings };
  } catch (err) {
    warnings.push(`Extraction PPTX en échec: ${err.message}`);
    return { text: '', warnings };
  }
}

async function parseImage(buffer) {
  const warnings = [];
  try {
    const { data } = await Tesseract.recognize(buffer, 'fra+eng');
    if (!data.text || !data.text.trim()) {
      warnings.push('OCR: aucun texte détecté.');
    }
    return { text: data.text || '', warnings };
  } catch (err) {
    warnings.push(`OCR indisponible: ${err.message}`);
    return { text: '', warnings };
  }
}

async function parseFile(buffer, filename, mimetype) {
  const ext = extname(filename || '').toLowerCase();
  const mime = (mimetype || '').toLowerCase();

  try {
    if (ext === '.txt' || mime === 'text/plain') {
      return { ...(await withTimeout(parseTxt(buffer), PARSE_TIMEOUT_MS, 'txt')), source: 'txt' };
    }
    if (ext === '.docx' || mime.includes('wordprocessingml')) {
      return { ...(await withTimeout(parseDocx(buffer), PARSE_TIMEOUT_MS, 'docx')), source: 'docx' };
    }
    if (ext === '.pdf' || mime === 'application/pdf') {
      return { ...(await withTimeout(parsePdf(buffer), PARSE_TIMEOUT_MS, 'pdf')), source: 'pdf' };
    }
    if (ext === '.pptx' || mime.includes('presentationml')) {
      return { ...(await withTimeout(parsePptx(buffer), PARSE_TIMEOUT_MS, 'pptx')), source: 'pptx' };
    }
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || mime.startsWith('image/')) {
      return { ...(await withTimeout(parseImage(buffer), 60000, 'ocr')), source: 'image' };
    }
    return {
      text: '',
      warnings: [`Format non supporté: ${ext || mime}`],
      source: 'txt',
    };
  } catch (err) {
    return {
      text: '',
      warnings: [`Parseur ${ext || mime} en échec: ${err.message}`],
      source: 'txt',
    };
  }
}

// ============================================================
// 4. SERVICE (logique métier)
// ============================================================
export async function ingestPaste({ text }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('text requis et non vide'), { statusCode: 400 });
  }
  const warnings = [];
    text = cleanRawText(text);
  const blocks = textToBlocks(text, warnings);
  return {
    version: '1.0',
    blocks,
    meta: { source: 'paste', fallback_used: false, warnings },
  };
}

export async function ingestFile({ buffer, filename, mimetype }) {
  if (!buffer || buffer.length === 0) {
    throw Object.assign(new Error('fichier vide'), { statusCode: 400 });
  }
  if (buffer.length > 20 * 1024 * 1024) {
    throw Object.assign(new Error('fichier > 20 Mo'), { statusCode: 413 });
  }
  const parsed = await parseFile(buffer, filename, mimetype);
  const fallbackUsed = parsed.warnings.length > 0;
  const blocks = textToBlocks(parsed.text || '', parsed.warnings);

  return {
    version: '1.0',
    blocks,
    meta: {
      source: parsed.source,
      filename,
      fallback_used: fallbackUsed,
      warnings: parsed.warnings,
    },
  };
}

// ============================================================
// 5. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 25 * 1024 * 1024 });
   // CETTE LIGNE DOIT ÊTRE PRÉSENTE
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.get('/health', async () => ({ status: 'ok', module: 'm1' }));
  app.get('/m1/contract', async () => CONTRACT_V1);

  app.post(
    '/m1/paste',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        return await ingestPaste(req.body);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }
    }
  );

  app.post('/m1/upload', async (req, reply) => {
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'Aucun fichier fourni' });
      const buffer = await data.toBuffer();
      return await ingestFile({
        buffer,
        filename: data.filename,
        mimetype: data.mimetype,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(err.statusCode || 500).send({ error: err.message });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M1');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm1' });
  });

  return app;
}

// ============================================================
// 6. TESTS INTÉGRÉS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');

  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  t('paste simple → blocs structurés', async () => {
    const res = await ingestPaste({ text: '# Titre\n- point A\n- point B\nParagraphe.' });
    assert.equal(res.version, '1.0');
    assert.equal(res.blocks[0].level, 'h1');
    assert.equal(res.blocks[1].type, 'list');
    assert.equal(res.meta.source, 'paste');
  });

  t('paste vide → erreur 400', async () => {
    await assert.rejects(() => ingestPaste({ text: '   ' }), /text requis/);
  });

  t('upload .txt → blocs conformes', async () => {
    const buffer = Buffer.from('## Section\nContenu simple.');
    const res = await ingestFile({ buffer, filename: 'a.txt', mimetype: 'text/plain' });
    assert.equal(res.meta.source, 'txt');
    assert.equal(res.blocks[0].level, 'h2');
  });

  t('upload format inconnu → fallback sans crash', async () => {
    const res = await ingestFile({
      buffer: Buffer.from('abc'),
      filename: 'x.xyz',
      mimetype: 'application/x-unknown',
    });
    assert.equal(res.meta.fallback_used, true);
    assert.ok(res.meta.warnings.length > 0);
  });

  t('upload fichier vide → erreur', async () => {
    await assert.rejects(
      () => ingestFile({ buffer: Buffer.alloc(0), filename: 'x.txt', mimetype: 'text/plain' }),
      /fichier vide/
    );
  });

  t('route /m1/paste respecte contrat', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m1/paste',
      payload: { text: '# T\n- a' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.version, '1.0');
    assert.ok(Array.isArray(body.blocks));
    await app.close();
  });

  t('route /health répond', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().module, 'm1');
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
// 7. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M1…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M1…\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    const paste = await app.inject({
      method: 'POST',
      url: '/m1/paste',
      payload: { text: '# Hello\n- world' },
    });
    console.log('health :', health.statusCode, health.json());
    console.log('paste  :', paste.statusCode, '→', paste.json().blocks.length, 'bloc(s)');
    await app.close();
    process.exit(health.statusCode === 200 && paste.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3001);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 M1 Ingestion → http://localhost:${port}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /m1/contract`);
    console.log(`   POST /m1/paste   { "text": "..." }`);
    console.log(`   POST /m1/upload  (multipart, champ "file")`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(`\n⏹  ${sig} reçu → arrêt propre M1`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled rejection (contenu)');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception (contenu)');
  });
}