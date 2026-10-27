#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Configuration
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_NAME = 'docforge';
const PROJECT_DIR = __dirname;                                          // dossier courant
const PARENT_DIR = path.resolve(__dirname, '..');
const OUTPUT_TXT = path.resolve(PARENT_DIR, `${PROJECT_NAME}_export.txt`);

const IGNORE_PATTERNS = [
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.cache', '.DS_Store', '.env', '.env.local', '.env.production', '*.log',
  '_exports', 'extract-project.js', 'extract-project.mjs', 'extract-project.cjs',
];

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib',
  '.lock', '.sqlite', '.db',
];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const SEPARATOR = '='.repeat(80);

// ============================================================
// Helpers
// ============================================================
function shouldIgnore(relativePath) {
  const parts = relativePath.split(path.sep);
  const name = path.basename(relativePath);
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(name)) return true;
    } else {
      if (parts.includes(pattern) || name === pattern) return true;
    }
  }
  return false;
}

function isBinary(filePath) {
  return BINARY_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function getFileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================
// Collecte récursive
// ============================================================
function collectTree(dirPath, relativeBase = '', stats = { files: 0, directories: 0, totalSize: 0 }) {
  const node = {
    name: path.basename(dirPath),
    type: 'directory',
    path: relativeBase || path.basename(dirPath),
    children: [],
  };

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    console.error(`⚠️  Impossible de lire ${dirPath}: ${err.message}`);
    return node;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

    if (shouldIgnore(relPath)) continue;

    if (entry.isDirectory()) {
      stats.directories++;
      node.children.push(collectTree(fullPath, relPath, stats));
    } else if (entry.isFile()) {
      stats.files++;
      const size = getFileSize(fullPath);
      stats.totalSize += size;

      const fileInfo = {
        name: entry.name,
        type: 'file',
        path: relPath,
        size,
        sizeHuman: formatSize(size),
      };

      if (isBinary(fullPath)) {
        fileInfo.binary = true;
        fileInfo.content = null;
      } else if (size > MAX_FILE_SIZE) {
        fileInfo.binary = false;
        fileInfo.truncated = true;
        fileInfo.content = `[Fichier trop volumineux : ${formatSize(size)} — non lu]`;
      } else {
        try {
          fileInfo.binary = false;
          fileInfo.content = fs.readFileSync(fullPath, 'utf-8');
        } catch (err) {
          fileInfo.binary = false;
          fileInfo.content = `[Erreur de lecture : ${err.message}]`;
        }
      }

      node.children.push(fileInfo);
    }
  }

  return node;
}

// ============================================================
// Génération du TXT
// ============================================================
function generateTxt(tree, stats) {
  const out = [];

  // --- En-tête ---
  out.push(SEPARATOR);
  out.push(`PROJET : ${PROJECT_NAME}`);
  out.push(`Généré le : ${new Date().toLocaleString('fr-FR')}`);
  out.push(`Chemin source : ${PROJECT_DIR}`);
  out.push(SEPARATOR);
  out.push('');
  out.push(`STATISTIQUES`);
  out.push(`- Dossiers      : ${stats.directories}`);
  out.push(`- Fichiers      : ${stats.files}`);
  out.push(`- Taille totale : ${formatSize(stats.totalSize)}`);
  out.push('');
  out.push(SEPARATOR);
  out.push('');

  // --- Arborescence ---
  out.push('ARBORESCENCE');
  out.push(SEPARATOR);
  out.push(PROJECT_NAME + '/');
  (function renderTree(node, prefix = '') {
    const items = node.children || [];
    items.forEach((child, i) => {
      const isLast = i === items.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const suffix = child.type === 'directory' ? '/' : '';
      out.push(prefix + connector + child.name + suffix);
      if (child.type === 'directory') {
        renderTree(child, prefix + (isLast ? '    ' : '│   '));
      }
    });
  })(tree);
  out.push('');
  out.push(SEPARATOR);
  out.push('');

  // --- Contenu des fichiers ---
  out.push('CONTENU DES FICHIERS');
  out.push(SEPARATOR);
  out.push('');

  let fileIndex = 0;
  let totalFiles = stats.files;

  (function renderFiles(node) {
    for (const child of node.children || []) {
      if (child.type === 'directory') {
        renderFiles(child);
      } else {
        fileIndex++;
        out.push('');
        out.push(SEPARATOR);
        out.push(`FICHIER [${fileIndex}/${totalFiles}] : ${child.path}`);
        out.push(`Taille : ${child.sizeHuman}`);
        out.push(SEPARATOR);
        out.push('');

        if (child.binary) {
          out.push('>>> [Fichier binaire — contenu non affiché] <<<');
        } else {
          out.push(child.content ?? '');
        }

        out.push('');
      }
    }
  })(tree);

  out.push('');
  out.push(SEPARATOR);
  out.push(`FIN DE L'EXPORT — ${new Date().toISOString()}`);
  out.push(SEPARATOR);

  return out.join('\n');
}

// ============================================================
// Main
// ============================================================
function main() {
  console.log('🚀 Démarrage de l\'extraction du projet...\n');

  if (!fs.existsSync(PROJECT_DIR)) {
    console.error(`❌ Le dossier "${PROJECT_DIR}" n'existe pas.`);
    process.exit(1);
  }

  console.log(`📂 Projet source : ${PROJECT_DIR}`);
  console.log(`📄 Fichier TXT   : ${OUTPUT_TXT}\n`);

  console.log('🔍 Analyse de la structure...');
  const stats = { files: 0, directories: 0, totalSize: 0 };
  const tree = collectTree(PROJECT_DIR, '', stats);

  console.log(`✅ ${stats.directories} dossiers, ${stats.files} fichiers (${formatSize(stats.totalSize)})\n`);

  console.log('📝 Génération du fichier TXT...');
  const content = generateTxt(tree, stats);
  fs.writeFileSync(OUTPUT_TXT, content, 'utf-8');

  const outputSize = fs.statSync(OUTPUT_TXT).size;
  console.log(`   → ${OUTPUT_TXT}`);
  console.log(`   → Taille : ${formatSize(outputSize)}\n`);

  console.log('✨ Extraction terminée avec succès !');
  console.log('\n📊 Résumé :');
  console.log(`   • Dossiers     : ${stats.directories}`);
  console.log(`   • Fichiers     : ${stats.files}`);
  console.log(`   • Taille source: ${formatSize(stats.totalSize)}`);
  console.log(`   • Taille TXT   : ${formatSize(outputSize)}`);
}

main();