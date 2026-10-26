#!/usr/bin/env node
/**
 * fix-xlsx-columns.js — Corrige le bug ExcelJS column.equivalentTo
 * ============================================================
 * Le bug vient de sheet.columns.push() après écriture de cellules.
 * Correction : ne plus modifier sheet.columns dynamiquement.
 * On garde 2 colonnes fixes (A+B), les tableaux utilisent les colonnes C, D…
 * avec des largeurs définies à l'avance.
 *
 * Usage :
 *   node fix-xlsx-columns.js
 * ============================================================
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const M5_PATH = join(ROOT, 'modules/m5-office-generation/src/index.js');
const BACKUP = M5_PATH + '.backup-' + Date.now();

console.log('\n🔧 fix-xlsx-columns.js — Correction ExcelJS\n');

if (!existsSync(M5_PATH)) {
  console.error('  ❌ M5 introuvable');
  process.exit(1);
}

await copyFile(M5_PATH, BACKUP);
console.log(`  💾 Sauvegarde : ${BACKUP.split(/[\\/]/).pop()}\n`);

let content = await readFile(M5_PATH, 'utf-8');
const original = content;
let fixCount = 0;

// ============================================================
// FIX 1 : Retirer la boucle qui push des colonnes dynamiquement
// ============================================================
// Chercher : `while (sheet.columns.length < colCount + 1) { sheet.columns.push({ width: 20 }); }`

const badWhile = `      while (sheet.columns.length < colCount + 1) {
        sheet.columns.push({ width: 20 });
      }

`;

if (content.includes(badWhile)) {
  content = content.replace(badWhile, '');
  console.log('  ✅ Boucle de push de colonnes retirée');
  fixCount++;
} else {
  // Chercher une variante (sur une seule ligne)
  const badWhileRegex = /\s*while\s*\(\s*sheet\.columns\.length\s*<\s*colCount\s*\+\s*1\s*\)\s*\{\s*sheet\.columns\.push\s*\(\s*\{\s*width:\s*20\s*\}\s*\)\s*;\s*\}\s*\n?/;
  if (badWhileRegex.test(content)) {
    content = content.replace(badWhileRegex, '\n');
    console.log('  ✅ Boucle de push de colonnes retirée (regex)');
    fixCount++;
  } else {
    console.log('  ⚠️  Boucle `while (sheet.columns.length < colCount)` introuvable');
  }
}

// ============================================================
// FIX 2 : Redéfinir sheet.columns avec un nombre fixe (10)
// ============================================================
// Chercher : `sheet.columns = [{ width: 6 }, { width: 80 }];`
// Remplacer par une version avec 10 colonnes prédéfinies

const badCols = `  sheet.columns = [{ width: 6 }, { width: 80 }];`;
const goodCols = `  sheet.columns = [
    { width: 6 },
    { width: 80 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
  ];`;

if (content.includes(badCols)) {
  content = content.replace(badCols, goodCols);
  console.log('  ✅ Colonnes fixes (12) définies à l\'avance');
  fixCount++;
} else if (content.includes('sheet.columns = [{ width: 6 }, { width: 80 }]')) {
  // Variante sans point-virgule
  content = content.replace(/sheet\.columns = \[\{ width: 6 \}, \{ width: 80 \}\]/, goodCols.replace(/;$/, ''));
  console.log('  ✅ Colonnes fixes (12) définies à l\'avance (variante)');
  fixCount++;
} else {
  console.log('  ⚠️  sheet.columns = [{ width: 6 }, { width: 80 }] introuvable');
}

// ============================================================
// FIX 3 : Sommaire aussi — colonnes fixes
// ============================================================
const badSummaryCols = `  summary.columns = [{ width: 10 }, { width: 80 }];`;
const goodSummaryCols = `  summary.columns = [
    { width: 10 },
    { width: 80 },
  ];`;

if (content.includes(badSummaryCols)) {
  content = content.replace(badSummaryCols, goodSummaryCols);
  console.log('  ✅ Sommaire : colonnes fixes');
  fixCount++;
}

// ============================================================
// Écriture
// ============================================================
if (content === original || fixCount === 0) {
  console.log('\n  ⚠️  Aucune correction appliquée — vérifie manuellement\n');
  process.exit(0);
}

await writeFile(M5_PATH, content, 'utf-8');
console.log(`\n  ✅ ${fixCount} correction(s) appliquée(s)\n`);

// Vérif syntaxe
console.log('  🔍 Vérification syntaxe...');
try {
  execSync(`node --check "${M5_PATH}"`, { stdio: 'pipe' });
  console.log('  ✅ Syntaxe OK\n');
} catch (err) {
  console.error('  ❌ Erreur de syntaxe :', err.stderr?.toString());
  process.exit(1);
}

// Tests
console.log('  🧪 Tests M5...\n');
try {
  const output = execSync(`node "${M5_PATH}" --test`, { encoding: 'utf-8', stdio: 'pipe', cwd: ROOT });
  console.log(output);
} catch (err) {
  console.log(err.stdout?.toString() || '');
  console.error(err.stderr?.toString() || '');
  process.exit(1);
}

console.log('✅ Correction terminée.\n');
console.log('Redémarre : node scripts\\start-full.js\n');