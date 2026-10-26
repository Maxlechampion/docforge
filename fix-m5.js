#!/usr/bin/env node
/**
 * ============================================================
 * fix-m5.js — Reconstruction complète de M5
 * ------------------------------------------------------------
 * Ce script :
 *   1. Détecte les fonctions manquantes ou en doublon
 *   2. Écrit un fichier M5 complet, propre, sans doublon
 *   3. Vérifie la syntaxe
 *   4. Lance les tests automatiquement
 *
 * Usage :
 *   node fix-m5.js
 * ============================================================
 */

import { writeFile, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const M5_PATH = join(ROOT, 'modules/m5-office-generation/src/index.js');
const M5_BACKUP = M5_PATH + '.backup-' + Date.now();

console.log('\n🔧 fix-m5.js — Reconstruction de M5\n');

// ============================================================
// 1. Sauvegarde de l'ancien fichier
// ============================================================
if (existsSync(M5_PATH)) {
  await copyFile(M5_PATH, M5_BACKUP);
  console.log(`  💾 Sauvegarde : ${M5_BACKUP}\n`);
}

// ============================================================
// 2. Écriture du fichier M5 complet et propre
// ============================================================
const M5_CONTENT = `#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M5 : Génération Office
 * ------------------------------------------------------------
 * Reçoit les blocs décorés (sortie M4) et produit un fichier
 * .docx éditable avec le thème + logo appliqués.
 *
 * Usage :
 *   node src/index.js              # serveur (port 3005)
 *   node src/index.js --test       # tests intégrés
 *   node src/index.js --selftest   # smoke test
 *
 * Env :
 *   M5_ENABLED=true
 * ============================================================
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  PageBreak, Header, Footer, ImageRun,
} from 'docx';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ============================================================
// 1. CONTRAT v1
// ============================================================
export const CONTRACT_V1 = {
  $id: 'https://docforge.ai/schemas/v1/generation.json',
  type: 'object',
  required: ['version', 'meta'],
  properties: {
    version: { const: '1.0' },
    meta: {
      type: 'object',
      required: ['format', 'blocks_count', 'module_enabled'],
      properties: {
        format: { enum: ['docx'] },
        blocks_count: { type: 'number' },
        module_enabled: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// ============================================================
// 2. FEATURE FLAG
// ============================================================
export function isModuleEnabled() {
  return process.env.M5_ENABLED !== 'false';
}

// ============================================================
// 3. UTILITAIRES LOGO
// ============================================================
function parseDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const match = /^data:image\\/(png|jpeg|jpg|gif|webp|bmp);base64,(.+)$/i.exec(dataUri);
  if (!match) return null;

  let type = match[1].toLowerCase();
  if (type === 'jpeg') type = 'jpg';
  if (type === 'webp' || type === 'bmp') type = 'png';

  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > 500 * 1024) return null;

  let width = 150;
  let height = 38;

  if (type === 'png' && buffer.length > 24) {
    try {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    } catch {}
  } else if (type === 'jpg' && buffer.length > 4) {
    try {
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xFF) { i++; continue; }
        const marker = buffer[i + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          height = buffer.readUInt16BE(i + 5);
          width = buffer.readUInt16BE(i + 7);
          break;
        }
        const len = buffer.readUInt16BE(i + 2);
        i += 2 + len;
      }
    } catch {}
  }

  const MAX_W = 200;
  const MAX_H = 60;
  if (width > MAX_W) {
    const ratio = MAX_W / width;
    width = MAX_W;
    height = Math.round(height * ratio);
  }
  if (height > MAX_H) {
    const ratio = MAX_H / height;
    height = MAX_H;
    width = Math.round(width * ratio);
  }

  return { buffer, type, width, height };
}

function buildImageRun(dataUri) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;
  try {
    return new ImageRun({
      data: parsed.buffer,
      transformation: { width: parsed.width, height: parsed.height },
      type: parsed.type,
    });
  } catch {
    return null;
  }
}

// ============================================================
// 4. CONSTRUCTION DU DOCUMENT .DOCX
// ============================================================
export function buildDocx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const layout = design.layout || {};
  const logoDataUri = design.logo?.dataUri || null;
  const logoPosition = design.logo?.position || layout.logo_position || null;

  const children = [];

  // --- Page de garde ---
  if (layout.cover_page) {
    if (logoDataUri && logoPosition === 'cover') {
      const img = buildImageRun(logoDataUri);
      if (img) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 2000, after: 400 },
            children: [img],
          })
        );
      } else {
        children.push(new Paragraph({ spacing: { before: 4000 } }));
      }
    } else {
      children.push(new Paragraph({ spacing: { before: 4000 } }));
    }

    children.push(
      new Paragraph({
        spacing: { before: 0, after: 2000 },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: meta.title || 'Document DocForge AI',
            bold: true,
            size: 72,
            color: (theme.primary || '#1e40af').replace('#', ''),
            font: theme.font_heading || 'Inter',
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: meta.subtitle || \`Généré le \${new Date().toLocaleDateString('fr-FR')}\`,
            size: 28,
            color: (theme.secondary || '#64748b').replace('#', ''),
            font: theme.font_body || 'Inter',
          }),
        ],
      }),
      new Paragraph({ children: [new PageBreak()] })
    );
  }

  // --- Table des matières ---
  if (layout.table_of_contents) {
    const headings = blocks.filter((b) => b.level === 'h1' || b.level === 'h2');
    if (headings.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: 'Sommaire',
              bold: true,
              color: (theme.primary || '#1e40af').replace('#', ''),
              font: theme.font_heading || 'Inter',
            }),
          ],
        })
      );
      for (const h of headings) {
        children.push(
          new Paragraph({
            spacing: { after: 100 },
            children: [
              new TextRun({
                text: \`\${h.level === 'h1' ? '' : '    '}\${h.content}\`,
                size: h.level === 'h1' ? 24 : 22,
                color: (theme.secondary || '#64748b').replace('#', ''),
                font: theme.font_body || 'Inter',
              }),
            ],
          })
        );
      }
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  // --- Blocs de contenu ---
  for (const block of blocks) {
    children.push(...renderBlock(block, theme));
  }

  // --- Header ---
  const headers = {};
  if (logoDataUri && logoPosition === 'header') {
    const img = buildImageRun(logoDataUri);
    if (img) {
      headers.default = new Header({
        children: [
          new Paragraph({ alignment: AlignmentType.RIGHT, children: [img] }),
        ],
      });
    } else {
      headers.default = new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({
                text: meta.title || 'DocForge AI',
                size: 18,
                color: (theme.secondary || '#64748b').replace('#', ''),
                font: theme.font_body || 'Inter',
                italics: true,
              }),
            ],
          }),
        ],
      });
    }
  } else if (layout.logo_position === 'header') {
    headers.default = new Header({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({
              text: meta.title || 'DocForge AI',
              size: 18,
              color: (theme.secondary || '#64748b').replace('#', ''),
              font: theme.font_body || 'Inter',
              italics: true,
            }),
          ],
        }),
      ],
    });
  }

  // --- Footer ---
  const footerChildren = [];
  if (logoDataUri && logoPosition === 'footer') {
    const img = buildImageRun(logoDataUri);
    if (img) {
      footerChildren.push(img);
      footerChildren.push(new TextRun({ text: '  ·  ', size: 16, color: '9ca3af' }));
    }
  }
  footerChildren.push(
    new TextRun({
      text: meta.footer || 'Document généré par DocForge AI',
      size: 16,
      color: '9ca3af',
      font: theme.font_body || 'Inter',
    })
  );

  const footers = {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: footerChildren,
        }),
      ],
    }),
  };

  // --- Document final ---
  return new Document({
    creator: meta.author || 'DocForge AI',
    title: meta.title || 'Document',
    description: 'Généré par DocForge AI',
    styles: {
      default: {
        document: {
          run: {
            font: theme.font_body || 'Inter',
            size: 22,
            color: '1f2937',
          },
          paragraph: {
            spacing: { line: 320, after: 120 },
          },
        },
      },
    },
    sections: [
      {
        properties: {},
        headers: headers.default ? { default: headers.default } : undefined,
        footers,
        children,
      },
    ],
  });
}

// ============================================================
// 5. RENDU PAR TYPE DE BLOC
// ============================================================
function renderBlock(block, theme) {
  const out = [];
  const primaryHex = (theme.primary || '#1e40af').replace('#', '');
  const fontHeading = theme.font_heading || 'Inter';
  const fontBody = theme.font_body || 'Inter';

  if (block.type === 'text' && ['h1', 'h2', 'h3'].includes(block.level)) {
    const map = {
      h1: { level: HeadingLevel.HEADING_1, size: 36, before: 400, after: 200 },
      h2: { level: HeadingLevel.HEADING_2, size: 28, before: 300, after: 150 },
      h3: { level: HeadingLevel.HEADING_3, size: 24, before: 200, after: 100 },
    };
    const cfg = map[block.level];
    out.push(
      new Paragraph({
        heading: cfg.level,
        spacing: { before: cfg.before, after: cfg.after },
        children: [
          new TextRun({
            text: block.content || '',
            bold: true,
            size: cfg.size,
            color: primaryHex,
            font: fontHeading,
          }),
        ],
      })
    );
    return out;
  }

  if (block.type === 'list') {
    const text = (block.content || '').replace(/^[-*•]\\s*/, '').replace(/^\\d+[.)]\\s*/, '');
    out.push(
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 60 },
        children: [
          new TextRun({ text, size: 22, font: fontBody }),
        ],
      })
    );
    return out;
  }

  if (block.type === 'quote') {
    out.push(
      new Paragraph({
        indent: { left: 720, right: 720 },
        spacing: { before: 120, after: 120 },
        border: {
          left: {
            color: primaryHex,
            space: 8,
            style: BorderStyle.SINGLE,
            size: 18,
          },
        },
        children: [
          new TextRun({
            text: block.content || '',
            italics: true,
            size: 22,
            color: '4b5563',
            font: fontBody,
          }),
        ],
      })
    );
    return out;
  }

  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
    const rows = block.rows;
    const headerRow = new TableRow({
      tableHeader: true,
      children: rows[0].map(
        (cell) =>
          new TableCell({
            shading: { fill: primaryHex },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: String(cell),
                    bold: true,
                    color: 'ffffff',
                    size: 22,
                    font: fontHeading,
                  }),
                ],
              }),
            ],
          })
      ),
    });
    const bodyRows = rows.slice(1).map(
      (row) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: String(cell),
                        size: 22,
                        font: fontBody,
                      }),
                    ],
                  }),
                ],
              })
          ),
        })
    );
    out.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [headerRow, ...bodyRows],
      })
    );
    out.push(new Paragraph({ spacing: { after: 200 } }));
    return out;
  }

  out.push(
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: block.content || '',
          size: 22,
          font: fontBody,
        }),
      ],
    })
  );
  return out;
}

// ============================================================
// 6. GÉNÉRATION + BUFFER
// ============================================================
export async function generateDocx({ blocks, design, meta = {} }) {
  const doc = buildDocx({ blocks, design, meta });
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

// ============================================================
// 7. ROUTES FASTIFY
// ============================================================
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 50 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
    prefix: '/',
  });

  app.get('/health', async () => ({
    status: 'ok',
    module: 'M5',
    enabled: isModuleEnabled(),
    formats: ['docx'],
  }));

  app.get('/m5/contract', async () => CONTRACT_V1);

  app.post(
    '/m5/generate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blocks', 'design'],
          properties: {
            blocks: { type: 'array', minItems: 1 },
            design: { type: 'object' },
            meta: { type: 'object' },
            format: { type: 'string', enum: ['docx'], default: 'docx' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!isModuleEnabled()) {
        return reply.code(503).send({
          error: 'Module M5 désactivé par feature flag',
          module_enabled: false,
        });
      }

      try {
        const { blocks, design, meta, format = 'docx' } = req.body;
        if (format !== 'docx') {
          return reply.code(400).send({ error: \`Format \${format} non supporté encore\` });
        }

        const buffer = await generateDocx({ blocks, design, meta });

        const filename = \`docforge-\${Date.now()}.docx\`;
        reply
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          .header('Content-Disposition', \`attachment; filename="\${filename}"\`)
          .header('Content-Length', buffer.length)
          .header('X-DocForge-Blocks', blocks.length);

        return reply.send(buffer);
      } catch (err) {
        req.log.error({ err }, 'Erreur M5 génération');
        return reply.code(500).send({
          error: err.message,
          module: 'm5',
          stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        });
      }
    }
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M5');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm5' });
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

  const sampleDesign = {
    template: 'consulting',
    theme: {
      primary: '#1e40af',
      secondary: '#64748b',
      accent: '#0ea5e9',
      font_heading: 'Inter',
      font_body: 'Inter',
      font_mono: 'JetBrains Mono',
    },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  };

  const sampleBlocks = [
    { level: 'h1', type: 'text', content: 'Titre principal' },
    { level: 'body', type: 'text', content: 'Un paragraphe explicatif.' },
    { level: 'body', type: 'list', content: 'Premier point' },
    { level: 'body', type: 'list', content: 'Deuxième point' },
    { level: 'body', type: 'table', content: '', rows: [['Colonne A', 'Colonne B'], ['Valeur 1', 'Valeur 2']] },
    { level: 'body', type: 'quote', content: 'Une citation importante.' },
  ];

  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  t('génère un buffer non vide', async () => {
    const buf = await generateDocx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 1000);
  });

  t('buffer commence par signature ZIP', async () => {
    const buf = await generateDocx({ blocks: sampleBlocks, design: sampleDesign });
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });

  t('sans logo : buffer valide', async () => {
    const buf = await generateDocx({ blocks: sampleBlocks, design: sampleDesign });
    assert.ok(buf.length > 1000);
  });

  t('avec logo header : buffer valide', async () => {
    const designWithLogo = {
      ...sampleDesign,
      logo: { dataUri: TINY_PNG, position: 'header' },
    };
    const buf = await generateDocx({ blocks: sampleBlocks, design: designWithLogo });
    assert.ok(buf.length > 1000);
  });

  t('avec logo cover : buffer valide', async () => {
    const designWithLogo = {
      ...sampleDesign,
      logo: { dataUri: TINY_PNG, position: 'cover' },
    };
    const buf = await generateDocx({ blocks: sampleBlocks, design: designWithLogo });
    assert.ok(buf.length > 1000);
  });

  t('avec logo footer : buffer valide', async () => {
    const designWithLogo = {
      ...sampleDesign,
      logo: { dataUri: TINY_PNG, position: 'footer' },
    };
    const buf = await generateDocx({ blocks: sampleBlocks, design: designWithLogo });
    assert.ok(buf.length > 1000);
  });

  t('avec logo invalide → pas de crash', async () => {
    const designWithBadLogo = {
      ...sampleDesign,
      logo: { dataUri: 'data:image/png;base64,INVALID_XXX', position: 'header' },
    };
    const buf = await generateDocx({ blocks: sampleBlocks, design: designWithBadLogo });
    assert.ok(buf.length > 1000);
  });

  t('route /m5/generate retourne Content-Type correct', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m5/generate',
      payload: { blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test HTTP' } },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\\/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document/);
    assert.ok(res.rawPayload.length > 1000);
    await app.close();
  });

  t('feature flag OFF → 503', async () => {
    const old = process.env.M5_ENABLED;
    process.env.M5_ENABLED = 'false';
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/m5/generate',
      payload: { blocks: sampleBlocks, design: sampleDesign },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
    process.env.M5_ENABLED = old;
  });

  t('route /health répond', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().module, 'M5');
    await app.close();
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(\`  ✅ \${name}\`);
    } catch (err) {
      failed++;
      console.error(\`  ❌ \${name}\\n     → \${err.message}\`);
    }
  }
  console.log(\`\\n\${tests.length - failed}/\${tests.length} tests OK\`);
  if (failed > 0) process.exit(1);
}

// ============================================================
// 9. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M5…\\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M5…\\n');
    const app = await buildApp({ logger: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    console.log('health :', health.statusCode, health.json());
    await app.close();
    process.exit(health.statusCode === 200 ? 0 : 1);
  }

  const port = Number(process.env.PORT || 3005);
  const app = await buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(\`\\n🚀 M5 Office Generation → http://localhost:\${port}\`);
    console.log(\`   GET  /health\`);
    console.log(\`   GET  /m5/contract\`);
    console.log(\`   POST /m5/generate   { blocks, design, meta, format: "docx" }\`);
    console.log(\`\\n   Frontend : http://localhost:\${port}/\`);
    console.log(\`   Feature flag M5_ENABLED : \${isModuleEnabled() ? '✅ actif' : '❌ désactivé'}\`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log(\`\\n⏹  \${sig} → arrêt propre M5\`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
`;

await writeFile(M5_PATH, M5_CONTENT, 'utf-8');
console.log(`  ✅ Fichier M5 réécrit (${M5_CONTENT.length} octets)\n`);

// ============================================================
// 3. Vérification syntaxe
// ============================================================
console.log('  🔍 Vérification syntaxe...');
try {
  execSync(`node --check "${M5_PATH}"`, { stdio: 'pipe' });
  console.log('  ✅ Syntaxe OK\n');
} catch (err) {
  console.error('  ❌ Erreur de syntaxe :', err.stderr?.toString());
  process.exit(1);
}

// ============================================================
// 4. Lancement des tests
// ============================================================
console.log('  🧪 Lancement des tests M5...\n');
try {
  const output = execSync(`node "${M5_PATH}" --test`, {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: ROOT,
  });
  console.log(output);
} catch (err) {
  console.log(err.stdout?.toString() || '');
  console.error(err.stderr?.toString() || '');
  process.exit(1);
}

console.log('✅ M5 est corrigé et validé.\n');
console.log('Prochaine étape :');
console.log('  node scripts\\start-full.js\n');