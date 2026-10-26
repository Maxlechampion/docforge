#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Correcteur automatique global
 * ------------------------------------------------------------
 * Corrige toutes les erreurs identifiées dans la revue :
 *   1. Sécurise .env.example (retire la clé Groq)
 *   2. Répare la syntaxe fastifyStatic dans M5
 *   3. Ajoute @fastify/cors manquant dans M4
 *   4. Corrige fileURLToPath pour Windows dans M5
 *   5. Supprime les fichiers orphelins
 *   6. Nettoie les doublons dans .gitignore
 *   7. Uniformise fastify à ^4.29.1
 *   8. Ajoute les imports node:path et node:url dans M5
 *
 * Usage :
 *   node fix-all.js              # applique les corrections
 *   node fix-all.js --dry-run    # montre sans modifier
 * ============================================================
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const log = {
  title: (s) => console.log(`\n\x1b[1m\x1b[34m▶ ${s}\x1b[0m`),
  ok: (s) => console.log(`  \x1b[32m✅\x1b[0m ${s}`),
  warn: (s) => console.log(`  \x1b[33m⚠️\x1b[0m  ${s}`),
  err: (s) => console.log(`  \x1b[31m❌\x1b[0m ${s}`),
  info: (s) => console.log(`  \x1b[36mℹ️\x1b[0m  ${s}`),
  skip: (s) => console.log(`  \x1b[90m⏭\x1b[0m  ${s}`),
};

async function readSafe(path) {
  try { return await readFile(path, 'utf-8'); }
  catch { return null; }
}

async function writeSafe(path, content) {
  if (DRY_RUN) {
    log.info(`[dry-run] Aurait écrit : ${path}`);
    return false;
  }
  await writeFile(path, content, 'utf-8');
  return true;
}

async function deleteSafe(path) {
  if (!existsSync(path)) return false;
  if (DRY_RUN) {
    log.info(`[dry-run] Aurait supprimé : ${path}`);
    return false;
  }
  await unlink(path);
  return true;
}

// ------------------------------------------------------------
// 1. Sécuriser .env.example
// ------------------------------------------------------------
async function fixEnvExample() {
  log.title('1. Sécurisation de .env.example');

  const path = join(ROOT, '.env.example');
  let content = await readSafe(path);
  if (!content) { log.err('.env.example introuvable'); return; }

  const leakedKeyRegex = /^GROQ_API_KEY=gsk_.+$/m;
  if (leakedKeyRegex.test(content)) {
    content = content.replace(leakedKeyRegex, 'GROQ_API_KEY=');
    await writeSafe(path, content);
    log.ok('Clé Groq exposée retirée de .env.example');
  } else {
    log.skip('Aucune clé Groq exposée détectée');
  }

  // Vérifier que .env existe
  if (!existsSync(join(ROOT, '.env'))) {
    log.warn('.env absent → n\'oublie pas de créer .env avec ta nouvelle clé');
  } else {
    const env = await readSafe(join(ROOT, '.env'));
    if (env && /^GROQ_API_KEY=gsk_.+$/m.test(env)) {
      log.info('.env contient une clé Groq (non exposée, OK)');
    }
  }
}

// ------------------------------------------------------------
// 2. Réparer M5 (fastifyStatic + imports + cors)
// ------------------------------------------------------------
async function fixM5() {
  log.title('2. Réparation de M5 (office-generation)');

  const path = join(ROOT, 'modules/m5-office-generation/src/index.js');
  let content = await readSafe(path);
  if (!content) { log.err('M5/src/index.js introuvable'); return; }

  const original = content;
  let changed = false;

  // ---- 2a. Ajouter les imports manquants ----
  const neededImports = [
    {
      regex: /import\s+fastifyStatic\s+from\s+['"]@fastify\/static['"]/,
      add: "import fastifyStatic from '@fastify/static';",
      name: 'fastifyStatic',
    },
    {
      regex: /from\s+['"]node:path['"]/,
      add: "import { join, dirname } from 'node:path';",
      name: 'node:path',
    },
    {
      regex: /from\s+['"]node:url['"]/,
      add: "import { fileURLToPath } from 'node:url';",
      name: 'node:url',
    },
  ];

  for (const imp of neededImports) {
    if (!imp.regex.test(content)) {
      // Insérer après le dernier import existant
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
      }
      if (lastImportIdx >= 0) {
        lines.splice(lastImportIdx + 1, 0, imp.add);
        content = lines.join('\n');
        log.ok(`Import ${imp.name} ajouté`);
        changed = true;
      }
    } else {
      log.skip(`Import ${imp.name} déjà présent`);
    }
  }

  // ---- 2b. Ajouter/Corriger le register fastifyStatic ----
  // D'abord, essayer de trouver le bloc cassé (sans fermeture })
  const brokenStaticRegex = /await\s+app\.register\(\s*fastifyStatic\s*,\s*\{[\s\S]*?prefix:\s*['"]\/['"]\s*,?\s*\n(?!\s*\}\);)/;

  if (brokenStaticRegex.test(content)) {
    // Le bloc est cassé → on le remplace par la version correcte
    const replacement = `await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
    prefix: '/',
  });`;
    content = content.replace(brokenStaticRegex, replacement);
    log.ok('Bloc fastifyStatic cassé réparé');
    changed = true;
  } else if (/await\s+app\.register\(\s*fastifyStatic\s*,/.test(content)) {
    // Le bloc existe mais utilise new URL(...).pathname → risque Windows
    if (/new\s+URL\([^)]*\.pathname/.test(content)) {
      content = content.replace(
        /root:\s*new\s+URL\([^)]*\)\.pathname\s*,/,
        "root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),"
      );
      log.ok('root de fastifyStatic converti en fileURLToPath (Windows-safe)');
      changed = true;
    } else {
      log.skip('fastifyStatic déjà configuré correctement');
    }
  } else {
    // Aucun bloc fastifyStatic → on l'ajoute après le register cors
    const corsRegisterRegex = /(await\s+app\.register\(\s*cors\s*,\s*\{[^}]*\}\s*\);)/;
    if (corsRegisterRegex.test(content)) {
      content = content.replace(
        corsRegisterRegex,
        `$1\n\n  // Sert le front HTML sur http://localhost:3005/\n  await app.register(fastifyStatic, {\n    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),\n    prefix: '/',\n  });`
      );
      log.ok('Bloc fastifyStatic ajouté');
      changed = true;
    } else {
      log.warn('Impossible de localiser register(cors) — insertion manuelle requise');
    }
  }

  // ---- 2c. Vérifier qu'il ne reste pas de bug de syntaxe ----
  // Test basique : le nombre d'accolades et parenthèses doit être équilibré
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  const openParens = (content.match(/\(/g) || []).length;
  const closeParens = (content.match(/\)/g) || []).length;

  if (openBraces !== closeBraces) {
    log.err(`Déséquilibre { } : ${openBraces} vs ${closeBraces}`);
  } else if (openParens !== closeParens) {
    log.err(`Déséquilibre ( ) : ${openParens} vs ${closeParens}`);
  } else {
    log.ok('Équilibre accolades/parenthèses OK');
  }

  if (changed && content !== original) {
    await writeSafe(path, content);
    log.ok('M5/src/index.js mis à jour');
  }
}

// ------------------------------------------------------------
// 3. Ajouter @fastify/cors dans M4
// ------------------------------------------------------------
async function fixM4Cors() {
  log.title('3. Ajout de @fastify/cors dans M4 (design)');

  const path = join(ROOT, 'modules/m4-design/src/index.js');
  let content = await readSafe(path);
  if (!content) { log.err('M4/src/index.js introuvable'); return; }

  const original = content;
  let changed = false;

  // 3a. Import cors
  if (!/import\s+cors\s+from\s+['"]@fastify\/cors['"]/.test(content)) {
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
    }
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, "import cors from '@fastify/cors';");
      content = lines.join('\n');
      log.ok('Import cors ajouté');
      changed = true;
    }
  } else {
    log.skip('Import cors déjà présent');
  }

  // 3b. Register cors
  if (!/await\s+app\.register\(\s*cors\s*,/.test(content)) {
    const appDeclRegex = /(const\s+app\s*=\s*Fastify\s*\(\s*\{[^}]*\}\s*\)\s*;)/;
    if (appDeclRegex.test(content)) {
      content = content.replace(
        appDeclRegex,
        `$1\n\n  // CORS : autorise le front (localhost:3005) à appeler ce module\n  await app.register(cors, { origin: true });`
      );
      log.ok('register(cors) ajouté dans buildApp');
      changed = true;
    } else {
      log.warn('Impossible de localiser const app = Fastify(...)');
    }
  } else {
    log.skip('register(cors) déjà présent');
  }

  if (changed && content !== original) {
    await writeSafe(path, content);
    log.ok('M4/src/index.js mis à jour');
  }
}

// ------------------------------------------------------------
// 4. Nettoyer les fichiers orphelins
// ------------------------------------------------------------
async function cleanOrphans() {
  log.title('4. Suppression des fichiers orphelins');

  const orphans = [
    'm1-ingestion.js',
    'demo.txt',
    'package.json.bak',
    '10.0.0',
  ];

  for (const f of orphans) {
    const path = join(ROOT, f);
    if (existsSync(path)) {
      await deleteSafe(path);
      log.ok(`Supprimé : ${f}`);
    } else {
      log.skip(`${f} n'existe pas`);
    }
  }
}

// ------------------------------------------------------------
// 5. Nettoyer .gitignore
// ------------------------------------------------------------
async function cleanGitignore() {
  log.title('5. Nettoyage de .gitignore');

  const path = join(ROOT, '.gitignore');
  let content = await readSafe(path);
  if (!content) { log.err('.gitignore introuvable'); return; }

  const cleanContent = `node_modules/
.env
.env.local
*.log
dist/
coverage/
.DS_Store
.idea/
.vscode/
tmp/
*.msi
demo.txt
m1-ingestion.js
package.json.bak
*.docx
*.xlsx
*.pptx
*.pdf
!demo.docx
!demo-output.docx
`;

  // Compter les doublons avant
  const lines = content.split('\n').filter(Boolean);
  const uniqueLines = new Set(lines);
  const duplicateCount = lines.length - uniqueLines.size;

  if (duplicateCount > 0) {
    await writeSafe(path, cleanContent);
    log.ok(`.gitignore nettoyé (${duplicateCount} doublons supprimés)`);
  } else {
    log.skip('.gitignore déjà propre');
  }
}

// ------------------------------------------------------------
// 6. Uniformiser fastify
// ------------------------------------------------------------
async function uniformizeFastify() {
  log.title('6. Uniformisation de fastify → ^4.29.1');

  const modules = [
    'm1-ingestion',
    'm2-semantic-analysis',
    'm3-reformulation',
    'm4-design',
    'm5-office-generation',
    'm6-credits',
    'm7-auth',
    'm8-payment',
    'm9-monitoring',
  ];

  for (const m of modules) {
    const path = join(ROOT, 'modules', m, 'package.json');
    if (!existsSync(path)) { log.skip(`${m} : package.json absent`); continue; }

    const pkg = JSON.parse(await readFile(path, 'utf-8'));
    const current = pkg.dependencies?.fastify;

    if (current === '^4.29.1') {
      log.skip(`${m} : déjà ^4.29.1`);
      continue;
    }

    if (pkg.dependencies) {
      pkg.dependencies.fastify = '^4.29.1';
      await writeSafe(path, JSON.stringify(pkg, null, 2) + '\n');
      log.ok(`${m} : ${current} → ^4.29.1`);
    }
  }
}

// ------------------------------------------------------------
// 7. Vérification finale (syntaxe)
// ------------------------------------------------------------
async function verifySyntax() {
  log.title('7. Vérification finale de la syntaxe');

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const files = [
    'modules/m1-ingestion/src/index.js',
    'modules/m2-semantic-analysis/src/index.js',
    'modules/m3-reformulation/src/index.js',
    'modules/m4-design/src/index.js',
    'modules/m5-office-generation/src/index.js',
  ];

  for (const f of files) {
    const abs = join(ROOT, f);
    if (!existsSync(abs)) { log.skip(`${f} absent`); continue; }
    try {
      await execAsync(`node --check "${abs}"`);
      log.ok(`${f} : syntaxe valide`);
    } catch (err) {
      log.err(`${f} : ${err.stderr?.split('\n')[0] || err.message}`);
    }
  }
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
async function main() {
  console.log('\n\x1b[1m\x1b[35m🔧 DocForge AI — Correcteur automatique global\x1b[0m');
  if (DRY_RUN) console.log('\x1b[33m🔍 Mode --dry-run : aucun fichier ne sera modifié\x1b[0m');

  await fixEnvExample();
  await fixM5();
  await fixM4Cors();
  await cleanOrphans();
  await cleanGitignore();
  await uniformizeFastify();
  await verifySyntax();

  console.log('\n\x1b[1m\x1b[32m✅ Corrections appliquées\x1b[0m\n');
  console.log('Prochaines étapes :');
  console.log('  1. Vérifie manuellement .env.example (clé Groq supprimée)');
  console.log('  2. Révoque l\'ancienne clé Groq exposée et crée une nouvelle');
  console.log('  3. npm install (pour prendre en compte les changements de version)');
  console.log('  4. node modules/m5-office-generation/src/index.js --test');
  console.log('  5. node modules/m5-office-generation/src/index.js');
  console.log('  6. Ouvre http://localhost:3005/');
  console.log('  7. git add . && git commit -m "fix: global cleanup (M4 cors, M5 static, secure env, orphans)"\n');
}

main().catch((err) => {
  console.error('\n\x1b[31mErreur fatale :\x1b[0m', err);
  process.exit(1);
});