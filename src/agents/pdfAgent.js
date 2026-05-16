/**
 * PdfAgent — Geração de PDF profissional do e-book
 * Usa pdfkit com formatação de livro real + ilustrações AI por capítulo
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/logger');
const { generateImage } = require('./imageGenAgent');
const { detectCategory, buildIllustrationPrompt } = require('./coverAgent');
const { ensureQualityIllustration, validateEbook, validatePDF } = require('./qualityAgent');
const logger = createLogger('pdfAgent');

// Gerar ilustração para um capítulo via QA agent
async function generateChapterIllustration(chapterTitle, topic, category) {
  return ensureQualityIllustration(async (title, tpc) => {
    const tmpPath = path.join(os.tmpdir(), `illus_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    const prompt  = buildIllustrationPrompt(title, tpc);
    await generateImage({ prompt, width: 768, height: 432, outputPath: tmpPath });
    return tmpPath;
  }, chapterTitle, topic);
}

const PDFS_DIR = path.join(__dirname, '../../data/pdfs');

const COLORS = {
  primary: '#1A1A2E',
  accent: '#E94560',
  text: '#2C2C2C',
  muted: '#666666',
  light: '#F5F5F5',
  white: '#FFFFFF',
};

function addHeader(doc, title, pageNum) {
  const W = doc.page.width;
  const contentW = W - 120;
  doc.fontSize(9)
     .fillColor(COLORS.muted)
     .font('Helvetica')
     .text(title, 60, 30, { align: 'left', width: contentW - 40 })
     .text(`${pageNum}`, 60, 30, { align: 'right', width: contentW });

  doc.moveTo(60, 46).lineTo(W - 60, 46).strokeColor('#DDDDDD').lineWidth(0.5).stroke();
}

function addFooter(doc) {
  const W = doc.page.width;
  const contentW = W - 120;
  // Coloca rodapé logo após o conteúdo (mín. 30pt abaixo do texto, máx. no fundo da página)
  const afterContent = doc.y + 30;
  const pageBottom   = doc.page.height - 50;
  const y = afterContent < pageBottom - 40 ? afterContent : pageBottom;

  doc.moveTo(60, y).lineTo(W - 60, y).strokeColor('#DDDDDD').lineWidth(0.5).stroke();
  doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica')
     .text('© Veloxis Editorial — Todos os direitos reservados', 60, y + 8, { align: 'center', width: contentW });
}

function formatChapterContent(doc, content, title) {
  const lines = content.split('\n');
  let inCallout = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      doc.moveDown(0.3);
      inCallout = false;
      continue;
    }

    // Detectar subtítulos (linhas curtas em destaque ou com ##)
    if ((trimmed.startsWith('##') || trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length < 80)) {
      const subtitle = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
      doc.moveDown(0.8)
         .fontSize(14)
         .font('Helvetica-Bold')
         .fillColor(COLORS.primary)
         .text(subtitle, { continued: false });
      doc.moveDown(0.3);
      continue;
    }

    // Detectar callouts (Dica Prática, Atenção, Nota)
    if (trimmed.match(/^(Dica Prática|Atenção|💡|🔑|⚠️|Nota:|Importante:)/i)) {
      inCallout = true;
      doc.moveDown(0.5);
      const cW = doc.page.width - 120;
      doc.rect(doc.x - 5, doc.y, cW, 18).fill('#FFF8E7');
      doc.fillColor('#B8860B').fontSize(11).font('Helvetica-Bold')
         .text(trimmed.replace(/[💡🔑⚠️]/g, '').trim());
      doc.moveDown(0.2);
      continue;
    }

    if (inCallout) {
      doc.fillColor('#5C4A00').fontSize(10.5).font('Helvetica-Oblique').text(trimmed);
      doc.moveDown(0.2);
      continue;
    }

    // Detectar listas com bullet
    if (trimmed.match(/^[-•*]\s/) || trimmed.match(/^\d+\.\s/)) {
      const bulletText = trimmed.replace(/^[-•*]\s/, '• ').replace(/\*\*/g, '');
      doc.fontSize(11).font('Helvetica').fillColor(COLORS.text)
         .text(bulletText, { indent: 20, continued: false });
      continue;
    }

    // Texto normal
    const cleanText = trimmed.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
    doc.fontSize(11).font('Helvetica').fillColor(COLORS.text)
       .text(cleanText, { align: 'justify', lineGap: 3 });
  }
}

async function generatePDF(ebook, coverPath) {
  logger.info(`Gerando PDF: ${ebook.title}`);

  // QA do conteúdo do e-book
  const qa = await validateEbook({ ...ebook, coverPath });
  if (!qa.ok) {
    throw new Error(`E-book reprovado no QA: ${qa.issues.join('; ')}`);
  }

  const category = detectCategory(ebook.topic || '');

  // Pré-gerar ilustrações dos capítulos SEQUENCIALMENTE (evita rate limit do Pollinations)
  logger.info(`🖼️  Pré-gerando ilustrações para ${ebook.chapters.length} capítulos (sequencial)...`);
  const illustrationPaths = new Array(ebook.chapters.length).fill(null);
  for (let i = 0; i < ebook.chapters.length; i++) {
    const ch = ebook.chapters[i];
    logger.info(`   [${i+1}/${ebook.chapters.length}] Ilustração: "${ch.title}"`);
    illustrationPaths[i] = await generateChapterIllustration(ch.title, ebook.topic || '', category);
    // Pequena pausa entre requests para não bater rate limit
    if (i < ebook.chapters.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  const successCount = illustrationPaths.filter(Boolean).length;
  logger.info(`✅ ${successCount}/${ebook.chapters.length} ilustrações geradas`);

  const filename = `ebook_${Date.now()}.pdf`;
  const outputPath = path.join(PDFS_DIR, filename);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: ebook.title,
      Author: process.env.AUTHOR_NAME || 'GENIA Editorial',
      Subject: ebook.topic,
      Creator: 'GENIA EbookPublisher',
    }
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  let pageNum = 1;

  // Adiciona cabeçalho/rodapé automaticamente em páginas de overflow criadas pelo pdfkit
  let _autoHeaderTitle = ebook.title;
  let _manualPage = false; // flag para evitar duplicar header em addPage() manual
  doc.on('pageAdded', () => {
    if (_manualPage) return; // ignorar pages adicionadas manualmente (já têm header)
    pageNum++;
    // Adicionar cabeçalho na página de overflow
    addHeader(doc, _autoHeaderTitle, pageNum);
    doc.y = 70;
  });

  // ===========================
  // PÁGINA 1: CAPA
  // ===========================
  if (coverPath && fs.existsSync(coverPath)) {
    doc.image(coverPath, 0, 0, { width: doc.page.width, height: doc.page.height });
  } else {
    // Capa simples sem imagem
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.primary);
    doc.fontSize(28).font('Helvetica-Bold').fillColor(COLORS.white)
       .text(ebook.title, 60, 150, { width: 355, align: 'center' });
    doc.fontSize(14).fillColor('#AAAAAA')
       .text(ebook.subtitle || '', 60, 250, { width: 355, align: 'center' });
  }

  // ===========================
  // PÁGINA 2: PÁGINA DE ROSTO
  // ===========================
  _manualPage = true; doc.addPage(); _manualPage = false;
  pageNum++;
  doc.moveDown(8)
     .fontSize(22).font('Helvetica-Bold').fillColor(COLORS.primary)
     .text(ebook.title, { align: 'center' });

  if (ebook.subtitle) {
    doc.moveDown(0.5).fontSize(13).font('Helvetica').fillColor(COLORS.muted)
       .text(ebook.subtitle, { align: 'center' });
  }

  doc.moveDown(3).fontSize(11).fillColor(COLORS.muted)
     .text(process.env.AUTHOR_NAME || 'GENIA Editorial', { align: 'center' });

  doc.moveDown(1).fontSize(10).fillColor(COLORS.muted)
     .text(`Publicado em ${new Date().toLocaleDateString('pt-BR', {month: 'long', year: 'numeric'})}`, { align: 'center' });

  // Linha decorativa
  doc.moveTo(100, doc.y + 30).lineTo(355, doc.y + 30).strokeColor(COLORS.accent).lineWidth(2).stroke();

  doc.moveDown(5).fontSize(10).fillColor(COLORS.muted)
     .text('© Todos os direitos reservados. Proibida a reprodução parcial ou total sem autorização.', { align: 'center' });

  // ===========================
  // PÁGINA 3: SUMÁRIO
  // ===========================
  _manualPage = true; doc.addPage(); _manualPage = false;
  pageNum++;
  addHeader(doc, ebook.title, pageNum);

  doc.y = 70;
  doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.primary).text('Sumário');
  doc.moveDown(1);

  doc.fontSize(11).fillColor(COLORS.muted).text('Introdução', { continued: true });
  doc.fillColor(COLORS.accent).text(' .................................................. 4', { align: 'right' });

  let tocPage = 5;
  ebook.chapters.forEach((ch, i) => {
    doc.moveDown(0.4);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(11)
       .text(`${i+1}. ${ch.title}`, { continued: true });
    doc.fillColor(COLORS.muted).font('Helvetica')
       .text(` ${'.' .repeat(40)} ${tocPage}`, { align: 'right' });
    tocPage += 3;
  });

  doc.moveDown(0.4);
  doc.fillColor(COLORS.muted).text('Conclusão', { continued: true });
  doc.text(` ${'.' .repeat(44)} ${tocPage}`, { align: 'right' });

  addFooter(doc);

  // ===========================
  // INTRODUÇÃO
  // ===========================
  _manualPage = true; doc.addPage(); _manualPage = false;
  pageNum++;
  addHeader(doc, ebook.title, pageNum);

  doc.y = 70;
  doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.primary).text('Introdução');
  doc.moveDown(0.5);
  doc.moveTo(60, doc.y).lineTo(180, doc.y).strokeColor(COLORS.accent).lineWidth(3).stroke();
  doc.moveDown(0.8);

  formatChapterContent(doc, ebook.introduction || '', 'Introdução');
  addFooter(doc);

  // ===========================
  // CAPÍTULOS
  // ===========================
  for (let i = 0; i < ebook.chapters.length; i++) {
    const chapter = ebook.chapters[i];
    _manualPage = true; doc.addPage(); _manualPage = false;
    pageNum++;
    addHeader(doc, ebook.title, pageNum);

    doc.y = 70;

    // Ilustração do capítulo (se disponível)
    const illustPath = illustrationPaths[i];
    if (illustPath && fs.existsSync(illustPath)) {
      const contentW = doc.page.width - 120; // margem esquerda + direita
      const illW = contentW;
      const illH = Math.round(contentW * 9 / 20); // ratio 20:9 mais compacto = mais espaço para texto
      doc.image(illustPath, 60, doc.y, { width: illW, height: illH });
      doc.y += illH + 14;
      // Limpar arquivo temporário
      try { fs.unlinkSync(illustPath); } catch (_) {}
    }

    // Número do capítulo (fundo colorido)
    const chapterBoxY = doc.y;
    doc.rect(60, chapterBoxY, 50, 50).fill(COLORS.accent);
    // Número centralizado verticalmente na caixa
    doc.fillColor(COLORS.white).fontSize(22).font('Helvetica-Bold')
       .text(`${i+1}`, 60, chapterBoxY + 14, { width: 50, align: 'center' });

    // Título ao lado da caixa
    const contentWidth = doc.page.width - 180; // 120 margem + 60 caixa
    doc.fillColor(COLORS.primary).fontSize(16).font('Helvetica-Bold')
       .text(chapter.title, 120, chapterBoxY + 12, { width: contentWidth });

    doc.y = chapterBoxY + 60;
    doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).strokeColor('#EEEEEE').lineWidth(1).stroke();
    doc.moveDown(0.8);

    formatChapterContent(doc, chapter.content || '', chapter.title);
    addFooter(doc);
  }

  // ===========================
  // CONCLUSÃO
  // ===========================
  _manualPage = true; doc.addPage(); _manualPage = false;
  pageNum++;
  addHeader(doc, ebook.title, pageNum);

  doc.y = 70;
  doc.fontSize(20).font('Helvetica-Bold').fillColor(COLORS.primary).text('Conclusão');
  doc.moveDown(0.5);
  doc.moveTo(60, doc.y).lineTo(180, doc.y).strokeColor(COLORS.accent).lineWidth(3).stroke();
  doc.moveDown(0.8);

  formatChapterContent(doc, ebook.conclusion || '', 'Conclusão');

  // CTA Final
  doc.moveDown(2);
  const ctaX = 60, ctaW = doc.page.width - 120, ctaInner = ctaW - 40;
  const ctaY = doc.y;
  doc.rect(ctaX, ctaY, ctaW, 130).fill('#FFF0F3');
  doc.fillColor(COLORS.accent).fontSize(14).font('Helvetica-Bold')
     .text('Gostou deste e-book?', ctaX + 20, ctaY + 18, { width: ctaInner });
  doc.fillColor(COLORS.text).fontSize(11).font('Helvetica')
     .text('Compartilhe com amigos que precisam desta informação. Sua indicação faz diferença!', ctaX + 20, ctaY + 48, { width: ctaInner });
  doc.fillColor(COLORS.muted).fontSize(10)
     .text('Encontre mais e-books em: veloxisit.com.br', ctaX + 20, ctaY + 92, { width: ctaInner });
  doc.y = ctaY + 140;

  addFooter(doc);

  // ===========================
  // FINALIZAR
  // ===========================
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const size = fs.statSync(outputPath).size;
  logger.info(`✅ PDF gerado: ${filename} (${Math.round(size/1024)}KB, ${pageNum} páginas)`);

  // QA do PDF gerado
  const pdfQA = await validatePDF(outputPath, { expectedChapters: ebook.chapters.length });
  if (!pdfQA.ok) {
    logger.error(`❌ QA PDF REPROVADO:\n   ${pdfQA.issues.join('\n   ')}`);
    throw new Error(`PDF falhou no QA: ${pdfQA.issues.join('; ')}`);
  }

  return outputPath;
}

module.exports = { generatePDF };
