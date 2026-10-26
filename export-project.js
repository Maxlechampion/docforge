#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Export complet du projet
 * ------------------------------------------------------------
 * Génère un fichier texte unique contenant :
 *   - l'arborescence complète (hors node_modules, .git)
 *   - le contenu de tous les fichiers source
 *
 * Usage :
 *   node export-project.js
 *   node export-project.js --out=export.txt
 * ============================================================
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Fichiers/dossiers exclus (bruit, binaires, secrets)
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github/ISSUE_TEMPLATE',
  'dist',
  'build',
  'coverage',
  'tmp',
  '.cache',
]);

const EXCLUDE_FILES = new Set([
  '.env',
  '.env.local',
  '.DS_Store',
  'package-lock.json',
  'export-project.js',
  'export-project.txt',
]);

const EXCLUDE_EXT = new Set([
  '.docx', '.xlsx', '.pptx', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.zip', '.tar', '.gz', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.mov',
  '.woff', '.woff2', '.ttf', '.eot',
]);

const MAX_FILE_SIZE = 500 * 1024; // 500 Ko max par fichier texte
const MAX_TOTAL_SIZE = 5 * 1024 * 1024; // 5 Mo total

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
async function walk(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await walk(full, files);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (EXCLUDE_EXT.has(extname(entry.name).toLowerCase())) continue;
      files.push({ full, rel, size: (await stat(full)).size });
    }
  }
  return files;
}

function buildTree(files) {
  const tree = {};
  for (const { rel } of files) {
    const parts = rel.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = null; // feuille
  }
  return tree;
}

function renderTree(node, prefix = '') {
  const lines = [];
  const keys = Object.keys(node).sort((a, b) => {
    const aIsDir = node[a] !== null;
    const bIsDir = node[b] !== null;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.localeCompare(b);
  });
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const isLast = i === keys.length - 1;
    const isDir = node[key] !== null;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    lines.push(prefix + connector + key + (isDir ? '/' : ''));
    if (isDir) {
      lines.push(...renderTree(node[key], childPrefix));
    }
  }
  return lines;
}

function langFromExt(ext) {
  const map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
    '.json': 'json', '.html': 'html', '.css': 'css',
    '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
    '.sh': 'bash', '.ps1': 'powershell',
    '.env': 'dotenv', '.txt': 'text',
  };
  return map[ext.toLowerCase()] || 'text';
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : 'export-project.txt';

console.log('📦 Export du projet DocForge AI…\n');

const files = await walk(ROOT);
console.log(`📁 ${files.length} fichiers trouvés\n`);

// Arborescence
const tree = buildTree(files);
const treeLines = ['docforge-ai/', ...renderTree(tree)];

// Contenu
const sections = [];
let totalSize = 0;
let skipped = 0;

for (const { full, rel, size } of files) {
  if (size > MAX_FILE_SIZE) {
    sections.push(`\n${'='.repeat(80)}\n${rel}\n${'='.repeat(80)}\n\n[Fichier ignoré : ${(size / 1024).toFixed(1)} Ko > ${MAX_FILE_SIZE / 1024} Ko]\n`);
    skipped++;
    continue;
  }
  if (totalSize + size > MAX_TOTAL_SIZE) {
    sections.push(`\n\n[Export tronqué : limite de ${MAX_TOTAL_SIZE / 1024 / 1024} Mo atteinte]\n`);
    break;
  }

  try {
    const content = await readFile(full, 'utf-8');
    const lang = langFromExt(extname(rel));
    sections.push(
      `\n${'='.repeat(80)}\n${rel}  (${(size / 1024).toFixed(1)} Ko)\n${'='.repeat(80)}\n\n` +
      '```' + lang + '\n' +
      content +
      '\n```\n'
    );
    totalSize += size;
  } catch (err) {
    sections.push(`\n${'='.repeat(80)}\n${rel}\n${'='.repeat(80)}\n\n[Erreur lecture : ${err.message}]\n`);
    skipped++;
  }
}

// En-tête
const header = `# DocForge AI — Export complet du projet

Date d'export : ${new Date().toISOString()}
Fichiers inclus : ${files.length - skipped} / ${files.length}
Taille totale : ${(totalSize / 1024).toFixed(1)} Ko
Exclus : node_modules, .git, .env, binaires (docx, xlsx, pdf, images…)

---

## Arborescence

\`\`\`
${treeLines.join('\n')}
\`\`\`

---

## Contenu des fichiers
`;

const output = header + sections.join('\n');

await writeFile(join(ROOT, OUT), output, 'utf-8');
console.log(`✅ Export généré : ${OUT}`);
console.log(`   ${(output.length / 1024).toFixed(1)} Ko, ${files.length - skipped} fichiers inclus`);
console.log(`\nEnvoie-moi le fichier ${OUT} et j'aurai une vision complète du code.\n`);