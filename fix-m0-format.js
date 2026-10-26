#!/usr/bin/env node
/**
 * fix-m0-format.js — Transmet format à M5 dans l'orchestrateur
 * ============================================================
 * Corrige automatiquement M0 pour :
 *   1. Accepter format dans generate()
 *   2. Passer format à stepM5
 *   3. Passer format à fetch
 *   4. Traiter format dans la route /generate (filename + Content-Type)
 *
 * Usage :
 *   node fix-m0-format.js
 * ============================================================
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const M0_PATH = join(ROOT, 'modules/m0-orchestrator/src/index.js');
const BACKUP = M0_PATH + '.backup-' + Date.now();

console.log('\n🔧 fix-m0-format.js — Transmission du format dans M0\n');

if (!existsSync(M0_PATH)) {
  console.error('  ❌ M0 introuvable :', M0_PATH);
  process.exit(1);
}

await copyFile(M0_PATH, BACKUP);
console.log(`  💾 Sauvegarde : ${BACKUP.split(/[\\/]/).pop()}\n`);

let content = await readFile(M0_PATH, 'utf-8');
let modified = false;

// ============================================================
// 1. Ajouter MIME_TYPES si absent
// ============================================================
if (!content.includes('MIME_TYPES')) {
  const insertAfter = /(import\s+.*from\s+['"]node:url['"];)/;
  if (insertAfter.test(content)) {
    content = content.replace(
      insertAfter,
      `$1

// MIME types pour les 4 formats
const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};`
    );
    console.log('  ✅ MIME_TYPES ajouté');
    modified = true;
  }
} else {
  console.log('  ⏭  MIME_TYPES déjà présent');
}

// ============================================================
// 2. generate() : accepter format
// ============================================================
const genSigOld = `export async function generate({
  text,
  file = null,        // { buffer, filename, mimetype } si upload
  reformulation = 'OFF',
  template = 'auto',
  options = {},
  meta = {},
}) {`;
const genSigNew = `export async function generate({
  text,
  file = null,        // { buffer, filename, mimetype } si upload
  reformulation = 'OFF',
  template = 'auto',
  format = 'docx',
  options = {},
  meta = {},
}) {`;

if (content.includes('format = \'docx\',')) {
  console.log('  ⏭  generate() accepte déjà format');
} else if (content.includes(genSigOld)) {
  content = content.replace(genSigOld, genSigNew);
  console.log('  ✅ generate() accepte format');
  modified = true;
} else {
  // Fallback : chercher une signature proche
  const regex = /(export async function generate\(\{[^}]*?)template = 'auto',([\s\S]*?)\}\) \{/;
  if (regex.test(content) && !content.includes('format =')) {
    content = content.replace(regex, `$1template = 'auto',\n  format = 'docx',$2}) {`);
    console.log('  ✅ generate() accepte format (fallback)');
    modified = true;
  } else {
    console.log('  ⚠️  Impossible de patcher la signature generate()');
  }
}

// ============================================================
// 3. stepM5 : accepter format + transmettre au fetch
// ============================================================
const stepM5OldSig = 'export async function stepM5({ blocks, design, meta }) {';
const stepM5NewSig = 'export async function stepM5({ blocks, design, meta, format = \'docx\' }) {';

if (content.includes('stepM5({ blocks, design, meta, format')) {
  console.log('  ⏭  stepM5 accepte déjà format');
} else if (content.includes(stepM5OldSig)) {
  content = content.replace(stepM5OldSig, stepM5NewSig);
  console.log('  ✅ stepM5 accepte format');
  modified = true;
}

// Body du fetch stepM5
const fetchBodyOld = `body: JSON.stringify({ blocks, design, meta, format: 'docx' }),`;
const fetchBodyNew = `body: JSON.stringify({ blocks, design, meta, format }),`;

if (content.includes(fetchBodyNew)) {
  console.log('  ⏭  stepM5 transmet déjà format au fetch');
} else if (content.includes(fetchBodyOld)) {
  content = content.replace(fetchBodyOld, fetchBodyNew);
  console.log('  ✅ stepM5 transmet format au fetch');
  modified = true;
} else {
  // Fallback : chercher un JSON.stringify avec format: 'docx'
  const regex = /JSON\.stringify\(\{\s*blocks,\s*design,\s*meta,\s*format:\s*['"]docx['"]\s*\}\)/;
  if (regex.test(content)) {
    content = content.replace(regex, `JSON.stringify({ blocks, design, meta, format })`);
    console.log('  ✅ stepM5 transmet format au fetch (fallback)');
    modified = true;
  } else {
    console.log('  ⚠️  Impossible de patcher le body du fetch stepM5');
  }
}

// ============================================================
// 4. Route /generate : passer format
// ============================================================
const routeGenOld = `const result = await generate({
      text: textInput,
      reformulation: body.reformulation || 'OFF',
      template: body.options?.template || 'auto',
      options: body.options || {},
      meta: body.meta || {},
    });`;
const routeGenNew = `const result = await generate({
      text: textInput,
      reformulation: body.reformulation || 'OFF',
      template: body.options?.template || 'auto',
      format: body.format || 'docx',
      options: body.options || {},
      meta: body.meta || {},
    });`;

if (content.includes("format: body.format || 'docx'")) {
  console.log('  ⏭  route /generate transmet déjà format à generate()');
} else if (content.includes(routeGenOld)) {
  content = content.replace(routeGenOld, routeGenNew);
  console.log('  ✅ route /generate transmet format à generate()');
  modified = true;
} else {
  // Fallback
  const regex = /(const result = await generate\(\{[\s\S]*?)template: body\.options\?\.template \|\| 'auto',(\s*)(options: body\.options \|\| \{\},)/;
  if (regex.test(content) && !content.includes("format: body.format")) {
    content = content.replace(regex, `$1template: body.options?.template || 'auto',$2format: body.format || 'docx',$2$3`);
    console.log('  ✅ route /generate transmet format à generate() (fallback)');
    modified = true;
  } else {
    console.log('  ⚠️  Impossible de patcher la route generate()');
  }
}

// ============================================================
// 5. Route /generate : filename + Content-Type dynamiques
// ============================================================
// Cas mode "text" (fin de route)
const filenameOld = `const filename = \`docforge-\${Date.now()}.docx\`;`;
const filenameNew = `const ext = body.format || 'docx';
      const filename = \`docforge-\${Date.now()}.\${ext}\`;`;

if (content.includes("const ext = body.format || 'docx'")) {
  console.log('  ⏭  filename dynamique déjà en place');
} else if (content.includes(filenameOld)) {
  // On remplace toutes les occurrences (il y en a 2 : mode text + mode blocks)
  content = content.split(filenameOld).join(filenameNew);
  console.log('  ✅ filename dynamique (2 occurrences)');
  modified = true;
}

// Content-Type dynamique
const ctypeOld = `.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`;
const ctypeNew = `.header('Content-Type', MIME_TYPES[body.format || 'docx'])`;

if (content.includes('MIME_TYPES[body.format || \'docx\']')) {
  console.log('  ⏭  Content-Type dynamique déjà en place');
} else if (content.includes(ctypeOld)) {
  content = content.split(ctypeOld).join(ctypeNew);
  console.log('  ✅ Content-Type dynamique (2 occurrences)');
  modified = true;
}

// ============================================================
// 6. Route /generate mode "blocks" : passer format à stepM5
// ============================================================
const blocksModeOld = `const m5 = await stepM5({
          blocks: m4.data.blocks || blocks,
          design: m4.data,
          meta: { title: body.meta?.title || 'Document DocForge AI', ...body.meta },
        });`;
const blocksModeNew = `const m5 = await stepM5({
          blocks: m4.data.blocks || blocks,
          design: m4.data,
          meta: { title: body.meta?.title || 'Document DocForge AI', ...body.meta },
          format: body.format || 'docx',
        });`;

if (content.includes(blocksModeOld)) {
  content = content.replace(blocksModeOld, blocksModeNew);
  console.log('  ✅ mode "blocks" transmet format à stepM5');
  modified = true;
} else if (content.match(/stepM5\(\{[\s\S]*?m4\.data[\s\S]*?\}\);/)) {
  // Fallback : ajouter format: body.format si absent dans ce stepM5
  const match = content.match(/(const m5 = await stepM5\(\{\s*blocks: m4\.data\.blocks \|\| blocks,\s*design: m4\.data,\s*meta: \{[^}]+\},)(\s*)(\}\);)/);
  if (match && !content.includes("format: body.format || 'docx',\n        });")) {
    content = content.replace(match[0], `${match[1]}\n          format: body.format || 'docx',${match[2]}${match[3]}`);
    console.log('  ✅ mode "blocks" transmet format (fallback)');
    modified = true;
  } else {
    console.log('  ⏭  mode "blocks" déjà OK');
  }
}

// ============================================================
// 7. stepM5 dans generate() : passer format
// ============================================================
const stepM5CallOld = `const m5 = await stepM5({
      blocks: design.blocks || blocks,
      design,
      meta: {
        title: meta.title || 'Document DocForge AI',
        ...meta,
      },
    });`;
const stepM5CallNew = `const m5 = await stepM5({
      blocks: design.blocks || blocks,
      design,
      meta: {
        title: meta.title || 'Document DocForge AI',
        ...meta,
      },
      format,
    });`;

if (content.includes(stepM5CallOld)) {
  content = content.replace(stepM5CallOld, stepM5CallNew);
  console.log('  ✅ generate() passe format à stepM5');
  modified = true;
} else if (content.includes('format,\n    });\n    steps.push({ module: \'M5\'')) {
  console.log('  ⏭  generate() passe déjà format à stepM5');
}

// ============================================================
// Écriture
// ============================================================
if (!modified) {
  console.log('\n  ✨ Aucune modification nécessaire (M0 est déjà OK)\n');
  process.exit(0);
}

await writeFile(M0_PATH, content, 'utf-8');
console.log(`\n  ✅ M0 mis à jour (${content.length} octets)\n`);

// ============================================================
// Vérification syntaxe + tests
// ============================================================
console.log('  🔍 Vérification syntaxe...');
try {
  execSync(`node --check "${M0_PATH}"`, { stdio: 'pipe' });
  console.log('  ✅ Syntaxe OK\n');
} catch (err) {
  console.error('  ❌ Erreur de syntaxe :', err.stderr?.toString());
  process.exit(1);
}

console.log('  🧪 Lancement des tests M0...\n');
try {
  const output = execSync(`node "${M0_PATH}" --test`, { encoding: 'utf-8', stdio: 'pipe', cwd: ROOT });
  console.log(output);
} catch (err) {
  console.log(err.stdout?.toString() || '');
  console.error(err.stderr?.toString() || '');
  process.exit(1);
}

console.log('✅ M0 transmet maintenant format à M5.\n');
console.log('Redémarre la stack et re-teste les 4 formats.\n');