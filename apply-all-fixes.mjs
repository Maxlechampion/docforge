#!/usr/bin/env node
/**
 * ============================================================
 * apply-all-fixes.mjs — Correcteur automatique global DocForge AI
 * ------------------------------------------------------------
 * Applique TOUTES les corrections du plan d'action :
 *   1. Nettoyage du repo (.git.backup-*, scripts obsolètes)
 *   2. Vérification absence de clé Groq exposée
 *   3. Nettoyage .gitignore (doublons)
 *   4. Fix backticks dans M1 (préserver code)
 *   5. Fix parsing PDF dans M1 (pdf-parse)
 *   6. Fix ySplit dans M5 XLSX
 *   7. Validation blocks dans M0
 *   8. Réécriture des tests réels M1→M5
 *   9. Vérification syntaxe finale + résumé
 *
 * Usage :
 *   node apply-all-fixes.mjs              # applique tout
 *   node apply-all-fixes.mjs --dry-run    # montre sans modifier
 *   node apply-all-fixes.mjs --skip=cleanup,tests  # skip des étapes
 *
 * Options :
 *   --dry-run           Ne rien écrire (simulation)
 *   --skip=a,b,c        Skip des étapes (cleanup, groq, gitignore, m1-code,
 *                       m1-pdf, m5-xlsx, m0-validate, tests)
 *   --yes               Ne pas demander de confirmation
 * ============================================================
 */

import { readFile, writeFile, mkdir, rm, rename, access, readdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const execAsync = promisify(exec);

// ============================================================
// Configuration
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = __dirname;
const BACKUP_DIR = join(ROOT, '.fix-backup-' + Date.now());

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const AUTO_YES = ARGS.includes('--yes');
const SKIP = new Set(
  ARGS.filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.replace('--skip=', '').split(','))
    .map((s) => s.trim())
);

const STEPS = [
  { id: 'cleanup',      label: '1. Nettoyage du repo (.git.backup, scripts obsolètes)' },
  { id: 'groq',         label: '2. Vérification clés Groq exposées' },
  { id: 'gitignore',    label: '3. Nettoyage .gitignore' },
  { id: 'm1-code',      label: '4. Fix backticks dans M1' },
  { id: 'm1-pdf',       label: '5. Fix parsing PDF dans M1 (pdf-parse)' },
  { id: 'm5-xlsx',      label: '6. Fix ySplit dans M5 XLSX' },
  { id: 'm0-validate',  label: '7. Validation blocks dans M0' },
  { id: 'tests',        label: '8. Réécriture des tests réels M1→M5' },
  { id: 'verify',       label: '9. Vérification syntaxe finale' },
];

// ============================================================
// Utilitaires
// ============================================================
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

const log = {
  title: (s) => console.log(`\n${C.bold}${C.blue}▶ ${s}${C.reset}`),
  ok: (s) => console.log(`  ${C.green}✅${C.reset} ${s}`),
  warn: (s) => console.log(`  ${C.yellow}⚠️${C.reset}  ${s}`),
  err: (s) => console.log(`  ${C.red}❌${C.reset} ${s}`),
  info: (s) => console.log(`  ${C.cyan}ℹ️${C.reset}  ${s}`),
  skip: (s) => console.log(`  ${C.dim}⏭  ${s}${C.reset}`),
  dry: (s) => console.log(`  ${C.dim}🔍 [dry-run] ${s}${C.reset}`),
};

async function safeRead(path) {
  try { return await readFile(path, 'utf-8'); } catch { return null; }
}

async function safeWrite(path, content, { backup = true } = {}) {
  if (DRY_RUN) { log.dry(`write ${path} (${content.length} octets)`); return false; }
  if (backup && existsSync(path)) {
    const backupPath = join(BACKUP_DIR, path.replace(ROOT, '').replace(/^[\\/]+/, ''));
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(path, backupPath);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return true;
}

async function safeDelete(path) {
  if (!existsSync(path)) return false;
  if (DRY_RUN) { log.dry(`delete ${path}`); return false; }
  await rm(path, { recursive: true, force: true });
  return true;
}

async function safeMove(src, dest) {
  if (!existsSync(src)) return false;
  if (DRY_RUN) { log.dry(`move ${src} → ${dest}`); return false; }
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
  return true;
}

async function ask(question) {
  if (AUTO_YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${C.yellow}${question}${C.reset} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ============================================================
// Étape 1 : Nettoyage du repo
// ============================================================
async function stepCleanup() {
  log.title(STEPS[0].label);

  // 1a. .git.backup-*
  const entries = await readdir(ROOT).catch(() => []);
  let backupCount = 0;
  for (const name of entries) {
    if (name.startsWith('.git.backup-') || name === '.git.backup') {
      const full = join(ROOT, name);
      const stats = await stat(full).catch(() => null);
      if (stats && stats.isDirectory()) {
        const deleted = await safeDelete(full);
        if (deleted) { log.ok(`Supprimé : ${name}/`); backupCount++; }
        else log.dry(`would delete ${name}/`);
      }
    }
  }
  if (backupCount === 0 && !DRY_RUN) log.info('Aucun .git.backup-* trouvé');

  // 1b. Scripts de patch obsolètes à la racine
  const obsoleteScripts = [
    'fix-m5.js',
    'fix-all.js',
    'fix-m0-format.js',
    'fix-m0-stepm5.js',
    'extend-m5.js',
    'rebuild-m5.js',
    'scaffold-docforge.js',
    'export-project.js',
    'fix-m0-stepm5.js',
  ];
  const archiveDir = join(ROOT, 'tools', '_archive');
  let movedCount = 0;
  for (const script of obsoleteScripts) {
    const full = join(ROOT, script);
    if (existsSync(full)) {
      const dest = join(archiveDir, script);
      const moved = await safeMove(full, dest);
      if (moved) { log.ok(`Archivé : ${script} → tools/_archive/`); movedCount++; }
      else log.dry(`would move ${script}`);
    }
  }
  if (movedCount === 0 && !DRY_RUN) log.info('Aucun script obsolète à la racine');

  // 1c. Scripts dans scripts/tools/ (obsolètes)
  const obsoleteTools = [
    'scripts/tools/fix-m5-xlsx.js',
    'scripts/tools/fix-xlsx-columns.js',
    'scripts/tools/rebuild-m5.js',
  ];
  for (const tool of obsoleteTools) {
    const full = join(ROOT, tool);
    if (existsSync(full)) {
      const dest = join(archiveDir, 'scripts-tools', basename(tool));
      const moved = await safeMove(full, dest);
      if (moved) log.ok(`Archivé : ${tool} → tools/_archive/scripts-tools/`);
      else log.dry(`would move ${tool}`);
    }
  }

  // 1d. Fichiers *.backup-* dans les modules
  for (const mod of ['m0-orchestrator', 'm1-ingestion', 'm5-office-generation']) {
    const srcDir = join(ROOT, 'modules', mod, 'src');
    if (!existsSync(srcDir)) continue;
    const files = await readdir(srcDir).catch(() => []);
    for (const f of files) {
      if (f.includes('.backup-') || f.endsWith('.bak') || f.endsWith('.broken')) {
        const deleted = await safeDelete(join(srcDir, f));
        if (deleted) log.ok(`Supprimé : modules/${mod}/src/${f}`);
        else log.dry(`would delete modules/${mod}/src/${f}`);
      }
    }
  }

  // 1e. Fichiers binaires de test à la racine
  const testBinaries = ['mon-rapport.docx', 'test-render.docx', 'test-m5-pdf.pdf'];
  for (const f of testBinaries) {
    const full = join(ROOT, f);
    if (existsSync(full)) {
      const deleted = await safeDelete(full);
      if (deleted) log.ok(`Supprimé : ${f}`);
      else log.dry(`would delete ${f}`);
    }
  }

  log.ok(`Étape nettoyage terminée`);
}

// ============================================================
// Étape 2 : Vérification clés Groq
// ============================================================
async function stepGroq() {
  log.title(STEPS[1].label);

  const GROQ_REGEX = /gsk_[A-Za-z0-9]{40,}/g;
  const IGNORE_DIRS = ['node_modules', '.git', '.fix-backup', 'tools/_archive', '.git.backup'];
  const IGNORE_FILES = ['.env'];

  let found = 0;
  const hits = [];

  async function scan(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (IGNORE_DIRS.some((d) => dir.includes(d))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(full);
      } else if (entry.isFile()) {
        if (IGNORE_FILES.includes(entry.name)) continue;
        // Ne scanner que les fichiers texte
        if (!/\.(js|mjs|cjs|json|md|yml|yaml|txt|env|sh|ps1)$/i.test(entry.name) &&
            !entry.name.startsWith('.env')) continue;
        const content = await safeRead(full);
        if (!content) continue;
        const matches = content.match(GROQ_REGEX);
        if (matches) {
          found += matches.length;
          hits.push({ file: full.replace(ROOT, ''), matches });
        }
      }
    }
  }

  await scan(ROOT);

  if (found === 0) {
    log.ok('Aucune clé Groq (gsk_...) exposée dans le repo');
  } else {
    log.err(`${found} clé(s) Groq exposée(s) détectée(s) :`);
    for (const hit of hits) {
      log.err(`  ${hit.file} → ${hit.matches.length} clé(s)`);
    }
    log.warn('ACTION MANUELLE REQUISE :');
    log.warn('  1. Révoque ces clés sur https://console.groq.com/keys');
    log.warn('  2. Remplace-les par des placeholders (GROQ_API_KEY=)');
    log.warn('  3. Crée une nouvelle clé et mets-la uniquement dans .env');
  }
}

// ============================================================
// Étape 3 : Nettoyage .gitignore
// ============================================================
async function stepGitignore() {
  log.title(STEPS[2].label);

  const path = join(ROOT, '.gitignore');
  const content = await safeRead(path);
  if (!content) { log.warn('.gitignore introuvable, création'); }

  const cleanContent = `node_modules/
.env
.env.local
*.log
dist/
build/
coverage/
.DS_Store
.idea/
.vscode/
tmp/
.cache/
*.msi
demo.txt
m1-ingestion.js
package.json.bak

# Fichiers binaires générés
*.docx
*.xlsx
*.pptx
*.pdf
!demo-output.docx

# Backups et archives
*.backup-*
*.bak
*.broken
.fix-backup-*
tools/_archive/

# .git backups
.git.backup*
`;

  const changed = content !== cleanContent;
  if (changed) {
    await safeWrite(path, cleanContent);
    log.ok('.gitignore nettoyé et complété');
  } else {
    log.skip('.gitignore déjà propre');
  }
}

// ============================================================
// Étape 4 : Fix backticks dans M1
// ============================================================
async function stepM1Code() {
  log.title(STEPS[3].label);

  const path = join(ROOT, 'modules/m1-ingestion/src/index.js');
  let content = await safeRead(path);
  if (!content) { log.err('M1 introuvable'); return; }

  const original = content;

  // Ancien bloc à remplacer (plusieurs variantes possibles)
  const oldBlock1 = `  // 5. Supprimer TOUS les backticks (inline code et blocs)
  cleaned = cleaned.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, ''); // blocs multi-lignes
  cleaned = cleaned.replace(/\`[^\`]*\`/g, ''); // inline code
  cleaned = cleaned.replace(/\`/g, ''); // backticks restants`;

  const newBlock = `  // 5. Backticks : on PRÉSERVE le contenu des blocs de code, on retire juste les marqueurs
  // Blocs multi-lignes \`\`\`lang ... \`\`\` → on garde l'intérieur
  cleaned = cleaned.replace(/\`\`\`[\\w]*\\n?([\\s\\S]*?)\`\`\`/g, (match, code) => code.trim());
  // Inline code \`...\` → on garde l'intérieur
  cleaned = cleaned.replace(/\`([^\`]+)\`/g, '$1');
  // Backticks orphelins restants
  cleaned = cleaned.replace(/\`/g, '');`;

  // Détecter les variants courants
  const patterns = [
    /\/\/ 5\. Supprimer TOUS les backticks[^\n]*\n[^\n]+\n[^\n]+\n[^\n]+/,
    /cleaned = cleaned\.replace\(\/```\[\\s\\S\]\*\?```\/g, ''\);[^\n]*\n[^\n]+\n[^\n]+/,
  ];

  let replaced = false;
  for (const pat of patterns) {
    if (pat.test(content)) {
      content = content.replace(pat, newBlock);
      replaced = true;
      break;
    }
  }

  if (!replaced && content.includes(newBlock)) {
    log.skip('Fix backticks déjà appliqué');
    return;
  }

  if (!replaced) {
    log.warn('Pattern backticks non reconnu, recherche manuelle...');
    // Fallback : chercher ligne par ligne
    if (content.includes("cleaned.replace(/```[\\s\\S]*?```/g, '')")) {
      content = content.replace(
        /cleaned = cleaned\.replace\(\/```\[\\s\\S\]\*\?```\/g, ''\); \/\/ blocs multi-lignes[\s\S]*?cleaned = cleaned\.replace\(\/`\/g, ''\); \/\/ backticks restants/,
        newBlock
      );
      replaced = true;
    }
  }

  if (replaced && content !== original) {
    await safeWrite(path, content);
    log.ok('Fix backticks appliqué (contenu des blocs de code préservé)');
  } else if (!replaced) {
    log.warn('Aucune modification (pattern introuvable)');
  }
}

// ============================================================
// Étape 5 : Fix parsing PDF dans M1
// ============================================================
async function stepM1Pdf() {
  log.title(STEPS[4].label);

  const path = join(ROOT, 'modules/m1-ingestion/src/index.js');
  const pkgPath = join(ROOT, 'modules/m1-ingestion/package.json');
  let content = await safeRead(path);
  let pkg = await safeRead(pkgPath);

  if (!content || !pkg) { log.err('M1 ou package.json introuvable'); return; }

  // 5a. Ajouter la dépendance pdf-parse dans package.json
  const pkgJson = JSON.parse(pkg);
  if (!pkgJson.dependencies['pdf-parse']) {
    pkgJson.dependencies['pdf-parse'] = '^1.1.1';
    await safeWrite(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
    log.ok('Ajout de pdf-parse dans dependencies M1');
  } else {
    log.skip('pdf-parse déjà dans dependencies');
  }

  // 5b. Ajouter l'import en haut
  if (!content.includes("import pdfParse from 'pdf-parse")) {
    content = content.replace(
      /(import\s+JSZip\s+from\s+['"]jszip['"];)/,
      `$1\nimport pdfParse from 'pdf-parse';`
    );
    log.ok('Import pdf-parse ajouté');
  } else {
    log.skip('Import pdf-parse déjà présent');
  }

  // 5c. Remplacer la fonction parsePdf par la version pdf-parse
  const newParsePdf = `async function parsePdf(buffer) {
  const warnings = [];
  try {
    // pdf-parse gère les PDFs avec couche texte (FlateDecode, CID fonts, etc.)
    const data = await withTimeout(pdfParse(buffer), PARSE_TIMEOUT_MS, 'pdf');
    const text = (data.text || '').replace(/\\s+/g, ' ').trim();
    if (text.length < 10) {
      warnings.push(
        'PDF sans couche texte détectée (probablement scanné). Astuce : uploadez une image pour l\\'OCR.'
      );
    }
    return { text, warnings };
  } catch (err) {
    warnings.push(\`Extraction PDF en échec: \${err.message}\`);
    return { text: '', warnings };
  }
}`;

  // Chercher la fonction parsePdf existante
  const parsePdfRegex = /async function parsePdf\(buffer\) \{[\s\S]*?\n\}/;
  if (parsePdfRegex.test(content)) {
    content = content.replace(parsePdfRegex, newParsePdf);
    log.ok('Fonction parsePdf remplacée par pdf-parse');
  } else {
    log.warn('Fonction parsePdf introuvable, remplacement manuel requis');
  }

  // 5d. Nettoyer les fonctions obsolètes (decodePdfString plus utilisée)
  const decodeRegex = /function decodePdfString\(s\) \{[\s\S]*?\n\}\n\n/;
  if (decodeRegex.test(content)) {
    content = content.replace(decodeRegex, '');
    log.ok('Fonction obsolète decodePdfString supprimée');
  }

  await safeWrite(path, content);
  log.info('Pense à relancer : npm install (dans modules/m1-ingestion/)');
}

// ============================================================
// Étape 6 : Fix ySplit dans M5 XLSX
// ============================================================
async function stepM5Xlsx() {
  log.title(STEPS[5].label);

  const path = join(ROOT, 'modules/m5-office-generation/src/index.js');
  let content = await safeRead(path);
  if (!content) { log.err('M5 introuvable'); return; }

  const original = content;

  // Freeze les 2 premières lignes (titre + généré le)
  const fixes = [
    {
      old: `sheet.views = [{ state: 'frozen', ySplit: 0 }];`,
      new: `sheet.views = [{ state: 'frozen', ySplit: 2 }]; // freeze titre + date`,
    },
    {
      old: `sheet.views = [{ state: 'frozen', ySplit: 0 }]`,
      new: `sheet.views = [{ state: 'frozen', ySplit: 2 }] // freeze titre + date`,
    },
  ];

  let replaced = 0;
  for (const fix of fixes) {
    if (content.includes(fix.old)) {
      content = content.split(fix.old).join(fix.new);
      replaced++;
    }
  }

  if (replaced > 0 && content !== original) {
    await safeWrite(path, content);
    log.ok(`Fix ySplit appliqué (${replaced} occurrence(s))`);
  } else if (content.includes("ySplit: 2")) {
    log.skip('ySplit déjà à 2');
  } else {
    log.warn('Pattern ySplit introuvable');
  }
}

// ============================================================
// Étape 7 : Validation blocks dans M0
// ============================================================
async function stepM0Validate() {
  log.title(STEPS[6].label);

  const path = join(ROOT, 'modules/m0-orchestrator/src/index.js');
  let content = await safeRead(path);
  if (!content) { log.err('M0 introuvable'); return; }

  const original = content;

  // Ajouter une fonction de validation après les imports
  const validatorFn = `
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
      return { ok: false, error: \`blocks[\${i}] n'est pas un objet\` };
    }
    if (!VALID_LEVELS.has(b.level)) {
      return { ok: false, error: \`blocks[\${i}].level invalide : \${b.level}\` };
    }
    if (!VALID_TYPES.has(b.type)) {
      return { ok: false, error: \`blocks[\${i}].type invalide : \${b.type}\` };
    }
    if (b.type === 'table') {
      if (!Array.isArray(b.rows) || b.rows.length === 0) {
        return { ok: false, error: \`blocks[\${i}] tableau sans rows\` };
      }
    } else if (typeof b.content !== 'string') {
      return { ok: false, error: \`blocks[\${i}].content doit être une string\` };
    }
  }
  return { ok: true };
}
`;

  // Insérer après les imports (avant la première const CONFIG ou MIME_TYPES)
  if (!content.includes('function validateBlocks(')) {
    const insertAfter = /(const MIME_TYPES = \{[\s\S]*?\};)/;
    if (insertAfter.test(content)) {
      content = content.replace(insertAfter, `$1\n${validatorFn}`);
      log.ok('Fonction validateBlocks ajoutée');
    } else {
      // Fallback : insérer après le dernier import
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
      }
      if (lastImportIdx >= 0) {
        lines.splice(lastImportIdx + 1, 0, validatorFn);
        content = lines.join('\n');
        log.ok('Fonction validateBlocks ajoutée');
      }
    }
  } else {
    log.skip('validateBlocks déjà présente');
  }

  // Appeler validateBlocks quand blocks fournis directement
  const oldBlockCheck = `      if (blocksInput && Array.isArray(blocksInput)) {
        // Mode avancé : on saute M1`;
  const newBlockCheck = `      if (blocksInput && Array.isArray(blocksInput)) {
        // Validation du schéma v1
        const validation = validateBlocks(blocksInput);
        if (!validation.ok) {
          return reply.code(400).send({ error: 'Blocks invalides', details: validation.error });
        }
        // Mode avancé : on saute M1`;

  if (content.includes(oldBlockCheck) && !content.includes('validateBlocks(blocksInput)')) {
    content = content.replace(oldBlockCheck, newBlockCheck);
    log.ok('Validation ajoutée sur mode "blocks direct"');
  } else if (content.includes('validateBlocks(blocksInput)')) {
    log.skip('Validation blocks direct déjà présente');
  }

  // Appeler validateBlocks pour M1 résultat (fallback inclus : on saute)
  // → M1 retourne toujours des blocs valides (même fallback)

  if (content !== original) {
    await safeWrite(path, content);
    log.ok('Validation blocks ajoutée dans M0');
  }
}

// ============================================================
// Étape 8 : Réécriture des tests réels
// ============================================================
async function stepTests() {
  log.title(STEPS[7].label);

  const TESTS = {
    'm1-ingestion': `import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, ingestPaste } from '../src/index.js';

test('m1-ingestion — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'm1');
  await app.close();
});

test('m1-ingestion — paste avec H1 + liste', async () => {
  const res = await ingestPaste({ text: '# Titre\\n- point A\\n- point B\\nParagraphe.' });
  assert.equal(res.version, '1.0');
  assert.equal(res.blocks[0].level, 'h1');
  assert.equal(res.blocks[1].type, 'list');
  assert.equal(res.meta.source, 'paste');
});

test('m1-ingestion — paste vide rejette', async () => {
  await assert.rejects(() => ingestPaste({ text: '   ' }), /text requis/);
});

test('m1-ingestion — /m1/paste respecte contrat', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST', url: '/m1/paste',
    payload: { text: '# T\\n- a' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.version, '1.0');
  assert.ok(Array.isArray(body.blocks));
  await app.close();
});
`,

    'm2-semantic-analysis': `import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, analyzeWithHeuristics } from '../src/index.js';

test('m2 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M2');
  await app.close();
});

test('m2 — heuristique : H1 préservé', async () => {
  const out = analyzeWithHeuristics([
    { level: 'h1', type: 'text', content: 'Titre' },
  ]);
  assert.equal(out[0].level, 'h1');
});

test('m2 — heuristique : détection tableau clé:valeur', async () => {
  const out = analyzeWithHeuristics([
    { level: 'body', type: 'text', content: 'Nom : Alice\\nÂge : 30\\nVille : Cotonou' },
  ]);
  assert.equal(out[0].type, 'table');
  assert.equal(out[0].rows.length, 3);
  assert.deepEqual(out[0].rows[0], ['Nom', 'Alice']);
});

test('m2 — /m2/analyze blocks vide → 400', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST', url: '/m2/analyze', payload: { blocks: [] },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});
`,

    'm3-reformulation': `import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, reformulate, reformulateOff } from '../src/index.js';

test('m3 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M3');
  await app.close();
});

test('m3 — mode OFF : passe-plat pur', async () => {
  const blocks = [
    { level: 'body', type: 'text', content: 'Texte inchangé.' },
    { level: 'body', type: 'table', content: '', rows: [['A', '1']] },
  ];
  const res = await reformulate({ blocks, mode: 'OFF' });
  assert.equal(res.meta.mode, 'OFF');
  assert.equal(res.meta.llm_used, false);
  assert.deepEqual(res.blocks, blocks);
});

test('m3 — reformulateOff préserve les tableaux', () => {
  const input = [{ level: 'body', type: 'table', content: '', rows: [['X', 'Y']] }];
  const out = reformulateOff(input);
  assert.deepEqual(out[0].rows, [['X', 'Y']]);
});

test('m3 — mode invalide → 400', async () => {
  await assert.rejects(
    () => reformulate({ blocks: [{ level: 'body', type: 'text', content: 'x' }], mode: 'MAYBE' }),
    /mode doit être/
  );
});
`,

    'm4-design': `import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp, design, TEMPLATES } from '../src/index.js';

const financeBlocks = [
  { level: 'h1', type: 'text', content: 'Bilan financier 2026' },
  { level: 'body', type: 'text', content: 'Chiffre d\\'affaires : 15M FCFA.' },
];

test('m4 — /health répond', async () => {
  const app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().module, 'M4');
  await app.close();
});

test('m4 — template consulting forcé', async () => {
  const res = await design({ blocks: financeBlocks, options: { template: 'consulting' } });
  assert.equal(res.design.template, 'consulting');
  assert.equal(res.design.theme.primary, '#1e40af');
});

test('m4 — 5 templates déclarés', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [
    'academic', 'annual-report', 'consulting', 'minimal', 'startup',
  ]);
});

test('m4 — logo préservé', async () => {
  const res = await design({
    blocks: financeBlocks,
    options: { template: 'consulting', logo: 'data:image/png;base64,xxx' },
  });
  assert.ok(res.design.logo);
  assert.equal(res.design.logo.dataUri, 'data:image/png;base64,xxx');
});
`,

    'm5-office-generation': `import { test } from 'node:test';
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
`,
  };

  for (const [mod, testContent] of Object.entries(TESTS)) {
    const path = join(ROOT, 'modules', mod, 'tests', 'smoke.test.js');
    const original = await safeRead(path);
    if (original !== testContent) {
      await safeWrite(path, testContent);
      log.ok(`Tests réels écrits : modules/${mod}/tests/smoke.test.js`);
    } else {
      log.skip(`modules/${mod}/tests/smoke.test.js déjà à jour`);
    }
  }
}

// ============================================================
// Étape 9 : Vérification syntaxe finale
// ============================================================
async function stepVerify() {
  log.title(STEPS[8].label);

  const files = [
    'modules/m0-orchestrator/src/index.js',
    'modules/m1-ingestion/src/index.js',
    'modules/m2-semantic-analysis/src/index.js',
    'modules/m3-reformulation/src/index.js',
    'modules/m4-design/src/index.js',
    'modules/m5-office-generation/src/index.js',
    'modules/m1-ingestion/tests/smoke.test.js',
    'modules/m2-semantic-analysis/tests/smoke.test.js',
    'modules/m3-reformulation/tests/smoke.test.js',
    'modules/m4-design/tests/smoke.test.js',
    'modules/m5-office-generation/tests/smoke.test.js',
  ];

  let ok = 0;
  let failed = 0;
  for (const f of files) {
    const full = join(ROOT, f);
    if (!existsSync(full)) { log.skip(`${f} absent`); continue; }
    try {
      await execAsync(`node --check "${full}"`);
      log.ok(`${f}`);
      ok++;
    } catch (err) {
      log.err(`${f} : ${err.stderr?.split('\n')[0] || err.message}`);
      failed++;
    }
  }

  log.info(`${ok} OK, ${failed} échec(s)`);
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(`\n${C.bold}${C.magenta}🔧 DocForge AI — Correcteur automatique global${C.reset}`);
  if (DRY_RUN) console.log(`${C.yellow}🔍 Mode --dry-run : aucun fichier ne sera modifié${C.reset}`);
  if (SKIP.size > 0) console.log(`${C.yellow}⏭  Skip : ${[...SKIP].join(', ')}${C.reset}`);
  console.log(`${C.dim}Backups dans : ${BACKUP_DIR}${C.reset}\n`);

  if (!DRY_RUN) {
    if (!AUTO_YES) {
      const proceed = await ask('Appliquer toutes les corrections ?');
      if (!proceed) {
        console.log('Annulé.\n');
        process.exit(0);
      }
    }
    await mkdir(BACKUP_DIR, { recursive: true });
  }

  const steps = [
    { id: 'cleanup',      fn: stepCleanup },
    { id: 'groq',         fn: stepGroq },
    { id: 'gitignore',    fn: stepGitignore },
    { id: 'm1-code',      fn: stepM1Code },
    { id: 'm1-pdf',       fn: stepM1Pdf },
    { id: 'm5-xlsx',      fn: stepM5Xlsx },
    { id: 'm0-validate',  fn: stepM0Validate },
    { id: 'tests',        fn: stepTests },
    { id: 'verify',       fn: stepVerify },
  ];

  for (const step of steps) {
    if (SKIP.has(step.id)) {
      console.log(`\n${C.dim}⏭  Skip : ${step.id}${C.reset}`);
      continue;
    }
    try {
      await step.fn();
    } catch (err) {
      log.err(`Erreur dans ${step.id} : ${err.message}`);
      console.error(err);
    }
  }

  console.log(`\n${C.bold}${C.green}✨ Corrections appliquées${C.reset}\n`);

  if (!DRY_RUN) {
    console.log(`${C.bold}Prochaines étapes :${C.reset}`);
    console.log(`  ${C.cyan}1.${C.reset} cd modules/m1-ingestion && npm install     ${C.dim}(pdf-parse ajouté)${C.reset}`);
    console.log(`  ${C.cyan}2.${C.reset} npm test                                  ${C.dim}(à la racine)${C.reset}`);
    console.log(`  ${C.cyan}3.${C.reset} node scripts/start-full.js                ${C.dim}(relance la stack)${C.reset}`);
    console.log(`  ${C.cyan}4.${C.reset} git add . && git commit -m "chore: apply all fixes"`);
    console.log(`\n${C.dim}Backups disponibles dans : ${BACKUP_DIR}${C.reset}`);
    console.log(`${C.dim}En cas de problème : rm -rf .fix-backup-* puis git restore .${C.reset}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${C.red}Erreur fatale :${C.reset}`, err);
  process.exit(1);
});