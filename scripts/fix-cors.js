#!/usr/bin/env node
/**
 * ============================================================
 * fix-cors.js — Vérifie et corrige automatiquement CORS/static
 * ------------------------------------------------------------
 * Pour chaque module (M1 à M5), vérifie que :
 *   - l'import `@fastify/cors` est présent
 *   - l'import `@fastify/static` est présent (M5 seulement)
 *   - `await app.register(cors, ...)` est présent dans buildApp
 *   - `await app.register(fastifyStatic, ...)` est présent (M5)
 *
 * Si un morceau manque, il est ajouté automatiquement.
 *
 * Usage :
 *   node scripts/fix-cors.js           # corrige
 *   node scripts/fix-cors.js --dry-run # montre sans modifier
 * ============================================================
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');

const MODULES = [
  { id: 'm1-ingestion',         file: 'modules/m1-ingestion/src/index.js',         needsStatic: false },
  { id: 'm2-semantic-analysis', file: 'modules/m2-semantic-analysis/src/index.js', needsStatic: false },
  { id: 'm3-reformulation',     file: 'modules/m3-reformulation/src/index.js',     needsStatic: false },
  { id: 'm4-design',            file: 'modules/m4-design/src/index.js',            needsStatic: false },
  { id: 'm5-office-generation', file: 'modules/m5-office-generation/src/index.js', needsStatic: true  },
];

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }

async function fixModule(mod) {
  console.log(`\n🔧 ${mod.id}`);

  const absPath = join(ROOT, mod.file);
  if (!existsSync(absPath)) {
    log('❌', `Fichier introuvable : ${mod.file}`);
    return false;
  }

  let content = await readFile(absPath, 'utf-8');
  const original = content;
  let changed = false;

  // ============================================================
  // 1. Vérifier l'import `@fastify/cors`
  // ============================================================
  const hasCorsImport = /import\s+cors\s+from\s+['"]@fastify\/cors['"]/.test(content);
  if (!hasCorsImport) {
    log('⚠️', 'import cors manquant → ajout');
    // Insérer après le dernier import de fastify/autre package
    // On cherche la première ligne qui commence par "import " (avant tout commentaire ou code)
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
    }
    if (lastImportIdx === -1) {
      // Pas d'import du tout ? On l'ajoute au tout début après le shebang si présent
      const hasShebang = content.startsWith('#!');
      const insertAt = hasShebang ? content.indexOf('\n') + 1 : 0;
      content = content.slice(0, insertAt) + "\nimport cors from '@fastify/cors';\n" + content.slice(insertAt);
    } else {
      lines.splice(lastImportIdx + 1, 0, "import cors from '@fastify/cors';");
      content = lines.join('\n');
    }
    changed = true;
  } else {
    log('✅', 'import cors présent');
  }

  // ============================================================
  // 2. Vérifier l'import `@fastify/static` (M5 seulement)
  // ============================================================
  if (mod.needsStatic) {
    const hasStaticImport = /import\s+fastifyStatic\s+from\s+['"]@fastify\/static['"]/.test(content);
    if (!hasStaticImport) {
      log('⚠️', 'import fastifyStatic manquant → ajout');
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
      }
      lines.splice(lastImportIdx + 1, 0, "import fastifyStatic from '@fastify/static';");
      content = lines.join('\n');
      changed = true;
    } else {
      log('✅', 'import fastifyStatic présent');
    }

    // Vérifier les imports path/url
    const hasPathImport = /import\s+\{[^}]*join[^}]*\}\s+from\s+['"]node:path['"]/.test(content) ||
                          /from\s+['"]node:path['"]/.test(content);
    if (!hasPathImport) {
      log('⚠️', 'import node:path manquant → ajout');
      content = content.replace(
        /(import\s+fastifyStatic\s+from\s+['"]@fastify\/static['"];)/,
        `$1\nimport { join, dirname } from 'node:path';`
      );
      changed = true;
    }
    const hasUrlImport = /from\s+['"]node:url['"]/.test(content);
    if (!hasUrlImport) {
      log('⚠️', 'import node:url manquant → ajout');
      content = content.replace(
        /(import\s+\{[^}]*\}\s+from\s+['"]node:path['"];)/,
        `$1\nimport { fileURLToPath } from 'node:url';`
      );
      changed = true;
    }
  }

  // ============================================================
  // 3. Vérifier l'enregistrement `app.register(cors, ...)`
  // ============================================================
  const hasCorsRegister = /await\s+app\.register\(\s*cors\s*,/.test(content);
  if (!hasCorsRegister) {
    log('⚠️', 'register(cors) manquant → ajout dans buildApp');

    // Trouver la ligne `const app = Fastify(...)` et insérer juste après
    const appDeclRegex = /(const\s+app\s*=\s*Fastify\s*\(\s*\{[^}]*\}\s*\)\s*;)/;
    if (appDeclRegex.test(content)) {
      content = content.replace(
        appDeclRegex,
        `$1\n\n  // CORS : autorise le front (localhost:3005) à appeler ce module\n  await app.register(cors, { origin: true });`
      );
      changed = true;
    } else {
      log('❌', 'Impossible de trouver `const app = Fastify(...)` — correction manuelle requise');
    }
  } else {
    log('✅', 'register(cors) présent');
  }

  // ============================================================
  // 4. Vérifier l'enregistrement `app.register(fastifyStatic, ...)` (M5)
  // ============================================================
  if (mod.needsStatic) {
    const hasStaticRegister = /await\s+app\.register\(\s*fastifyStatic\s*,/.test(content);
    if (!hasStaticRegister) {
      log('⚠️', 'register(fastifyStatic) manquant → ajout dans buildApp');

      // Insérer après `await app.register(cors, ...)` (ou après Fastify si pas de cors)
      const corsLineRegex = /(await\s+app\.register\(\s*cors\s*,\s*\{[^}]*\}\s*\)\s*;)/;
      if (corsLineRegex.test(content)) {
        content = content.replace(
          corsLineRegex,
          `$1\n\n  // Sert le front HTML sur http://localhost:${getPort(mod.id)}/\n  await app.register(fastifyStatic, {\n    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),\n    prefix: '/',\n  });`
        );
        changed = true;
      } else {
        log('❌', 'Impossible d\'insérer fastifyStatic — register(cors) introuvable');
      }
    } else {
      log('✅', 'register(fastifyStatic) présent');
    }
  }

  // ============================================================
  // 5. Écrire si changement
  // ============================================================
  if (changed && content !== original) {
    if (DRY_RUN) {
      log('🔍', '--dry-run : pas d\'écriture');
    } else {
      await writeFile(absPath, content, 'utf-8');
      log('💾', 'Fichier mis à jour');
    }
  } else if (!changed) {
    log('✨', 'Aucun changement nécessaire');
  }

  return true;
}

function getPort(moduleId) {
  const map = {
    'm1-ingestion': 3001,
    'm2-semantic-analysis': 3002,
    'm3-reformulation': 3003,
    'm4-design': 3004,
    'm5-office-generation': 3005,
  };
  return map[moduleId] || 3000;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n🏥 Diagnostic et correction CORS/static\n');
  if (DRY_RUN) console.log('🔍 Mode --dry-run : aucun fichier ne sera modifié\n');

  let ok = 0;
  let fail = 0;
  for (const mod of MODULES) {
    try {
      const success = await fixModule(mod);
      if (success) ok++; else fail++;
    } catch (err) {
      console.log(`  ❌ Erreur : ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok}/${MODULES.length} modules traités${fail > 0 ? ` — ${fail} en échec` : ''}`);
  console.log(`\n👉 Redémarre les 5 modules pour appliquer les changements :`);
  console.log(`   node modules\\m1-ingestion\\src\\index.js`);
  console.log(`   node modules\\m2-semantic-analysis\\src\\index.js`);
  console.log(`   node modules\\m3-reformulation\\src\\index.js`);
  console.log(`   node modules\\m4-design\\src\\index.js`);
  console.log(`   node modules\\m5-office-generation\\src\\index.js\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});