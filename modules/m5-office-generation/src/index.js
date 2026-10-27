#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Module M5 : Génération Office (4 formats)
 * Style TDR institutionnel + moteur PPTX professionnel
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

// ============================================================
// Animations PowerPoint niveau consultant
// Injectées dans le .pptx après génération via JSZip
// ============================================================
import JSZip from 'jszip';

/**
 * Injecte des animations pro dans un buffer PPTX.
 * @param {Buffer} pptxBuffer - Buffer du fichier .pptx
 * @param {Object} opts - { style: 'consultant'|'minimal' }
 * @returns {Promise<Buffer>} - Buffer animé
 */
async function injectAnimations(pptxBuffer, opts = {}) {
  const style = opts.style || 'consultant';
  const zip = await JSZip.loadAsync(pptxBuffer);

  // Trouver toutes les slides
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));

  for (const slidePath of slideFiles) {
    let xml = await zip.file(slidePath).async('string');

    // Compter les shapes présentes (p:sp pour shape, p:pic pour image, p:graphicFrame pour tableau)
    const shapeMatches = xml.match(/<p:(sp|pic|graphicFrame)[^>]*>/g) || [];
    const shapeCount = shapeMatches.length;

    if (shapeCount === 0) continue;

    // Générer le XML de timing selon le style
    const animXml = generateTimingXml(shapeCount, style);

    // Injecter avant </p:sld> (fin de slide)
    // Attention : la balise <p:timing> doit être ajoutée DANS <p:sld>, avant </p:sld>
    if (!xml.includes('<p:timing>')) {
      xml = xml.replace('</p:sld>', animXml + '</p:sld>');
    }

    await zip.file(slidePath, xml);
  }

  return await zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Génère le XML de timing pour une slide.
 * Utilise les animations PowerPoint natives (fade, slide-up, zoom).
 */
function generateTimingXml(shapeCount, style) {
  // Configuration selon style
  const configs = {
    consultant: {
      effects: ['fade', 'slide-up', 'zoom'],
      duration: 500,   // ms
      stagger: 200,    // ms entre éléments
      start: 'withPrevious',
    },
    minimal: {
      effects: ['fade'],
      duration: 300,
      stagger: 100,
      start: 'withPrevious',
    },
  };
  const config = configs[style] || configs.consultant;

  // Générer les effets par shape
  const effectEntries = [];
  const effectIds = [];
  for (let i = 0; i < shapeCount; i++) {
    const effId = 10 + i;
    const delay = i * config.stagger;
    const effect = config.effects[i % config.effects.length];

    effectEntries.push(
      '<p:par>' +
        '<p:cTn id="' + (50 + i) + '" presetID="' + getPresetId(effect) + '" ' +
        'presetClass="' + getPresetClass(effect) + '" presetSubtype="0" ' +
        'fill="hold" grpId="0" nodeType="' + (i === 0 ? 'clickEffect' : 'withEffect') + '">' +
          '<p:stCondLst><p:cond delay="' + delay + '"/></p:stCondLst>' +
          '<p:childTnLst>' +
            '<p:animEffect transition="in" filter="' + getFilter(effect) + '">' +
              '<p:cBhvr>' +
                '<p:cTn id="' + (60 + i) + '" dur="' + config.duration + '"/>' +
                '<p:tgtEl><p:spTgt spid="' + (2 + i) + '"/></p:tgtEl>' +
              '</p:cBhvr>' +
            '</p:animEffect>' +
          '</p:childTnLst>' +
        '</p:cTn>' +
      '</p:par>'
    );
    effectIds.push(effId);
  }

  return (
    '<p:timing>' +
      '<p:tnLst>' +
        '<p:par>' +
          '<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">' +
            '<p:childTnLst>' +
              '<p:seq concurrent="1" nextAc="seek">' +
                '<p:cTn id="2" dur="indefinite" nodeType="mainSeq">' +
                  '<p:childTnLst>' +
                    effectEntries.join('') +
                  '</p:childTnLst>' +
                '</p:cTn>' +
                '<p:prevCondLst>' +
                  '<p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond>' +
                '</p:prevCondLst>' +
                '<p:nextCondLst>' +
                  '<p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond>' +
                '</p:nextCondLst>' +
              '</p:seq>' +
            '</p:childTnLst>' +
          '</p:cTn>' +
        '</p:par>' +
      '</p:tnLst>' +
    '</p:timing>'
  );
}

function getPresetId(effect) {
  return { fade: 10, 'slide-up': 22, zoom: 23 }[effect] || 10;
}
function getPresetClass(effect) {
  return { fade: 'entr', 'slide-up': 'entr', zoom: 'entr' }[effect] || 'entr';
}
function getFilter(effect) {
  return { fade: 'fade', 'slide-up': 'slide(fromBottom)', zoom: 'zoom(in)' }[effect] || 'fade';
}

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// ============================================================
// 1. CONTRAT v1
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
// 3. TDR STYLE — Constantes institutionnelles
// ============================================================
const TDR_COLORS = {
  primary: 'E30613',
  secondary: '6B7280',
  text: '1F2937',
  tableHeader: 'D9D9D9',
  tableBorder: 'BFBFBF',
};

const TDR_FONTS = {
  heading: 'Calibri',
  body: 'Calibri',
};

const TDR_SPACING = {
  h1Before: 400,
  h1After: 200,
  h2Before: 300,
  h2After: 150,
  bodyAfter: 120,
  line: 276,
};

function createNumbering() {
  return { h1: 0, h2: 0, h3: 0 };
}

function nextH1(numbering) {
  numbering.h1++;
  numbering.h2 = 0;
  return numbering.h1 + '.';
}

function nextH2(numbering) {
  numbering.h2++;
  return numbering.h1 + '.' + numbering.h2 + '.';
}

// ============================================================
// 4. LOGO UTILS
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
// 5. GÉNÉRATEUR .DOCX (style TDR)
// ============================================================
export function buildDocx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const layout = design.layout || {};
  const logoDataUri = design.logo?.dataUri || null;
  const logoPosition = design.logo?.position || layout.logo_position || null;
  const children = [];
  const numbering = createNumbering();

  // ── Couverture ──
  if (layout.cover_page) {
    if (logoDataUri && logoPosition === 'cover') {
      const img = buildImageRun(logoDataUri);
      if (img) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 2000, after: 400 },
          children: [img],
        }));
      }
    } else {
      children.push(new Paragraph({ spacing: { before: 4000 } }));
    }
    children.push(
      new Paragraph({
        spacing: { before: 0, after: 2000 },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: (meta.title || 'Document DocForge AI').toUpperCase(),
          bold: true, size: 56,
          color: TDR_COLORS.primary,
          font: TDR_FONTS.heading,
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: meta.subtitle || 'Document institutionnel',
          size: 24,
          color: TDR_COLORS.secondary,
          font: TDR_FONTS.body,
        })],
      }),
      new Paragraph({ spacing: { before: 400 }, children: [new PageBreak()] })
    );
  }

  // ── Sommaire ──
  if (layout.table_of_contents) {
    const headings = blocks.filter((b) => b.level === 'h1' || b.level === 'h2');
    if (headings.length > 0) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({
          text: 'SOMMAIRE',
          bold: true, color: TDR_COLORS.primary, font: TDR_FONTS.heading,
        })],
      }));
      let h1Count = 0, h2Count = 0;
      for (const h of headings) {
        if (h.level === 'h1') {
          h1Count++; h2Count = 0;
          children.push(new Paragraph({
            spacing: { after: 80 },
            children: [new TextRun({
              text: `${h1Count}. ${h.content}`,
              bold: true, size: 22, color: TDR_COLORS.text, font: TDR_FONTS.body,
            })],
          }));
        } else {
          h2Count++;
          children.push(new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            children: [new TextRun({
              text: `${h1Count}.${h2Count}. ${h.content}`,
              size: 20, color: TDR_COLORS.secondary, font: TDR_FONTS.body,
            })],
          }));
        }
      }
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  // ── Contenu ──
  for (const block of blocks) {
    children.push(...renderDocxBlock(block, theme, numbering));
  }

  // ── Headers / Footers ──
  const headers = {};
  if (logoDataUri && logoPosition === 'header') {
    const img = buildImageRun(logoDataUri);
    if (img) {
      headers.default = new Header({
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [img] })],
      });
    }
  }

  const footers = {
    default: new Footer({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: meta.footer || 'Document généré par DocForge AI',
          size: 16, color: '9CA3AF', font: TDR_FONTS.body,
        })],
      })],
    }),
  };

  return new Document({
    creator: meta.author || 'DocForge AI',
    title: meta.title || 'Document',
    styles: {
      default: {
        document: {
          run: { font: TDR_FONTS.body, size: 22, color: TDR_COLORS.text },
          paragraph: { spacing: { line: TDR_SPACING.line, after: TDR_SPACING.bodyAfter } },
        },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1417, right: 1417, bottom: 1417, left: 1417 } } },
      headers: headers.default ? { default: headers.default } : undefined,
      footers,
      children,
    }],
  });
}

function renderDocxBlock(block, theme, numbering = createNumbering()) {
  const out = [];
  const primaryHex = theme.primary || TDR_COLORS.primary;
  const fontHeading = theme.font_heading || TDR_FONTS.heading;
  const fontBody = theme.font_body || TDR_FONTS.body;

  // ─── H1 : 16pt, GRAS, ROUGE, MAJUSCULES, numéroté "1." ───
  if (block.type === 'text' && block.level === 'h1') {
    if (numbering.h1 > 0) {
      out.push(new Paragraph({ children: [new PageBreak()] }));
    }
    const num = nextH1(numbering);
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 240 },
        children: [
          new TextRun({
            text: (num + ' ' + (block.content || '')).toUpperCase(),
            bold: true,
            size: 32,               // 16pt
            color: primaryHex,      // ROUGE #E30613
            font: fontHeading,
          }),
        ],
      })
    );
    return out;
  }

  // ─── H2 : 14pt, GRAS, ROUGE, numéroté "1.1." ───
  if (block.type === 'text' && block.level === 'h2') {
    const num = nextH2(numbering);
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 320, after: 160 },
        children: [
          new TextRun({
            text: num + ' ' + (block.content || ''),
            bold: true,
            size: 28,               // 14pt
            color: primaryHex,      // ROUGE
            font: fontHeading,
          }),
        ],
      })
    );
    return out;
  }

  // ─── H3 : 12pt, GRAS, NOIR, souligné, numéroté "1.1.1." ───
  if (block.type === 'text' && block.level === 'h3') {
    // Incrémenter un sous-compteur
    if (!numbering.h3) numbering.h3 = 0;
    numbering.h3++;
    const num = numbering.h1 + '.' + numbering.h2 + '.' + numbering.h3 + '.';

    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 120 },
        children: [
          new TextRun({
            text: num + ' ' + (block.content || ''),
            bold: true,
            size: 24,               // 12pt
            color: TDR_COLORS.text, // NOIR #1F2937
            font: fontHeading,
          }),
        ],
      })
    );
    return out;
  }

  // ─── Puces carrées ───
  if (block.type === 'list') {
    const text = (block.content || '').replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    out.push(
      new Paragraph({
        spacing: { after: 80, line: 276 },
        indent: { left: 720, hanging: 360 },
        children: [
          new TextRun({ text: '•  ', size: 22, color: primaryHex, font: fontBody }),
          new TextRun({ text, size: 22, font: fontBody, color: TDR_COLORS.text }),
        ],
      })
    );
    return out;
  }

  // ─── Citation ───
  if (block.type === 'quote') {
    out.push(
      new Paragraph({
        indent: { left: 720, right: 720 },
        spacing: { before: 120, after: 120, line: 276 },
        border: { left: { color: primaryHex, space: 8, style: BorderStyle.SINGLE, size: 18 } },
        children: [
          new TextRun({
            text: block.content || '',
            italics: true, size: 22, color: '4B5563', font: fontBody,
          }),
        ],
      })
    );
    return out;
  }

  // ─── Tableau ───
  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
    const rows = block.rows;
    const headerRow = new TableRow({
      tableHeader: true,
      children: rows[0].map((cell) => new TableCell({
        shading: { fill: TDR_COLORS.tableHeader },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            text: String(cell), bold: true, size: 20,
            color: TDR_COLORS.text, font: fontHeading,
          })],
        })],
      })),
    });
    const bodyRows = rows.slice(1).map((row) => new TableRow({
      children: row.map((cell) => new TableCell({
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({
            text: String(cell), size: 20, font: fontBody, color: TDR_COLORS.text,
          })],
        })],
      })),
    }));
    out.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
        left: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
        right: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: TDR_COLORS.tableBorder },
      },
      rows: [headerRow, ...bodyRows],
    }));
    out.push(new Paragraph({ spacing: { after: 200 } }));
    return out;
  }

  // ─── Paragraphe ───
  out.push(
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120, line: 276 },
      children: [
        new TextRun({
          text: block.content || '', size: 22, font: fontBody, color: TDR_COLORS.text,
        }),
      ],
    })
  );
  return out;
}

export async function generateDocx({ blocks, design, meta = {} }) {
  const doc = buildDocx({ blocks, design, meta });
  return await Packer.toBuffer(doc);
}

// ============================================================
// 6. GÉNÉRATEUR .PDF (style TDR)
// ============================================================
export async function generatePdf({ blocks, design, meta = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const theme = design.theme || {};
      const layout = design.layout || {};
      const primaryColor = '#' + (theme.primary || TDR_COLORS.primary).replace('#', '');
      const fontBody = 'Helvetica';

      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: { Title: meta.title || 'Document', Author: meta.author || 'DocForge AI' },
        bufferPages: true,
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (layout.cover_page) {
        doc.moveDown(8);
        doc.fillColor(primaryColor).fontSize(28).font('Helvetica-Bold')
          .text((meta.title || 'Document DocForge AI').toUpperCase(), { align: 'center' });
        doc.moveDown(2);
        doc.fillColor(TDR_COLORS.secondary).fontSize(14).font(fontBody)
          .text(meta.subtitle || 'Document institutionnel', { align: 'center' });
        doc.addPage();
      }

      const numbering = createNumbering();
      for (const block of blocks) {
        renderPdfBlock(doc, block, theme, numbering);
      }

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#9CA3AF').fontSize(9).font(fontBody).text(
          `Page ${i + 1} / ${range.count}`,
          50, doc.page.height - 40,
          { align: 'center', width: doc.page.width - 100 }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderPdfBlock(doc, block, theme, numbering = createNumbering()) {
  const primaryColor = '#' + (theme.primary || TDR_COLORS.primary).replace('#', '');
  const fontBody = 'Helvetica';

  // ─── H1 : 18pt, GRAS, ROUGE, MAJUSCULES, numéroté ───
  if (block.type === 'text' && block.level === 'h1') {
    if (numbering.h1 > 0) doc.addPage();
    const num = nextH1(numbering);
    doc.moveDown(0.8);
    doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold')
      .text((num + ' ' + (block.content || '')).toUpperCase());
    doc.moveDown(0.6);
    return;
  }

  // ─── H2 : 14pt, GRAS, ROUGE, numéroté ───
  if (block.type === 'text' && block.level === 'h2') {
    const num = nextH2(numbering);
    doc.moveDown(0.6);
    doc.fillColor(primaryColor).fontSize(14).font('Helvetica-Bold')
      .text(num + ' ' + (block.content || ''));
    doc.moveDown(0.4);
    return;
  }

  // ─── H3 : 12pt, GRAS, NOIR, numéroté ───
  if (block.type === 'text' && block.level === 'h3') {
    if (!numbering.h3) numbering.h3 = 0;
    numbering.h3++;
    const num = numbering.h1 + '.' + numbering.h2 + '.' + numbering.h3 + '.';
    doc.moveDown(0.4);
    doc.fillColor(TDR_COLORS.text).fontSize(12).font('Helvetica-Bold')
      .text(num + ' ' + (block.content || ''));
    doc.moveDown(0.3);
    return;
  }

  // ─── Puces ───
  if (block.type === 'list') {
    const text = (block.content || '').replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    doc.fillColor(primaryColor).fontSize(11).font(fontBody)
      .text('•  ', { continued: true, indent: 20 });
    doc.fillColor(TDR_COLORS.text).text(text, { lineGap: 2 });
    return;
  }

  // ─── Citation ───
  if (block.type === 'quote') {
    doc.moveDown(0.4);
    const startX = doc.x;
    const startY = doc.y;
    doc.fillColor(primaryColor).rect(startX, startY, 3, 40).fill();
    doc.fillColor('4B5563').fontSize(11).font('Helvetica-Oblique')
      .text(block.content || '', startX + 15, startY + 5, { width: doc.page.width - startX - 70 });
    doc.moveDown(1.2);
    return;
  }

  // ─── Tableau ───
  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
    doc.moveDown(0.5);
    const rows = block.rows;
    const colCount = Math.max(...rows.map((r) => r.length));
    const colWidth = (doc.page.width - 100) / colCount;
    const rowHeight = 26;
    const startX = doc.x;
    const startY = doc.y;

    rows.forEach((row, rowIdx) => {
      const y = startY + rowIdx * rowHeight;
      row.forEach((cell, colIdx) => {
        const x = startX + colIdx * colWidth;
        if (rowIdx === 0) {
          doc.fillColor('#D9D9D9').rect(x, y, colWidth, rowHeight).fill();
        } else {
          doc.fillColor('#FFFFFF').rect(x, y, colWidth, rowHeight).fill();
        }
        doc.strokeColor(TDR_COLORS.tableBorder).lineWidth(0.5).rect(x, y, colWidth, rowHeight).stroke();
        doc.fillColor(TDR_COLORS.text)
          .fontSize(10).font(rowIdx === 0 ? 'Helvetica-Bold' : fontBody)
          .text(String(cell), x + 6, y + 7, { width: colWidth - 12, height: rowHeight - 12, ellipsis: true });
      });
    });

    doc.y = startY + rows.length * rowHeight + 15;
    doc.x = startX;
    return;
  }

  // ─── Paragraphe ───
  doc.fillColor(TDR_COLORS.text).fontSize(11).font(fontBody)
    .text(block.content || '', { align: 'justify', lineGap: 3 });
  doc.moveDown(0.5);
}

// ============================================================
// 7. GÉNÉRATEUR .XLSX
// ============================================================
export async function generateXlsx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const primaryHex = theme.primary || TDR_COLORS.primary;
  const secondaryHex = theme.secondary || TDR_COLORS.secondary;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.author || 'DocForge AI';
  workbook.created = new Date();

  // Feuille 1 : Sommaire
  const summary = workbook.addWorksheet('Sommaire', { properties: { defaultRowHeight: 22 } });
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
    sumRow++;
  }

  // Feuille 2 : Contenu
  const sheet = workbook.addWorksheet('Contenu', { properties: { defaultRowHeight: 20 } });
  sheet.columns = [
    { width: 6 }, { width: 80 },
    { width: 20 }, { width: 20 }, { width: 20 },
    { width: 20 }, { width: 20 }, { width: 20 },
    { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 },
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
      cell.alignment = { vertical: 'middle', indent: 2 };
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
      currentRow += 1;
      continue;
    }

    if (block.type === 'text' && block.level === 'body' && block.content) {
      sheet.mergeCells('A' + currentRow + ':B' + currentRow);
      const cell = sheet.getCell('A' + currentRow);
      cell.value = block.content;
      cell.font = { size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true };
      sheet.getRow(currentRow).height = Math.max(20, Math.ceil(block.content.length / 90) * 16);
      currentRow += 1;
      continue;
    }

    if (block.type === 'list') {
      const text = (block.content || '').replace(/^[-*•]\s*/, '');
      sheet.getCell('A' + currentRow).value = '•';
      sheet.getCell('A' + currentRow).font = { size: 12, bold: true, color: { argb: 'FF' + primaryHex } };
      sheet.getCell('A' + currentRow).alignment = { horizontal: 'right', vertical: 'top' };
      const cell = sheet.getCell('B' + currentRow);
      cell.value = text;
      cell.font = { size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true, indent: 1 };
      currentRow += 1;
      continue;
    }

    if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
      const rows = block.rows;
      rows[0].forEach((cell, colIdx) => {
        const excelCell = sheet.getCell(currentRow, colIdx + 2);
        excelCell.value = cell;
        excelCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryHex } };
        excelCell.alignment = { vertical: 'middle', horizontal: 'center' };
      });
      currentRow++;
      rows.slice(1).forEach((row, rowIdx) => {
        row.forEach((cell, colIdx) => {
          const excelCell = sheet.getCell(currentRow, colIdx + 2);
          excelCell.value = cell;
          excelCell.font = { size: 10 };
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
        currentRow++;
      });
      currentRow++;
      continue;
    }
  }

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// 8. GÉNÉRATEUR .PPTX (moteur professionnel)
// ============================================================

// ============================================================
// Helper anti-corruption PPTX
// Normalise les tableaux avant envoi à PptxGenJS
// ============================================================
function safeTableRows(rows, theme = {}) {
  const primary = (theme.primary || TDR_COLORS.primary).replace('#', '');

  // Filtrer les rows invalides
  if (!Array.isArray(rows) || rows.length < 2) {
    return null;  // Un tableau PPTX doit avoir au moins 2 lignes
  }

  // Calculer le nombre max de colonnes (uniformisation)
  const maxCols = Math.max(...rows.map((r) => Array.isArray(r) ? r.length : 0));
  if (maxCols < 1) return null;

  // Normaliser : chaque ligne doit avoir EXACTEMENT maxCols cellules
  const normalized = rows.map((row) => {
    const safeRow = Array.isArray(row) ? row : [];
    const padded = [];
    for (let i = 0; i < maxCols; i++) {
      const val = safeRow[i];
      padded.push(String(val == null ? '' : val).trim());
    }
    return padded;
  });

  // Générer les objets cellules avec options
  return normalized.map((row, rIdx) => row.map((cell) => ({
    text: cell,
    options: {
      bold: rIdx === 0,
      color: rIdx === 0 ? 'FFFFFF' : '1F2937',
      fill: { color: rIdx === 0 ? primary : (rIdx % 2 === 0 ? 'F8FAFC' : 'FFFFFF') },
      fontSize: normalized.length > 8 ? 9 : 11,
      fontFace: 'Calibri',
      align: rIdx === 0 ? 'center' : 'left',
      valign: 'middle',
    },
  })));
}

export async function generatePptx({ blocks, design, meta = {} }) {
  const theme = design.theme || {};
  const primary = (theme.primary || TDR_COLORS.primary).replace('#', '');
  const secondary = (theme.secondary || TDR_COLORS.secondary).replace('#', '');
  const accent = (theme.accent || '0ea5e9').replace('#', '');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = meta.author || 'DocForge AI';
  pptx.title = meta.title || 'Document';

  const MARGIN_X = 0.6;
  const CONTENT_Y = 1.3;
  const CONTENT_W = 10 - 2 * MARGIN_X;
  const MAX_CHARS_PER_SLIDE = 500;
  const MAX_BULLETS = 6;
  const CHARS_PER_LINE = 95;

  let slideNum = 0;

  function addFooter(slide) {
    // Trait séparateur fin
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.4, y: 5.25, w: 9.2, h: 0.01,
      fill: { color: 'E5E7EB' },
    });
    // Texte footer
    slide.addText(meta.footer || 'Document généré par DocForge AI', {
      x: 0.4, y: 5.32, w: 8, h: 0.2,
      fontSize: 9, color: secondary, fontFace: 'Calibri',
    });
    // Numéro de slide
    slide.addText(String(slideNum), {
      x: 9.2, y: 5.32, w: 0.5, h: 0.2,
      fontSize: 10, bold: true, color: primary,
      fontFace: 'Calibri', align: 'right',
    });
  }

  // Découpe un texte long en plusieurs morceaux (max 300 chars chacun)
  function splitLongText(text, maxChars = 300) {
    if (!text || text.length <= maxChars) return [text];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
  }

  function addContentHeader(slide, title) {
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 10, h: 0.9, fill: { color: primary },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0.9, w: 1.2, h: 0.06, fill: { color: accent },
    });
    slide.addText(title || '', {
      x: 0.5, y: 0.1, w: 9, h: 0.7,
      fontSize: 22, bold: true, color: 'FFFFFF',
      fontFace: 'Calibri', valign: 'middle',
    });
  }

  function estimateLines(text, fontSize = 14) {
    const charsPerLine = Math.floor(CHARS_PER_LINE * (14 / fontSize));
    return Math.ceil((text || '').length / charsPerLine);
  }

  function makeContentSlide({ title, items }) {
    const slide = pptx.addSlide();
    slideNum++;
    slide.background = { color: 'FFFFFF' };
    addContentHeader(slide, title);

    const validItems = (items || []).filter((it) => it && it.text && it.text.trim());
    if (validItems.length === 0) {
      addFooter(slide);
      return;
    }

    let totalLines = 0;
    for (const it of validItems) {
      totalLines += estimateLines(it.text, 14) + (it.type === 'list' ? 0 : 0.5);
    }

    let fontSize = 15;
    let lineSpacing = 1.35;
    if (totalLines > 30) { fontSize = 11; lineSpacing = 1.15; }
    else if (totalLines > 22) { fontSize = 12; lineSpacing = 1.2; }
    else if (totalLines > 16) { fontSize = 13; lineSpacing = 1.25; }
    else if (totalLines > 10) { fontSize = 14; lineSpacing = 1.3; }

    const textRuns = validItems.map((it) => {
      if (it.type === 'list') {
        return {
          text: it.text,
          options: {
            bullet: true,
            fontSize, color: '1F2937', fontFace: 'Calibri',
            breakLine: true, paraSpaceAfter: 6,
            lineSpacingMultiple: lineSpacing,
          },
        };
      }
      if (it.type === 'quote') {
        return {
          text: '« ' + it.text + ' »',
          options: {
            italic: true, fontSize: fontSize - 1,
            color: '4B5563', fontFace: 'Calibri',
            breakLine: true, paraSpaceBefore: 8, paraSpaceAfter: 8,
            lineSpacingMultiple: lineSpacing,
          },
        };
      }
      return {
        text: it.text,
        options: {
          fontSize, color: '1F2937', fontFace: 'Calibri',
          breakLine: true, paraSpaceAfter: 10,
          lineSpacingMultiple: lineSpacing,
        },
      };
    });

    slide.addText(textRuns, {
      x: MARGIN_X, y: CONTENT_Y, w: CONTENT_W, h: 3.6,
      valign: 'top',
      fit: 'shrink',
      autoFit: true,
    });

    addFooter(slide);
  }

  function makeSectionSlide(title) {
    const slide = pptx.addSlide();
    slideNum++;
    slide.background = { color: primary };
    slide.addText((title || '').toUpperCase(), {
      x: 0.7, y: 1.9, w: 8.6, h: 1.6,
      fontSize: 32, bold: true, color: 'FFFFFF',
      fontFace: 'Calibri', align: 'center', valign: 'middle',
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 4.3, y: 3.7, w: 1.4, h: 0.06, fill: { color: 'FFFFFF' },
    });
    addFooter(slide);
  }

  // ── Slide 1 : Couverture ──
  {
    const cover = pptx.addSlide();
    slideNum++;
    cover.background = { color: primary };

    if (design.logo?.dataUri && typeof design.logo.dataUri === 'string'
        && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(design.logo.dataUri)) {
      try {
        cover.addImage({
          data: design.logo.dataUri,
          x: 4.2, y: 1.0, w: 1.6, h: 0.7,
          sizing: { type: 'contain' },
        });
      } catch (e) {
        // Image invalide → on ignore silencieusement (pas de corruption)
      }
    }

    cover.addText((meta.title || 'Document DocForge AI').toUpperCase(), {
      x: 0.7, y: 2.2, w: 8.6, h: 1.4,
      fontSize: 32, bold: true, color: 'FFFFFF',
      fontFace: 'Calibri', align: 'center', valign: 'middle',
    });

    if (meta.subtitle) {
      cover.addText(meta.subtitle, {
        x: 0.7, y: 3.7, w: 8.6, h: 0.5,
        fontSize: 15, color: 'E0E7FF',
        fontFace: 'Calibri', align: 'center',
      });
    }

    cover.addShape(pptx.ShapeType.rect, {
      x: 4.3, y: 4.3, w: 1.4, h: 0.05, fill: { color: 'FFFFFF' },
    });

    cover.addText(new Date().toLocaleDateString('fr-FR', {
      year: 'numeric', month: 'long', day: 'numeric',
    }), {
      x: 0.7, y: 4.6, w: 8.6, h: 0.3,
      fontSize: 11, color: 'E0E7FF',
      fontFace: 'Calibri', italic: true, align: 'center',
    });
  }

  // ── Parcours ──
  let currentSection = meta.title || 'Contenu';
  let currentItems = [];
  let pendingTable = null;

  const flushContent = () => {
    if (pendingTable) {
      const slide = pptx.addSlide();
      slideNum++;
      slide.background = { color: 'FFFFFF' };
      addContentHeader(slide, currentSection);

      const rows = pendingTable.rows;
      const safeRows = safeTableRows(rows, theme);

      if (!safeRows) {
        // Tableau invalide → on le rend en texte
        addContentHeader(slide, currentSection);
        const textContent = (rows || []).map((r) =>
          Array.isArray(r) ? r.join(' | ') : String(r)
        ).join('\n');
        slide.addText(textContent, {
          x: MARGIN_X, y: CONTENT_Y, w: CONTENT_W, h: 3.6,
          fontSize: 12, color: '1F2937', fontFace: 'Calibri',
          valign: 'top',
        });
      } else {
        const tableH = Math.min(3.6, safeRows.length * 0.32 + 0.3);
        slide.addTable(safeRows, {
          x: MARGIN_X, y: CONTENT_Y, w: CONTENT_W, h: tableH,
          border: { type: 'solid', color: 'E5E7EB', pt: 0.5 },
          autoPage: false, valign: 'middle',
        });
      }
      addFooter(slide);
      pendingTable = null;
    }

    if (currentItems.length > 0) {
      let buffer = [];
      let bufferChars = 0;
      let bufferBullets = 0;

      const flushBuffer = (title) => {
        if (buffer.length === 0) return;
        makeContentSlide({ title, items: buffer });
        buffer = [];
        bufferChars = 0;
        bufferBullets = 0;
      };

      for (const item of currentItems) {
        const isBullet = item.type === 'list';
        const charCount = (item.text || '').length;
        const wouldOverflow =
          bufferChars + charCount > MAX_CHARS_PER_SLIDE ||
          (isBullet && bufferBullets + 1 > MAX_BULLETS);

        if (wouldOverflow && buffer.length > 0) {
          flushBuffer(currentSection);
        }

        // Découpage intelligent des body longs
        if (!isBullet && charCount > 400) {
          const chunks = splitLongText(item.text, 350);
          for (let i = 0; i < chunks.length; i++) {
            buffer.push({
              type: item.type,
              text: chunks[i],
              _continued: i > 0 ? ' (suite)' : '',
            });
            bufferChars += chunks[i].length;
          }
        } else {
          buffer.push(item);
          bufferChars += charCount;
        }
        if (isBullet) bufferBullets++;
      }
      flushBuffer(currentSection);
      currentItems = [];
    }
  };

  for (const block of blocks) {
    if (block.type === 'text' && block.level === 'h1') {
      flushContent();
      makeSectionSlide(block.content || 'Section');
      currentSection = block.content || 'Section';
      continue;
    }
    if (block.type === 'text' && block.level === 'h2') {
      flushContent();
      currentSection = block.content || 'Contenu';
      continue;
    }
    if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length > 0) {
      flushContent();
      pendingTable = block;
      continue;
    }
    if (block.content && block.content.trim()) {
      currentItems.push({ type: block.type, text: block.content });
    }
  }
  flushContent();

  // ── Slide finale ──
  {
    const end = pptx.addSlide();
    slideNum++;
    end.background = { color: primary };
    end.addText('Merci', {
      x: 0.7, y: 2.2, w: 8.6, h: 1.0,
      fontSize: 44, bold: true, color: 'FFFFFF',
      fontFace: 'Calibri', align: 'center',
    });
    end.addShape(pptx.ShapeType.rect, {
      x: 4.3, y: 3.3, w: 1.4, h: 0.06, fill: { color: 'FFFFFF' },
    });
    end.addText(meta.author || 'DocForge AI', {
      x: 0.7, y: 3.6, w: 8.6, h: 0.4,
      fontSize: 14, color: 'E0E7FF',
      fontFace: 'Calibri', align: 'center',
    });
  }

  let buffer = await pptx.write({ outputType: 'nodebuffer' });
  buffer = Buffer.from(buffer);

  // Animations si demandées
  const wantAnimations = design.animations === true || meta.animations === true;
  if (wantAnimations) {
    try {
      buffer = await injectAnimations(buffer, { style: 'consultant' });
    } catch (e) {
      console.warn('[PPTX] Animation failed:', e.message);
    }
  }

  return buffer;
}

// ============================================================
// 9. DISPATCHER
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
// 10. ROUTES FASTIFY
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

  app.get('/health', async () => ({
    status: 'ok',
    module: 'M5',
    enabled: isModuleEnabled(),
    formats: ['docx', 'pdf', 'xlsx', 'pptx'],
  }));

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
// 11. TESTS
// ============================================================
export async function runTests() {
  const { default: assert } = await import('node:assert');
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  const sampleDesign = {
    template: 'consulting',
    theme: { primary: '#E30613', secondary: '#6B7280', accent: '#DC2626',
             font_heading: 'Calibri', font_body: 'Calibri', font_mono: 'Consolas' },
    layout: { cover_page: true, table_of_contents: true, section_breaks: true },
  };
  const sampleBlocks = [
    { level: 'h1', type: 'text', content: 'Titre principal' },
    { level: 'body', type: 'text', content: 'Paragraphe explicatif.' },
    { level: 'body', type: 'list', content: 'Point A' },
    { level: 'body', type: 'list', content: 'Point B' },
    { level: 'body', type: 'table', content: '', rows: [['Col A', 'Col B'], ['V1', 'V2']] },
  ];

  t('DOCX : buffer valide', async () => {
    const buf = await generateDocx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf[0], 0x50);
  });
  t('PDF : buffer valide', async () => {
    const buf = await generatePdf({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.equal(buf.slice(0, 4).toString(), '%PDF');
  });
  t('XLSX : buffer valide', async () => {
    const buf = await generateXlsx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.equal(buf[0], 0x50);
  });
  t('PPTX : buffer valide', async () => {
    const buf = await generatePptx({ blocks: sampleBlocks, design: sampleDesign, meta: { title: 'Test' } });
    assert.equal(buf[0], 0x50);
  });
  t('dispatcher : 4 formats', async () => {
    for (const fmt of ['docx', 'pdf', 'xlsx', 'pptx']) {
      const buf = await generate({ blocks: sampleBlocks, design: sampleDesign, format: fmt });
      assert.ok(buf.length > 500);
    }
  });
  t('format invalide → erreur', async () => {
    await assert.rejects(
      () => generate({ blocks: sampleBlocks, design: sampleDesign, format: 'exe' }),
      /non supporté/
    );
  });
  t('/health : 4 formats', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(res.json().formats, ['docx', 'pdf', 'xlsx', 'pptx']);
    await app.close();
  });
  t('feature flag OFF → 503', async () => {
    process.env.M5_ENABLED = 'false';
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/m5/generate',
      payload: { blocks: sampleBlocks, design: sampleDesign } });
    assert.equal(res.statusCode, 503);
    await app.close();
    process.env.M5_ENABLED = 'true';
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ✅ ' + name); }
    catch (err) { failed++; console.error('  ❌ ' + name + '\n     → ' + err.message); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests OK');
  if (failed > 0) process.exit(1);
}

// ============================================================
// 12. POINT D'ENTRÉE
// ============================================================
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const mode = process.argv[2];
  if (mode === '--test') {
    console.log('🧪 Tests M5…\n');
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
    console.log('   POST /m5/generate   { blocks, design, meta, format }');
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
