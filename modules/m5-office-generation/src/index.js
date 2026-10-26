#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M5 : Génération Office (4 formats)
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
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ============================================================
// 1. CONTRAT
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
        format: { enum: ['docx', 'pdf', 'xlsx', 'pptx'] },
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
// 3. LOGO UTILS
// ============================================================
function parseDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const match = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,(.+)$/i.exec(dataUri);
  if (!match) return null;
  let type = match[1].toLowerCase();
  if (type === 'jpeg') type = 'jpg';
  if (type === 'webp' || type === 'bmp') type = 'png';
  let buffer;
  try { buffer = Buffer.from(match[2], 'base64'); } catch { return null; }
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > 500 * 1024) return null;
  let width = 150, height = 38;
  if (type === 'png' && buffer.length > 24) {
    try { width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20); } catch {}
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
  const MAX_W = 200, MAX_H = 60;
  if (width > MAX_W) { const r = MAX_W / width; width = MAX_W; height = Math.round(height * r); }
  if (height > MAX_H) { const r = MAX_H / height; height = MAX_H; width = Math.round(width * r); }
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
  } catch { return null; }
}

// ============================================================
// 4. GÉNÉRATEUR .DOCX
// ============================================================
export function buildDocx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const layout = design.layout || {};
  const logoDataUri = design.logo?.dataUri || null;
  const logoPosition = design.logo?.position || layout.logo_position || null;
  const children = [];

  if (layout.cover_page) {
    if (logoDataUri && logoPosition === 'cover') {
      const img = buildImageRun(logoDataUri);
      if (img) {
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2000, after: 400 }, children: [img] }));
      } else {
        children.push(new Paragraph({ spacing: { before: 4000 } }));
      }
    } else {
      children.push(new Paragraph({ spacing: { before: 4000 } }));
    }
    children.push(
      new Paragraph({ spacing: { before: 0, after: 2000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.title || 'Document DocForge AI', bold: true, size: 72, color: (theme.primary || '#1e40af').replace('#', ''), font: theme.font_heading || 'Inter' })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.subtitle || 'Généré le ' + new Date().toLocaleDateString('fr-FR'), size: 28, color: (theme.secondary || '#64748b').replace('#', ''), font: theme.font_body || 'Inter' })] }),
      new Paragraph({ children: [new PageBreak()] })
    );
  }

  if (layout.table_of_contents) {
    const headings = blocks.filter((b) => b.level === 'h1' || b.level === 'h2');
    if (headings.length > 0) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Sommaire', bold: true, color: (theme.primary || '#1e40af').replace('#', ''), font: theme.font_heading || 'Inter' })] }));
      for (const h of headings) {
        children.push(new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: (h.level === 'h1' ? '' : '    ') + h.content, size: h.level === 'h1' ? 24 : 22, color: (theme.secondary || '#64748b').replace('#', ''), font: theme.font_body || 'Inter' })] }));
      }
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  for (const block of blocks) children.push(...renderDocxBlock(block, theme));

  const headers = {};
  if (logoDataUri && logoPosition === 'header') {
    const img = buildImageRun(logoDataUri);
    headers.default = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: img ? [img] : [new TextRun({ text: meta.title || 'DocForge AI', size: 18, color: (theme.secondary || '#64748b').replace('#', ''), font: theme.font_body || 'Inter', italics: true })] })] });
  } else if (layout.logo_position === 'header') {
    headers.default = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: meta.title || 'DocForge AI', size: 18, color: (theme.secondary || '#64748b').replace('#', ''), font: theme.font_body || 'Inter', italics: true })] })] });
  }

  const footerChildren = [];
  if (logoDataUri && logoPosition === 'footer') {
    const img = buildImageRun(logoDataUri);
    if (img) { footerChildren.push(img); footerChildren.push(new TextRun({ text: '  ·  ', size: 16, color: '9ca3af' })); }
  }
  footerChildren.push(new TextRun({ text: meta.footer || 'Document généré par DocForge AI', size: 16, color: '9ca3af', font: theme.font_body || 'Inter' }));
  const footers = { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footerChildren })] }) };

  return new Document({
    creator: meta.author || 'DocForge AI',
    title: meta.title || 'Document',
    description: 'Généré par DocForge AI',
    styles: { default: { document: { run: { font: theme.font_body || 'Inter', size: 22, color: '1f2937' }, paragraph: { spacing: { line: 320, after: 120 } } } } },
    sections: [{ properties: {}, headers: headers.default ? { default: headers.default } : undefined, footers, children }],
  });
}

function renderDocxBlock(block, theme) {
  const out = [];
  const primaryHex = (theme.primary || '#1e40af').replace('#', '');
  const fontHeading = theme.font_heading || 'Inter';
  const fontBody = theme.font_body || 'Inter';

  if (block.type === 'text' && ['h1', 'h2', 'h3'].includes(block.level)) {
    const map = { h1: { level: HeadingLevel.HEADING_1, size: 36, before: 400, after: 200 }, h2: { level: HeadingLevel.HEADING_2, size: 28, before: 300, after: 150 }, h3: { level: HeadingLevel.HEADING_3, size: 24, before: 200, after: 100 } };
    const cfg = map[block.level];
    out.push(new Paragraph({ heading: cfg.level, spacing: { before: cfg.before, after: cfg.after }, children: [new TextRun({ text: block.content || '', bold: true, size: cfg.size, color: primaryHex, font: fontHeading })] }));
    return out;
  }

  if (block.type === 'list') {
    const text = (block.content || '').replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text, size: 22, font: fontBody })] }));
    return out;
  }

  if (block.type === 'quote') {
    out.push(new Paragraph({ indent: { left: 720, right: 720 }, spacing: { before: 120, after: 120 }, border: { left: { color: primaryHex, space: 8, style: BorderStyle.SINGLE, size: 18 } }, children: [new TextRun({ text: block.content || '', italics: true, size: 22, color: '4b5563', font: fontBody })] }));
    return out;
  }

  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
    const rows = block.rows;
    const headerRow = new TableRow({ tableHeader: true, children: rows[0].map((cell) => new TableCell({ shading: { fill: primaryHex }, children: [new Paragraph({ children: [new TextRun({ text: String(cell), bold: true, color: 'ffffff', size: 22, font: fontHeading })] })] })) });
    const bodyRows = rows.slice(1).map((row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(cell), size: 22, font: fontBody })] })] })) }));
    out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] }));
    out.push(new Paragraph({ spacing: { after: 200 } }));
    return out;
  }

  out.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: [new TextRun({ text: block.content || '', size: 22, font: fontBody })] }));
  return out;
}

export async function generateDocx({ blocks, design, meta = {} }) {
  const doc = buildDocx({ blocks, design, meta });
  return await Packer.toBuffer(doc);
}

// ============================================================
// 5. GÉNÉRATEUR .PDF
// ============================================================
export async function generatePdf({ blocks, design, meta = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const theme = design.theme || {};
      const layout = design.layout || {};
      const logo = design.logo;
      const primaryColor = theme.primary || '#1e40af';
      const fontBody = 'Helvetica';

      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: meta.title || 'Document', Author: meta.author || 'DocForge AI' }, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (layout.cover_page && logo?.dataUri && logo.position === 'cover') {
        const parsed = parseDataUri(logo.dataUri);
        if (parsed) {
          try { doc.image(parsed.buffer, { fit: [150, 50], align: 'center' }); doc.moveDown(2); } catch {}
        }
      }

      if (layout.cover_page) {
        doc.moveDown(8);
        doc.fillColor(primaryColor).fontSize(36).font('Helvetica-Bold').text(meta.title || 'Document DocForge AI', { align: 'center' });
        doc.moveDown(2);
        doc.fillColor(theme.secondary || '#64748b').fontSize(14).font(fontBody).text(meta.subtitle || 'Généré le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });
        doc.addPage();
      }

      for (const block of blocks) {
        renderPdfBlock(doc, block, theme);
      }

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#9ca3af').fontSize(9).font(fontBody).text(
          meta.footer || 'Document généré par DocForge AI',
          50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderPdfBlock(doc, block, theme) {
  const primaryColor = theme.primary || '#1e40af';
  const fontBody = 'Helvetica';

  if (block.type === 'text' && ['h1', 'h2', 'h3'].includes(block.level)) {
    const sizes = { h1: 24, h2: 18, h3: 14 };
    doc.moveDown(0.8);
    doc.fillColor(primaryColor).fontSize(sizes[block.level]).font('Helvetica-Bold').text(block.content || '');
    doc.moveDown(0.4);
    return;
  }

  if (block.type === 'list') {
    const text = (block.content || '').replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    doc.fillColor('#1f2937').fontSize(11).font(fontBody).text('• ' + text, { indent: 20 });
    return;
  }

  if (block.type === 'quote') {
    doc.moveDown(0.4);
    doc.fillColor('#4b5563').fontSize(11).font('Helvetica-Oblique').text(block.content || '', { indent: 30 });
    doc.fillColor(primaryColor).rect(doc.x - 15, doc.y - doc.currentLineHeight() - 5, 3, doc.currentLineHeight() + 10).fill();
    doc.moveDown(0.6);
    return;
  }

  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
    doc.moveDown(0.5);
    const rows = block.rows;
    const colCount = Math.max(...rows.map((r) => r.length));
    const colWidth = (doc.page.width - 100) / colCount;
    const rowHeight = 22;
    const startX = doc.x;
    const startY = doc.y;

    rows.forEach((row, rowIdx) => {
      const y = startY + rowIdx * rowHeight;
      row.forEach((cell, colIdx) => {
        const x = startX + colIdx * colWidth;
        if (rowIdx === 0) {
          doc.fillColor(primaryColor).rect(x, y, colWidth, rowHeight).fill();
          doc.fillColor('#ffffff');
        } else {
          doc.fillColor('#1f2937');
        }
        doc.fontSize(10).font(rowIdx === 0 ? 'Helvetica-Bold' : fontBody).text(String(cell), x + 6, y + 6, { width: colWidth - 12, height: rowHeight - 12, ellipsis: true });
      });
    });

    doc.y = startY + rows.length * rowHeight + 15;
    doc.x = startX;
    return;
  }

  doc.fillColor('#1f2937').fontSize(11).font(fontBody).text(block.content || '', { align: 'justify', lineGap: 3 });
  doc.moveDown(0.5);
}

// ============================================================
// 6. GÉNÉRATEUR .XLSX (2 feuilles)
// ============================================================
export async function generateXlsx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const primaryHex = (theme.primary || '#1e40af').replace('#', '');
  const secondaryHex = (theme.secondary || '#64748b').replace('#', '');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.author || 'DocForge AI';
  workbook.created = new Date();

  // Feuille 1 : Sommaire
  const summary = workbook.addWorksheet('Sommaire', { properties: { defaultRowHeight: 22 } });
  summary.columns = [
    { width: 10 },
    { width: 80 },
  ];

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

  // Feuille 2 : Contenu
  const sheet = workbook.addWorksheet('Contenu', { properties: { defaultRowHeight: 20 } });
  sheet.columns = [
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
  ];

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
      const text = (block.content || '').replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
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

  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// 7. GÉNÉRATEUR .PPTX
// ============================================================
export async function generatePptx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const layout = design.layout || {};
  const logo = design.logo;
  const primary = (theme.primary || '#1e40af').replace('#', '');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = meta.author || 'DocForge AI';
  pptx.title = meta.title || 'Document';

  if (layout.cover_page) {
    const slide = pptx.addSlide();
    slide.background = { color: primary };

    if (logo?.dataUri && logo.position === 'cover') {
      const parsed = parseDataUri(logo.dataUri);
      if (parsed) {
        try {
          slide.addImage({ data: logo.dataUri, x: 4.5, y: 1.2, w: 1.5, h: 0.6, sizing: { type: 'contain' } });
        } catch {}
      }
    }

    slide.addText(meta.title || 'Document DocForge AI', { x: 0.5, y: 3, w: 9, h: 1.5, fontSize: 44, bold: true, color: 'FFFFFF', align: 'center', fontFace: 'Arial' });
    slide.addText(meta.subtitle || 'Généré le ' + new Date().toLocaleDateString('fr-FR'), { x: 0.5, y: 4.8, w: 9, h: 0.8, fontSize: 18, color: 'FFFFFF', align: 'center', fontFace: 'Arial' });
  }

  let currentSlide = null;
  let blockBuffer = [];

  const flushSlide = () => {
    if (!currentSlide) return;
    if (blockBuffer.length === 0) return;

    const contentTexts = blockBuffer.map((b) => {
      const text = b.content || '';
      const prefix = b.type === 'list' ? '• ' : '';
      return { text: prefix + text, options: { bullet: b.type === 'list', fontSize: 14, color: '333333', fontFace: 'Arial', breakLine: true } };
    });

    currentSlide.addText(contentTexts, { x: 0.5, y: 1.5, w: 9, h: 4.5, valign: 'top' });
    blockBuffer = [];
    currentSlide = null;
  };

  for (const block of blocks) {
    if (block.type === 'text' && block.level === 'h1') {
      flushSlide();
      currentSlide = pptx.addSlide();
      currentSlide.background = { color: 'FFFFFF' };
      currentSlide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.8, fill: { color: primary } });
      currentSlide.addText(block.content || '', { x: 0.3, y: 0.1, w: 9.4, h: 0.6, fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Arial' });
      continue;
    }

    if (block.type === 'text' && block.level === 'h2') {
      if (!currentSlide) {
        currentSlide = pptx.addSlide();
        currentSlide.background = { color: 'FFFFFF' };
        currentSlide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.8, fill: { color: primary } });
        currentSlide.addText(meta.title || '', { x: 0.3, y: 0.1, w: 9.4, h: 0.6, fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Arial' });
      }
      blockBuffer.push({ ...block, level: 'h2' });
      continue;
    }

    if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
      if (!currentSlide) {
        currentSlide = pptx.addSlide();
        currentSlide.background = { color: 'FFFFFF' };
        currentSlide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.8, fill: { color: primary } });
        currentSlide.addText(meta.title || '', { x: 0.3, y: 0.1, w: 9.4, h: 0.6, fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Arial' });
      }

      const tableRows = block.rows.map((row, rowIdx) => row.map((cell) => ({
        text: String(cell),
        options: {
          bold: rowIdx === 0,
          color: rowIdx === 0 ? 'FFFFFF' : '333333',
          fill: rowIdx === 0 ? { color: primary } : { color: 'F9FAFB' },
          fontSize: 12,
          fontFace: 'Arial',
        },
      })));

      currentSlide.addTable(tableRows, { x: 0.5, y: 1.5, w: 9, h: Math.min(4, block.rows.length * 0.4), border: { type: 'solid', color: 'E5E7EB', pt: 1 } });
      continue;
    }

    if (currentSlide) blockBuffer.push(block);
  }

  flushSlide();

  const endSlide = pptx.addSlide();
  endSlide.background = { color: primary };
  endSlide.addText('Merci', { x: 0.5, y: 3, w: 9, h: 1, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center', fontFace: 'Arial' });
  endSlide.addText(meta.footer || 'Généré par DocForge AI', { x: 0.5, y: 5, w: 9, h: 0.5, fontSize: 14, color: 'FFFFFF', align: 'center', fontFace: 'Arial' });

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(buffer);
}

// ============================================================
// 8. DISPATCHER
// ============================================================
export async function generate({ blocks, design, meta = {}, format = 'docx' }) {
  switch (format) {
    case 'docx': return await generateDocx({ blocks, design, meta });
    case 'pdf':  return await generatePdf({ blocks, design, meta });
    case 'xlsx': return await generateXlsx({ blocks, design, meta });
    case 'pptx': return await generatePptx({ blocks, design, meta });
    default: throw Object.assign(new Error('Format ' + format + ' non supporté'), { statusCode: 400 });
  }
}

// ============================================================
// 9. ROUTES
// ============================================================
const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 50 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
    prefix: '/',
  });

  app.get('/health', async () => ({ status: 'ok', module: 'M5', enabled: isModuleEnabled(), formats: ['docx', 'pdf', 'xlsx', 'pptx'] }));
  app.get('/m5/contract', async () => CONTRACT_V1);

  app.post('/m5/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['blocks', 'design'],
        properties: {
          blocks: { type: 'array', minItems: 1 },
          design: { type: 'object' },
          meta: { type: 'object' },
          format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'pptx'], default: 'docx' },
        },
      },
    },
  }, async (req, reply) => {
    if (!isModuleEnabled()) {
      return reply.code(503).send({ error: 'Module M5 désactivé', module_enabled: false });
    }
    try {
      const { blocks, design, meta, format = 'docx' } = req.body;
      if (!MIME_TYPES[format]) return reply.code(400).send({ error: 'Format ' + format + ' non supporté' });

      const buffer = await generate({ blocks, design, meta, format });

      const filename = 'docforge-' + Date.now() + '.' + format;
      reply
        .header('Content-Type', MIME_TYPES[format])
        .header('Content-Disposition', 'attachment; filename="' + filename + '"')
        .header('Content-Length', buffer.length)
        .header('X-DocForge-Blocks', blocks.length)
        .header('X-DocForge-Format', format);

      return reply.send(buffer);
    } catch (err) {
      req.log.error({ err }, 'Erreur M5');
      return reply.code(err.statusCode || 500).send({ error: err.message, module: 'm5' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Erreur M5');
    reply.code(err.statusCode || 500).send({ error: err.message, module: 'm5' });
  });

  return app;
}

// ============================================================
// 10. TESTS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  const sampleDesign = {
    template: 'consulting',
    theme: { primary: '#1e40af', secondary: '#64748b', accent: '#0ea5e9', font_heading: 'Inter', font_body: 'Inter', font_mono: 'JetBrains Mono' },
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

  t('DOCX : buffer valide', async () => {
    const buf = await generateDocx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 1000);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });

  t('PDF : buffer valide', async () => {
    const buf = await generatePdf({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test PDF' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 500);
    assert.equal(buf.slice(0, 4).toString(), '%PDF');
  });

  t('XLSX : buffer valide', async () => {
    const buf = await generateXlsx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test XLSX' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 1000);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });

  t('PPTX : buffer valide', async () => {
    const buf = await generatePptx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test PPTX' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 1000);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });

  t('PDF avec logo cover : buffer valide', async () => {
    const d = { ...sampleDesign, logo: { dataUri: TINY_PNG, position: 'cover' } };
    const buf = await generatePdf({ blocks: sampleBlocks, design: d, meta: { title: 'PDF logo' } });
    assert.ok(buf.length > 500);
  });

  t('PPTX avec logo cover : buffer valide', async () => {
    const d = { ...sampleDesign, logo: { dataUri: TINY_PNG, position: 'cover' } };
    const buf = await generatePptx({ blocks: sampleBlocks, design: d, meta: { title: 'PPTX logo' } });
    assert.ok(buf.length > 1000);
  });

  t('dispatcher : chaque format', async () => {
    for (const fmt of ['docx', 'pdf', 'xlsx', 'pptx']) {
      const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, meta: { title: fmt }, format: fmt });
      assert.ok(buf.length > 500, 'Format ' + fmt + ' trop petit');
    }
  });

  t('dispatcher : format invalide → erreur', async () => {
    await assert.rejects(
      () => generate({ blocks: sampleBlocks, design: sampleDesign, format: 'exe' }),
      /non supporté/
    );
  });

  t('route /m5/generate format=pdf', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/m5/generate', payload: { blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' }, format: 'pdf' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/pdf/);
    await app.close();
  });

  t('route /m5/generate format=xlsx', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/m5/generate', payload: { blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' }, format: 'xlsx' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /spreadsheetml/);
    await app.close();
  });

  t('route /m5/generate format=pptx', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/m5/generate', payload: { blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' }, format: 'pptx' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /presentationml/);
    await app.close();
  });

  t('feature flag OFF → 503', async () => {
    const old = process.env.M5_ENABLED;
    process.env.M5_ENABLED = 'false';
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/m5/generate', payload: { blocks: sampleBlocks, design: sampleDesign } });
    assert.equal(res.statusCode, 503);
    await app.close();
    process.env.M5_ENABLED = old;
  });

  t('route /health répond avec 4 formats', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().formats, ['docx', 'pdf', 'xlsx', 'pptx']);
    await app.close();
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ✅ ' + name);
    } catch (err) {
      failed++;
      console.error('  ❌ ' + name + '\n     → ' + err.message);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests OK');
  if (failed > 0) process.exit(1);
}

// ============================================================
// 11. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];

  if (mode === '--test') {
    console.log('🧪 Tests M5 (4 formats)…\n');
    await runTests();
    process.exit(0);
  }

  if (mode === '--selftest') {
    console.log('🔬 Smoke test M5…\n');
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
    console.log('\n🚀 M5 Office Generation → http://localhost:' + port);
    console.log('   POST /m5/generate   { blocks, design, meta, format: "docx"|"pdf"|"xlsx"|"pptx" }');
    console.log('   Frontend : http://localhost:' + port + '/');
    console.log('   Feature flag M5_ENABLED : ' + (isModuleEnabled() ? '✅ actif' : '❌ désactivé'));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (sig) => {
    console.log('\n⏹  ' + sig + ' → arrêt propre M5');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
