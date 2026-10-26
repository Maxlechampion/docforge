#!/usr/bin/env node
/**
 * ============================================================
 * fix-m5-xlsx.js — Répare generateXlsx dans M5
 * ------------------------------------------------------------
 * Ce script :
 *   1. Sauvegarde l'ancien fichier
 *   2. Localise la fonction generateXlsx
 *   3. La remplace par une version propre (2 feuilles, styles, tableaux)
 *   4. Vérifie la syntaxe
 *   5. Compte les accolades
 *   6. Lance les tests M5
 *
 * Usage :
 *   node fix-m5-xlsx.js
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

console.log('\n🔧 fix-m5-xlsx.js — Reconstruction de generateXlsx\n');

if (!existsSync(M5_PATH)) {
  console.error('  ❌ M5 introuvable :', M5_PATH);
  process.exit(1);
}

await copyFile(M5_PATH, BACKUP);
console.log(`  💾 Sauvegarde : ${BACKUP.split(/[\\/]/).pop()}\n`);

let content = await readFile(M5_PATH, 'utf-8');

// ============================================================
// 1. Trouver la fonction generateXlsx
// ============================================================
const startMarker = 'export async function generateXlsx(';
const endMarker = 'export async function generatePptx(';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1) {
  console.error('  ❌ generateXlsx introuvable dans le fichier');
  process.exit(1);
}
if (endIdx === -1) {
  console.error('  ❌ generatePptx introuvable (nécessaire pour localiser la fin de generateXlsx)');
  process.exit(1);
}
if (endIdx <= startIdx) {
  console.error('  ❌ Ordre des fonctions incohérent (generatePptx avant generateXlsx)');
  process.exit(1);
}

console.log(`  📍 generateXlsx trouvé (ligne ~${content.slice(0, startIdx).split('\n').length})`);
console.log(`  📍 generatePptx trouvé (ligne ~${content.slice(0, endIdx).split('\n').length})\n`);

// ============================================================
// 2. Nouvelle version de generateXlsx
// ============================================================
const NEW_GENERATE_XLSX = `export async function generateXlsx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const primaryHex = (theme.primary || '#1e40af').replace('#', '');
  const secondaryHex = (theme.secondary || '#64748b').replace('#', '');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.author || 'DocForge AI';
  workbook.created = new Date();

  // ============ FEUILLE 1 : SOMMAIRE ============
  const summary = workbook.addWorksheet('Sommaire', {
    properties: { defaultRowHeight: 22 },
  });
  summary.columns = [{ width: 10 }, { width: 80 }];

  summary.mergeCells('A1:B1');
  const titleCell = summary.getCell('A1');
  titleCell.value = meta.title || 'Document DocForge AI';
  titleCell.font = { size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  summary.getRow(1).height = 44;

  summary.mergeCells('A2:B2');
  const subCell = summary.getCell('A2');
  subCell.value = 'Généré le ' + new Date().toLocaleDateString('fr-FR') + ' · ' + blocks.length + ' blocs';
  subCell.font = { size: 10, italic: true, color: { argb: 'FF' + secondaryHex } };
  subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  summary.getRow(2).height = 24;

  const headings = blocks.filter((b) => b.level === 'h1' || b.level === 'h2');
  let sumRow = 4;
  summary.getCell('A' + sumRow).value = 'Niveau';
  summary.getCell('B' + sumRow).value = 'Titre';
  summary.getCell('A' + sumRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getCell('B' + sumRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getCell('A' + sumRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
  summary.getCell('B' + sumRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
  sumRow++;

  for (const h of headings) {
    summary.getCell('A' + sumRow).value = h.level.toUpperCase();
    summary.getCell('B' + sumRow).value = h.content || '';
    summary.getCell('A' + sumRow).font = { size: 10, bold: true, color: { argb: 'FF' + primaryHex } };
    summary.getCell('B' + sumRow).font = { size: 11, bold: h.level === 'h1' };
    summary.getCell('A' + sumRow).alignment = { indent: h.level === 'h2' ? 3 : 1 };
    sumRow++;
  }

  // ============ FEUILLE 2 : CONTENU ============
  const sheet = workbook.addWorksheet('Contenu', {
    properties: { defaultRowHeight: 20 },
  });
  sheet.columns = [{ width: 6 }, { width: 80 }];

  let currentRow = 1;
  let sectionNum = 0;

  for (const block of blocks) {
    if (block.type === 'text' && block.level === 'h1') {
      sectionNum++;
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = sectionNum + '. ' + (block.content || '');
      cell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
      sheet.getRow(currentRow).height = 36;
      currentRow += 2;
      continue;
    }

    if (block.type === 'text' && block.level === 'h2') {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = '    ' + (block.content || '');
      cell.font = { size: 13, bold: true, color: { argb: 'FF' + primaryHex } };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF' + primaryHex } } };
      cell.alignment = { vertical: 'middle', indent: 2 };
      sheet.getRow(currentRow).height = 26;
      currentRow += 1;
      continue;
    }

    if (block.type === 'text' && block.level === 'h3') {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = '        ' + (block.content || '');
      cell.font = { size: 11, bold: true, color: { argb: 'FF' + secondaryHex } };
      cell.alignment = { vertical: 'middle', indent: 2 };
      currentRow += 1;
      continue;
    }

    if (block.type === 'text' && block.level === 'body' && block.content) {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = block.content;
      cell.font = { size: 10, color: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'top', horizontal: 'justify', wrapText: true };
      sheet.getRow(currentRow).height = Math.max(20, Math.ceil(block.content.length / 90) * 16);
      currentRow += 1;
      continue;
    }

    if (block.type === 'list') {
      const text = (block.content || '').replace(/^[-*•]\\s*/, '').replace(/^\\d+[.)]\\s*/, '');
      sheet.getCell('A' + currentRow).value = '•';
      sheet.getCell('A' + currentRow).font = { size: 12, bold: true, color: { argb: 'FF' + primaryHex } };
      sheet.getCell('A' + currentRow).alignment = { horizontal: 'right', vertical: 'top' };
      const cell = sheet.getCell('B' + currentRow);
      cell.value = text;
      cell.font = { size: 10, color: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'top', wrapText: true, indent: 1 };
      sheet.getRow(currentRow).height = Math.max(20, Math.ceil(text.length / 85) * 16);
      currentRow += 1;
      continue;
    }

    if (block.type === 'quote') {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = '« ' + (block.content || '') + ' »';
      cell.font = { size: 10, italic: true, color: { argb: 'FF4B5563' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      cell.border = { left: { style: 'thick', color: { argb: 'FF' + primaryHex } } };
      cell.alignment = { vertical: 'top', wrapText: true, indent: 2 };
      sheet.getRow(currentRow).height = Math.max(24, Math.ceil((block.content || '').length / 85) * 16);
      currentRow += 1;
      continue;
    }

    if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
      const rows = block.rows;
      const colCount = Math.max(...rows.map((r) => r.length));

      while (sheet.columns.length < colCount + 1) {
        sheet.columns.push({ width: 20 });
      }

      rows[0].forEach((cell, colIdx) => {
        const excelCell = sheet.getCell(currentRow, colIdx + 2);
        excelCell.value = cell;
        excelCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
        excelCell.alignment = { vertical: 'middle', horizontal: 'center' };
        excelCell.border = {
          top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
          left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
          bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
          right: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        };
      });
      sheet.getRow(currentRow).height = 24;
      currentRow++;

      rows.slice(1).forEach((row, rowIdx) => {
        row.forEach((cell, colIdx) => {
          const excelCell = sheet.getCell(currentRow, colIdx + 2);
          excelCell.value = cell;
          excelCell.font = { size: 10 };
          excelCell.alignment = { vertical: 'middle', horizontal: colIdx === 0 ? 'left' : 'center', indent: colIdx === 0 ? 1 : 0 };
          excelCell.border = {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          };
          if (rowIdx % 2 === 0) {
            excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
          }
        });
        sheet.getRow(currentRow).height = 20;
        currentRow++;
      });
      currentRow++;
      continue;
    }

    if (block.content) {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = block.content;
      cell.font = { size: 10 };
      cell.alignment = { wrapText: true, vertical: 'top' };
      currentRow += 1;
    }
  }

  currentRow++;
  sheet.mergeCells('A' + currentRow + ':B' + currentRow);
  const footerCell = sheet.getCell('A' + currentRow);
  footerCell.value = meta.footer || 'Document généré par DocForge AI';
  footerCell.font = { size: 9, italic: true, color: { argb: 'FF' + secondaryHex } };
  footerCell.alignment = { horizontal: 'center' };
  footerCell.border = { top: { style: 'thin', color: { argb: 'FFE5E7EB' } } };

  sheet.views = [{ state: 'frozen', ySplit: 0 }];
  sheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

`;

// ============================================================
// 3. Remplacer
// ============================================================
const before = content.slice(0, startIdx);
const after = content.slice(endIdx);
const newContent = before + NEW_GENERATE_XLSX + after;

await writeFile(M5_PATH, newContent, 'utf-8');
console.log(`  ✅ generateXlsx remplacé (ancien: ${endIdx - startIdx} octets → nouveau: ${NEW_GENERATE_XLSX.length} octets)\n`);

// ============================================================
// 4. Vérification syntaxe
// ============================================================
console.log('  🔍 Vérification syntaxe...');
try {
  execSync(`node --check "${M5_PATH}"`, { stdio: 'pipe' });
  console.log('  ✅ Syntaxe OK\n');
} catch (err) {
  console.error('  ❌ Erreur de syntaxe :');
  console.error(err.stderr?.toString());
  process.exit(1);
}

// ============================================================
// 5. Comptage accolades
// ============================================================
const finalContent = await readFile(M5_PATH, 'utf-8');
const open = (finalContent.match(/\{/g) || []).length;
const close = (finalContent.match(/\}/g) || []).length;
console.log(`  📊 Accolades : ${open} ouvrantes / ${close} fermantes → différence : ${open - close}`);
if (open - close !== 0) {
  console.log('  ⚠️  Déséquilibre détecté ! Vérifie manuellement.');
} else {
  console.log('  ✅ Accolades équilibrées\n');
}

// ============================================================
// 6. Tests
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

console.log('\n✅ generateXlsx est corrigé.\n');
console.log('Prochaines étapes :');
console.log('  1. Redémarrer : node scripts\\start-full.js');
console.log('  2. Tester avec format=xlsx');
console.log('  3. Ouvrir le fichier dans Excel\n');