/**
 * claudeDesignAgent.js — Geração de designs via Claude (Anthropic API)
 *
 * Claude gera HTML/CSS/SVG criativo que é renderizado em PNG via Puppeteer.
 * Produce designs de nível profissional para:
 *  - Capas de e-books (1400×2100 portrait)
 *  - Thumbnails YouTube (1280×720 landscape)
 *  - Posts Instagram (1080×1080 square)
 *  - Ilustrações de capítulos (1200×400 landscape)
 *  - Posts para redes sociais
 *
 * Requer: ANTHROPIC_API_KEY no .env
 */
const axios     = require('axios');
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const { createLogger } = require('../core/logger');

const logger = createLogger('claudeDesignAgent');

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = process.env.CLAUDE_DESIGN_MODEL || 'claude-3-5-sonnet-20241022';

// ──────────────────────────────────────────────────────────────────────────────
// Prompts por tipo de design
// ──────────────────────────────────────────────────────────────────────────────

const DESIGN_PROMPTS = {

  ebookCover: ({ title, subtitle, topic, author }) => `
Você é um designer gráfico expert em capas de e-books brasileiros para o mercado digital (Hotmart, Cakto, KDP).

Crie um HTML/CSS completo para uma CAPA DE E-BOOK com estas especificações:
- Dimensões: exatamente 1400px largura × 2100px altura
- Tema / Tópico: "${topic}"
- Título: "${title}"
- Subtítulo: "${subtitle || ''}"
- Autor: "${author || 'GENIA Editorial'}"

REGRAS OBRIGATÓRIAS:
1. O HTML deve ser auto-contido (sem imports externos — use Google Fonts via @import ou fonts-only URL, ou use fontes seguras do sistema)
2. Gradientes, sombras e efeitos modernos são bem-vindos
3. Paleta profissional e adequada ao tema
4. Título em destaque máximo, legível, impactante
5. Elemento visual abstrato/geométrico como background (sem imagens externas)
6. Sensação premium — deve parecer produzido por designer profissional
7. Sem placeholder text ou lorem ipsum
8. O <body> deve ter margin:0, overflow:hidden, e os elementos devem preencher exatamente 1400×2100px

Responda APENAS com o HTML completo (de <!DOCTYPE html> até </html>), sem explicações.
`,

  youtubeThumbnail: ({ title, topic, style }) => `
Você é um designer especializado em thumbnails virais do YouTube brasileiro.

Crie um HTML/CSS para um THUMBNAIL DO YOUTUBE com:
- Dimensões: 1280px × 720px
- Título do vídeo: "${title}"
- Tópico/nicho: "${topic}"
- Estilo: "${style || 'informativo e profissional'}"

REGRAS:
1. Alto contraste — legível mesmo em tamanho pequeno
2. Texto grande e impactante no estilo thumbnails virais (CAPS, cores vibrantes)
3. Background com gradiente forte ou padrão geométrico impactante
4. Efeitos de glow, sombra e bordas que chamem atenção
5. Paleta: máximo 3 cores principais bem contrastantes
6. Sem imagens externas — apenas CSS, SVG inline e gradientes
7. Body: margin:0, overflow:hidden, 1280×720px exatos

Responda APENAS com o HTML completo, sem explicações.
`,

  instagramPost: ({ caption, topic, style }) => `
Você é um designer especializado em posts de Instagram para criadores de conteúdo brasileiros.

Crie um HTML/CSS para um POST DO INSTAGRAM com:
- Dimensões: 1080px × 1080px (quadrado perfeito)
- Texto principal: "${caption}"
- Tema: "${topic}"
- Estilo visual: "${style || 'moderno e clean'}"

REGRAS:
1. Design moderno, limpo e visualmente impactante
2. Tipografia grande e legível
3. Background criativo (gradiente, padrões geométricos, ondas CSS)
4. Hierarquia visual clara
5. Sem imagens externas, apenas CSS puro + SVG inline
6. Body: margin:0, overflow:hidden, 1080×1080px exatos

Responda APENAS com o HTML completo, sem explicações.
`,

  chapterIllustration: ({ chapterTitle, topic }) => `
Você é um designer especializado em ilustrações editoriais minimalistas.

Crie um HTML/CSS para uma ILUSTRAÇÃO DE CAPÍTULO com:
- Dimensões: 1200px × 400px (landscape banner)
- Título do capítulo: "${chapterTitle}"
- Tema do e-book: "${topic}"

REGRAS:
1. Design abstrato e conceitual — representa o tema visualmente
2. Paleta sofisticada (no máximo 4 cores harmônicas)
3. Elementos geométricos e formas abstratas em SVG inline
4. Título do capítulo integrado ao design (tipografia elegante)
5. Estilo: editorial/premium (impressão de alta qualidade)
6. Sem imagens externas
7. Body: margin:0, overflow:hidden, 1200×400px exatos

Responda APENAS com o HTML completo, sem explicações.
`,

  socialMediaPost: ({ text, platform, topic }) => `
Crie um HTML/CSS para um POST PARA ${(platform || 'redes sociais').toUpperCase()} com:
- Dimensões: ${platform === 'story' ? '1080px × 1920px' : '1080px × 1080px'}
- Texto: "${text}"
- Tema: "${topic}"

Design moderno, vibrante e profissional. Sem imagens externas. Body margin:0, overflow:hidden.

Responda APENAS com o HTML completo, sem explicações.
`,
};

// ──────────────────────────────────────────────────────────────────────────────
// Core: chamar Claude API
// ──────────────────────────────────────────────────────────────────────────────

async function callClaudeForDesign(prompt, maxTokens = 4096) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');

  const response = await axios.post(ANTHROPIC_API, {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 60_000,
  });

  const text = response.data.content?.[0]?.text || '';
  // Extrair bloco HTML da resposta
  const htmlMatch = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i)
    || text.match(/<html[\s\S]*<\/html>/i);
  if (!htmlMatch) throw new Error('Claude não retornou HTML válido');
  return htmlMatch[0];
}

// ──────────────────────────────────────────────────────────────────────────────
// Core: renderizar HTML → PNG via Puppeteer
// ──────────────────────────────────────────────────────────────────────────────

async function renderHtmlToPng(html, outputPath, width, height) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    // Aguardar fontes e animações
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 800));

    await page.screenshot({ path: outputPath, type: 'png', clip: { x: 0, y: 0, width, height } });
    return outputPath;
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Funções públicas
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Gera capa de e-book usando Claude Design
 * @returns {string} caminho para o PNG gerado
 */
async function generateEbookCover({ title, subtitle, topic, author, outputDir }) {
  logger.info(`Claude Design — capa de e-book: "${title}"`);
  const prompt = DESIGN_PROMPTS.ebookCover({ title, subtitle, topic, author });

  const html = await callClaudeForDesign(prompt, 6000);
  const outputPath = path.join(outputDir, `cover_claude_${Date.now()}.png`);
  fs.mkdirSync(outputDir, { recursive: true });

  await renderHtmlToPng(html, outputPath, 1400, 2100);
  logger.info(`Capa gerada: ${outputPath}`);
  return outputPath;
}

/**
 * Gera thumbnail para YouTube usando Claude Design
 */
async function generateYoutubeThumbnail({ title, topic, style, outputDir }) {
  logger.info(`Claude Design — thumbnail YouTube: "${title}"`);
  const prompt = DESIGN_PROMPTS.youtubeThumbnail({ title, topic, style });

  const html = await callClaudeForDesign(prompt, 4096);
  const outputPath = path.join(outputDir, `thumbnail_claude_${Date.now()}.png`);
  fs.mkdirSync(outputDir, { recursive: true });

  await renderHtmlToPng(html, outputPath, 1280, 720);
  logger.info(`Thumbnail gerado: ${outputPath}`);
  return outputPath;
}

/**
 * Gera post para Instagram usando Claude Design
 */
async function generateInstagramPost({ caption, topic, style, outputDir }) {
  logger.info(`Claude Design — post Instagram: "${topic}"`);
  const prompt = DESIGN_PROMPTS.instagramPost({ caption, topic, style });

  const html = await callClaudeForDesign(prompt, 4096);
  const outputPath = path.join(outputDir, `instagram_claude_${Date.now()}.png`);
  fs.mkdirSync(outputDir, { recursive: true });

  await renderHtmlToPng(html, outputPath, 1080, 1080);
  logger.info(`Post gerado: ${outputPath}`);
  return outputPath;
}

/**
 * Gera ilustração de capítulo usando Claude Design
 */
async function generateChapterIllustration({ chapterTitle, topic, outputDir }) {
  logger.info(`Claude Design — ilustração: "${chapterTitle}"`);
  const prompt = DESIGN_PROMPTS.chapterIllustration({ chapterTitle, topic });

  const html = await callClaudeForDesign(prompt, 4096);
  const outputPath = path.join(outputDir, `illustration_claude_${Date.now()}.png`);
  fs.mkdirSync(outputDir, { recursive: true });

  await renderHtmlToPng(html, outputPath, 1200, 400);
  logger.info(`Ilustração gerada: ${outputPath}`);
  return outputPath;
}

/**
 * Design genérico — passa tipo e dados, retorna PNG
 * @param {string} type - 'ebookCover' | 'youtubeThumbnail' | 'instagramPost' | 'chapterIllustration' | 'socialMediaPost'
 */
async function generateDesign(type, data, outputDir) {
  const { width, height } = {
    ebookCover:          { width: 1400, height: 2100 },
    youtubeThumbnail:    { width: 1280, height:  720 },
    instagramPost:       { width: 1080, height: 1080 },
    chapterIllustration: { width: 1200, height:  400 },
    socialMediaPost:     { width: 1080, height: 1080 },
  }[type] || { width: 1080, height: 1080 };

  const promptFn = DESIGN_PROMPTS[type];
  if (!promptFn) throw new Error(`Tipo de design desconhecido: ${type}`);

  const html = await callClaudeForDesign(promptFn(data), 6000);
  const outputPath = path.join(outputDir, `design_claude_${type}_${Date.now()}.png`);
  fs.mkdirSync(outputDir, { recursive: true });

  await renderHtmlToPng(html, outputPath, width, height);
  return outputPath;
}

/**
 * Verificar se Claude Design está disponível
 */
function isAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = {
  generateDesign,
  generateEbookCover,
  generateYoutubeThumbnail,
  generateInstagramPost,
  generateChapterIllustration,
  isAvailable,
  callClaudeForDesign,
  renderHtmlToPng,
};
