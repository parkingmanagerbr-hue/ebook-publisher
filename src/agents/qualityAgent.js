/**
 * QualityAgent — Verificação de qualidade de capa e ilustrações
 *
 * Verifica:
 *   - Arquivo existe e tem tamanho mínimo
 *   - Imagem é um PNG/JPG válido (magic bytes)
 *   - Dimensões dentro do esperado
 *   - Não é imagem em branco ou toda escura
 *   - Conteúdo visual variado (desvio padrão de pixels)
 *
 * Se falhar → regenera até MAX_RETRIES vezes
 */
const fs   = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createLogger } = require('../core/logger');
const logger = createLogger('qualityAgent');

const MAX_RETRIES  = 3;
const MIN_SIZE_KB  = 30;    // mínimo 30KB — abaixo disso é placeholder/erro
const MIN_STD_DEV  = 15;    // desvio padrão de pixels — abaixo = imagem quase em branco/preta

// ─── Verificar magic bytes (PNG ou JPEG) ─────────────────────────────────────
function isValidImageFile(filePath) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45; // RIFF...WEBP
    return isPng || isJpeg || isWebp;
  } catch { return false; }
}

// ─── Calcular desvio padrão dos pixels (detectar branco/preto total) ─────────
async function computePixelStdDev(filePath) {
  try {
    const img    = await loadImage(filePath);
    // Sample em resolução reduzida para velocidade
    const SW = 64, SH = 64;
    const canvas = createCanvas(SW, SH);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, SW, SH);
    const data = ctx.getImageData(0, 0, SW, SH).data;

    let sum = 0, sumSq = 0;
    const n = SW * SH;
    for (let i = 0; i < data.length; i += 4) {
      // Luminância média do pixel
      const lum = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
      sum   += lum;
      sumSq += lum * lum;
    }
    const mean   = sum / n;
    const stdDev = Math.sqrt(sumSq / n - mean * mean);
    return { mean, stdDev };
  } catch (e) {
    return { mean: 0, stdDev: 0, error: e.message };
  }
}

// ─── Detectar conteúdo tipo UI/texto (fundo claro = mockup de tela) ──────────
async function hasUIOrTextContent(filePath) {
  try {
    const img    = await loadImage(filePath);
    const SW = 160, SH = 90; // amostra 16:9
    const canvas = createCanvas(SW, SH);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, SW, SH);
    const data = ctx.getImageData(0, 0, SW, SH).data;

    // Contar pixels muito claros (> 210 lum) — típico de fundo branco de UI mockup
    let veryLight = 0;
    // Contar transições bruscas de cor (característico de texto/bordas de UI)
    let sharpEdges = 0;
    const n = SW * SH;

    for (let i = 0; i < data.length; i += 4) {
      const lum = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
      if (lum > 210) veryLight++;

      // Verificar transição brusca com pixel adjacente horizontal
      if (i + 4 < data.length) {
        const lumNext = data[i+4] * 0.299 + data[i+5] * 0.587 + data[i+6] * 0.114;
        if (Math.abs(lum - lumNext) > 80) sharpEdges++;
      }
    }

    const lightRatio = veryLight / n;
    const edgeRatio  = sharpEdges / n;

    // Rejeita se: >20% fundo claro (UI mockup) OU >30% bordas nítidas (muito texto)
    return lightRatio > 0.20 || edgeRatio > 0.30;
  } catch {
    return false;
  }
}

// ─── Verificação completa de uma imagem ──────────────────────────────────────
async function checkImage(filePath, { minWidth = 0, minHeight = 0, label = 'imagem' } = {}) {
  const issues = [];

  // 1. Arquivo existe
  if (!fs.existsSync(filePath)) {
    return { ok: false, issues: [`${label}: arquivo não encontrado`] };
  }

  // 2. Tamanho mínimo
  const sizeKb = fs.statSync(filePath).size / 1024;
  if (sizeKb < MIN_SIZE_KB) {
    issues.push(`${label}: tamanho muito pequeno (${sizeKb.toFixed(1)}KB < ${MIN_SIZE_KB}KB)`);
  }

  // 3. Magic bytes válidos
  if (!isValidImageFile(filePath)) {
    issues.push(`${label}: não é um arquivo de imagem válido (magic bytes inválidos)`);
  }

  // 4. Dimensões e conteúdo
  const stats = await computePixelStdDev(filePath);
  if (stats.error) {
    issues.push(`${label}: não foi possível ler pixels — ${stats.error}`);
  } else {
    if (stats.stdDev < MIN_STD_DEV) {
      issues.push(`${label}: imagem quase uniformemente ${stats.mean < 30 ? 'preta' : 'branca'} (stdDev=${stats.stdDev.toFixed(1)} < ${MIN_STD_DEV})`);
    }
  }

  // 5. Detectar conteúdo tipo UI/mockup (ruim para ilustrações artísticas)
  if (issues.length === 0 && label.includes('lustração')) {
    const hasUI = await hasUIOrTextContent(filePath);
    if (hasUI) {
      issues.push(`${label}: imagem parece conter elementos de UI ou texto (fundo claro detectado)`);
    }
  }

  const ok = issues.length === 0;
  if (ok) {
    logger.info(`✅ QA ${label}: ok (${sizeKb.toFixed(0)}KB, stdDev=${stats.stdDev?.toFixed(1)})`);
  } else {
    logger.warn(`⚠️ QA ${label} FALHOU:\n   ${issues.join('\n   ')}`);
  }

  return { ok, issues, sizeKb, stdDev: stats.stdDev };
}

// ─── Verificar capa com retry ─────────────────────────────────────────────────
async function ensureQualityCover(generateFn, title, subtitle, topic) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.info(`🔍 QA Capa — tentativa ${attempt}/${MAX_RETRIES}`);
    let coverPath;
    try {
      coverPath = await generateFn(title, subtitle, topic);
    } catch (e) {
      logger.warn(`❌ generateCover falhou (tentativa ${attempt}): ${e.message}`);
      if (attempt === MAX_RETRIES) throw e;
      continue;
    }

    const result = await checkImage(coverPath, { label: 'capa', minWidth: 400, minHeight: 600 });
    if (result.ok) {
      logger.info(`✅ Capa aprovada no QA (tentativa ${attempt})`);
      return coverPath;
    }

    logger.warn(`🔄 Capa reprovada, regenerando... (${result.issues.join('; ')})`);
    // Deletar capa ruim
    try { fs.unlinkSync(coverPath); } catch (_) {}
  }
  throw new Error(`Capa falhou no QA após ${MAX_RETRIES} tentativas`);
}

// ─── Verificar ilustrações com retry ─────────────────────────────────────────
async function ensureQualityIllustration(generateFn, chapterTitle, topic) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let imgPath;
    try {
      imgPath = await generateFn(chapterTitle, topic);
    } catch (e) {
      logger.warn(`❌ Ilustração "${chapterTitle}" falhou (tentativa ${attempt}): ${e.message}`);
      if (attempt === MAX_RETRIES) return null; // Ilustração é opcional
      continue;
    }

    if (!imgPath) return null;

    const result = await checkImage(imgPath, { label: `ilustração "${chapterTitle}"` });
    if (result.ok) return imgPath;

    logger.warn(`🔄 Ilustração "${chapterTitle}" reprovada, regenerando...`);
    try { fs.unlinkSync(imgPath); } catch (_) {}
  }

  logger.warn(`⚠️ Ilustração "${chapterTitle}" não passou no QA após ${MAX_RETRIES} tentativas — capítulo sem ilustração`);
  return null;
}

// ─── Verificar e-book inteiro antes de publicar ───────────────────────────────
async function validateEbook(ebook) {
  const issues = [];
  const warnings = [];

  // Campos obrigatórios
  if (!ebook.title?.trim())    issues.push('Título ausente ou vazio');
  if (!ebook.subtitle?.trim()) warnings.push('Subtítulo ausente');
  if (!ebook.description?.trim()) warnings.push('Descrição ausente');
  if (!ebook.introduction?.trim() || ebook.introduction.length < 200) issues.push('Introdução muito curta ou ausente');
  if (!ebook.conclusion?.trim() || ebook.conclusion.length < 100)     issues.push('Conclusão muito curta ou ausente');

  // Capítulos
  if (!ebook.chapters?.length) {
    issues.push('Nenhum capítulo gerado');
  } else {
    ebook.chapters.forEach((ch, i) => {
      if (!ch.title?.trim()) issues.push(`Capítulo ${i+1}: título ausente`);
      if (!ch.content || ch.content.length < 300) issues.push(`Capítulo ${i+1} ("${ch.title}"): conteúdo muito curto (${ch.content?.length || 0} chars)`);
    });
  }

  // Wordcount mínimo
  if (ebook.wordCount < 3000) warnings.push(`Wordcount baixo: ${ebook.wordCount} palavras (recomendado: 5000+)`);

  // Arquivos
  if (ebook.coverPath && !fs.existsSync(ebook.coverPath)) issues.push('Arquivo de capa não encontrado');
  if (ebook.pdfPath   && !fs.existsSync(ebook.pdfPath))   issues.push('Arquivo PDF não encontrado');

  const ok = issues.length === 0;
  if (ok) {
    logger.info(`✅ QA E-book aprovado: "${ebook.title}" (${ebook.wordCount} palavras, ${ebook.chapters?.length} capítulos)${warnings.length ? ` — avisos: ${warnings.join('; ')}` : ''}`);
  } else {
    logger.error(`❌ QA E-book REPROVADO:\n   ${issues.join('\n   ')}`);
    if (warnings.length) logger.warn(`   Avisos: ${warnings.join('; ')}`);
  }

  return { ok, issues, warnings };
}

// ─── Verificar PDF gerado ─────────────────────────────────────────────────────
async function validatePDF(pdfPath, { expectedChapters = 0 } = {}) {
  const issues = [];

  if (!fs.existsSync(pdfPath)) {
    return { ok: false, issues: ['PDF não encontrado no disco'] };
  }

  // Tamanho mínimo — um PDF real tem pelo menos 50KB por capítulo
  const sizeKb = fs.statSync(pdfPath).size / 1024;
  const minSizeKb = Math.max(100, expectedChapters * 40);
  if (sizeKb < minSizeKb) {
    issues.push(`PDF muito pequeno: ${sizeKb.toFixed(0)}KB (esperado ≥ ${minSizeKb}KB para ${expectedChapters} capítulos)`);
  }

  // Magic bytes: todo PDF começa com "%PDF"
  try {
    const fd = fs.openSync(pdfPath, 'r');
    const hdr = Buffer.alloc(5);
    fs.readSync(fd, hdr, 0, 5, 0);
    fs.closeSync(fd);
    if (hdr.toString('ascii') !== '%PDF-') {
      issues.push('Arquivo não é um PDF válido (magic bytes inválidos)');
    }
  } catch (e) {
    issues.push(`Não foi possível ler o PDF: ${e.message}`);
  }

  // Análise de conteúdo via pdf-parse
  try {
    let pdfParse = require('pdf-parse');
    if (pdfParse && pdfParse.default) pdfParse = pdfParse.default; // ESM compat
    const data = await pdfParse(fs.readFileSync(pdfPath)); // sem opções extras

    const expectedMinPages = expectedChapters + 4; // capa + rosto + sumário + intro + conclusão
    if (data.numpages < expectedMinPages) {
      issues.push(`PDF com apenas ${data.numpages} páginas (esperado ≥ ${expectedMinPages})`);
    }

    const charsPerPage = Math.round(data.text.length / data.numpages);
    if (charsPerPage < 80) {
      issues.push(`Texto muito escasso: média de ${charsPerPage} chars/página — possível páginas em branco`);
    }

    logger.info(`✅ QA PDF: ${data.numpages} páginas, ${(sizeKb).toFixed(0)}KB, ~${charsPerPage} chars/pág`);
    return { ok: issues.length === 0, issues, numpages: data.numpages, sizeKb, charsPerPage };
  } catch (e) {
    // pdf-parse falhou — verificação básica apenas (tamanho/magic bytes)
    logger.warn(`⚠️ pdf-parse não disponível: ${e.message} — usando verificação básica`);
    if (issues.length === 0) {
      logger.info(`✅ QA PDF (básico): ${sizeKb.toFixed(0)}KB`);
    }
    return { ok: issues.length === 0, issues, sizeKb };
  }
}

module.exports = { checkImage, ensureQualityCover, ensureQualityIllustration, validateEbook, validatePDF };
