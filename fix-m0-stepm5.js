#!/usr/bin/env node
/**
 * fix-m0-stepm5.js — Ajoute `format` dans les 2 appels stepM5()
 * ============================================================
 * Corrige automatiquement :
 *   1. L'appel stepM5 dans generate() → ajoute `format,`
 *   2. L'appel stepM5 dans la route /generate → ajoute `format: body.format || 'docx',`
 *
 * Usage :
 *   node fix-m0-stepm5.js
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

console.log('\n🔧 fix-m0-stepm5.js — Ajout de format dans les 2 appels stepM5()\n');

if (!existsSync(M0_PATH)) {
  console.error('  ❌ M0 introuvable :', M0_PATH);
  process.exit(1);
}

await copyFile(M0_PATH, BACKUP);
console.log(`  💾 Sauvegarde : ${BACKUP.split(/[\\/]/).pop()}\n`);

let content = await readFile(M0_PATH, 'utf-8');
const originalContent = content;
let fixCount = 0;

// ============================================================
// FIX 1 — Appel stepM5 dans generate()
// ============================================================
// Cherche le bloc stepM5 dans generate() (contexte : design.blocks || blocks)
// et ajoute `format,` avant `});` si absent

const genCallRegex = /(const m5 = await stepM5\(\{\s*blocks: design\.blocks \|\| blocks,\s*design,\s*meta: \{[\s\S]*?\},)(\s*)(\}\);)/;

if (genCallRegex.test(content)) {
  const match = content.match(genCallRegex);
  if (match[0].includes('format,')) {
    console.log('  ⏭  FIX 1 : generate() passe déjà format');
  } else {
    content = content.replace(genCallRegex, `$1\n      format,$2$3`);
    console.log('  ✅ FIX 1 : generate() passe format à stepM5');
    fixCount++;
  }
} else {
  // Fallback : recherche plus souple
  const looseRegex = /(const m5 = await stepM5\(\{)([\s\S]*?)(blocks: design\.blocks \|\| blocks,[\s\S]*?meta: \{[\s\S]*?\},)(\s*)(\}\);)/;
  if (looseRegex.test(content) && !content.includes('format,')) {
    content = content.replace(looseRegex, `$1$2$3\n      format,$4$5`);
    console.log('  ✅ FIX 1 : generate() passe format à stepM5 (fallback)');
    fixCount++;
  } else {
    console.log('  ⚠️  FIX 1 : impossible de localiser le bloc stepM5 dans generate()');
  }
}

// ============================================================
// FIX 2 — Appel stepM5 dans la route /generate (mode blocks)
// ============================================================
const blocksCallRegex = /(const m5 = await stepM5\(\{\s*blocks: m4\.data\.blocks \|\| blocks,\s*design: m4\.data,\s*meta: \{[\s\S]*?\},)(\s*)(\}\);)/;

if (blocksCallRegex.test(content)) {
  const match = content.match(blocksCallRegex);
  if (match[0].includes('format')) {
    console.log('  ⏭  FIX 2 : route /generate passe déjà format');
  } else {
    content = content.replace(
      blocksCallRegex,
      `$1\n          format: body.format || 'docx',$2$3`
    );
    console.log('  ✅ FIX 2 : route /generate passe format à stepM5');
    fixCount++;
  }
} else {
  // Fallback
  const looseRegex = /(const m5 = await stepM5\(\{)([\s\S]*?)(blocks: m4\.data\.blocks \|\| blocks,[\s\S]*?meta: \{[^}]+\},)(\s*)(\}\);)/;
  if (looseRegex.test(content) && !content.includes("format: body.format")) {
    content = content.replace(
      looseRegex,
      `$1$2$3\n          format: body.format || 'docx',$4$5`
    );
    console.log('  ✅ FIX 2 : route /generate passe format à stepM5 (fallback)');
    fixCount++;
  } else {
    console.log('  ⚠️  FIX 2 : impossible de localiser le bloc stepM5 dans la route /generate');
  }
}

// ============================================================
// FIX 3 — Vérifier generate() accepte bien format (sécurité)
// ============================================================
if (content.includes("format = 'docx'") && content.includes('export async function generate')) {
  console.log('  ⏭  FIX 3 : generate() accepte déjà format');
} else {
  console.log('  ⚠️  FIX 3 : generate() n\'a pas le paramètre format');
}

// ============================================================
// FIX 4 — Vérifier route /generate transmet format à generate()
// ============================================================
if (content.includes("format: body.format || 'docx',\n      options")) {
  console.log('  ⏭  FIX 4 : route /generate transmet format à generate()');
} else if (/const result = await generate\(\{[\s\S]*?template: body\.options\?\.template \|\| 'auto',/.test(content)) {
  // Ajouter format si absent
  const regex = /(const result = await generate\(\{[\s\S]*?template: body\.options\?\.template \|\| 'auto',)(\s*)(options: body\.options \|\| \{\},)/;
  if (regex.test(content) && !content.includes("format: body.format")) {
    content = content.replace(regex, `$1$2format: body.format || 'docx',$2$3`);
    console.log('  ✅ FIX 4 : route /generate transmet format à generate()');
    fixCount++;
  } else {
    console.log('  ⏭  FIX 4 : déjà OK ou introuvable');
  }
}

// ============================================================
// Écriture
// ============================================================
if (content === originalContent) {
  console.log('\n  ✨ Aucune modification nécessaire.\n');
  process.exit(0);
}

await writeFile(M0_PATH, content, 'utf-8');
console.log(`\n  ✅ M0 mis à jour (${content.length} octets, ${fixCount} correction(s))\n`);

// ============================================================
// Vérification syntaxe
// ============================================================
console.log('  🔍 Vérification syntaxe...');
try {
  execSync(`node --check "${M0_PATH}"`, { stdio: 'pipe' });
  console.log('  ✅ Syntaxe OK\n');
} catch (err) {
  console.error('  ❌ Erreur de syntaxe :', err.stderr?.toString());
  process.exit(1);
}

// ============================================================
// Tests
// ============================================================
console.log('  🧪 Lancement des tests M0...\n');
try {
  const output = execSync(`node "${M0_PATH}" --test`, {
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

console.log('✅ M0 transmet format à stepM5 dans les 2 modes.\n');
console.log('Redémarre la stack :');
console.log('  node scripts\\start-full.js\n');
console.log('Puis re-teste les 4 formats.\n');