/**
 * CoverAgent — Capa profissional de e-book
 *
 * Estratégia: AI gera fundo visual (sem texto) → Canvas compõe título/subtítulo por cima.
 * Isso garante texto 100% correto independente do modelo de imagem.
 *
 * Cadeia de providers (sem Anthropic/Claude):
 *   0. Gemini Image (5 chaves, grátis) — PRIMARY
 *   1. HTML template via Puppeteer     — fallback
 *   2. imageGenAgent (Higgsfield/Pollinations/DALL-E) — fallback
 *   3. Canvas puro                     — garantido, sem AI
 */
const path = require('path');
const fs   = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { generateImage } = require('./imageGenAgent');
const { ensureQualityCover } = require('./qualityAgent');
const { createLogger }  = require('../core/logger');
const logger = createLogger('coverAgent');

// Gemini Image — Provider 0 (sem Claude, sem custo adicional)
let geminiImage = null;
try {
  geminiImage = require('./geminiImageAgent');
} catch (_) {}

// Carrega coverAgentHTML com graceful fallback se puppeteer não estiver disponível
let generateHTMLCover = null;
try {
  generateHTMLCover = require('./coverAgentHTML').generateHTMLCover;
} catch (_) {}

const COVERS_DIR = path.join(__dirname, '../../data/covers');

// ─── Paletas por categoria ───────────────────────────────────────────────────
const COLOR_THEMES = {
  financas:        { overlay: 'rgba(13,27,42,0.72)',  accent: '#FFD700', text: '#FFFFFF' },
  tecnologia:      { overlay: 'rgba(10,14,39,0.70)',  accent: '#00D4FF', text: '#FFFFFF' },
  saude:           { overlay: 'rgba(27,67,50,0.72)',  accent: '#95D5B2', text: '#FFFFFF' },
  negocios:        { overlay: 'rgba(26,26,46,0.72)',  accent: '#E94560', text: '#FFFFFF' },
  comportamento:   { overlay: 'rgba(45,27,51,0.72)',  accent: '#FFB347', text: '#FFFFFF' },
  espiritualidade: { overlay: 'rgba(26,10,46,0.72)',  accent: '#DDA0DD', text: '#FFFFFF' },
  relacionamentos: { overlay: 'rgba(26,10,26,0.72)',  accent: '#FF69B4', text: '#FFFFFF' },
  culinaria:       { overlay: 'rgba(26,10,0,0.72)',   accent: '#FF8C00', text: '#FFFFFF' },
  educacao:        { overlay: 'rgba(0,48,73,0.72)',   accent: '#48CAE4', text: '#FFFFFF' },
  familia:         { overlay: 'rgba(43,0,24,0.72)',   accent: '#FF9EBC', text: '#FFFFFF' },
  carreira:        { overlay: 'rgba(0,18,25,0.72)',   accent: '#94D2BD', text: '#FFFFFF' },
  default:         { overlay: 'rgba(26,26,46,0.72)',  accent: '#E94560', text: '#FFFFFF' },
};

// ─── Detecção de categoria ────────────────────────────────────────────────────
function detectCategory(topic) {
  const t = (topic || '').toLowerCase();
  if (t.match(/financ|dívid|invest|dinheiro|renda/))       return 'financas';
  if (t.match(/ia|intelig|tecnol|digital|program/))         return 'tecnologia';
  if (t.match(/saúde|emagrec|fitness|dieta|nutri/))         return 'saude';
  if (t.match(/negóci|empreend|marketing|vend|lucro/))      return 'negocios';
  if (t.match(/hábito|pessoal|desenvolvimento|ansied|mental/)) return 'comportamento';
  if (t.match(/espirit|cristã|fé|devoc|bíbli/))             return 'espiritualidade';
  if (t.match(/relacion|amor|comunicaç|casamento/))         return 'relacionamentos';
  if (t.match(/receita|culinár|aliment|cozinha/))           return 'culinaria';
  if (t.match(/concurso|educaç|estudo|aprend/))             return 'educacao';
  if (t.match(/maternid|filho|família|criança/))            return 'familia';
  if (t.match(/carreir|freelan|trabalh|emprego/))           return 'carreira';
  return 'default';
}

// ─── Prompt de fundo (SEM TEXTO — texto é adicionado via canvas) ─────────────
function buildBackgroundPrompt(title, topic, category) {
  const styles = {
    financas:        'dark navy blue background, golden coins and financial symbols floating, wealth visualization, luxury and success atmosphere, bokeh light effects, purely visual composition',
    tecnologia:      'dark blue and cyan digital background, circuit board patterns, glowing neon data streams, futuristic technology aesthetic, purely visual composition',
    saude:           'dark green and emerald background, healthy lifestyle symbols, clean and vibrant medical aesthetic, fresh nature elements, purely visual composition',
    negocios:        'dark background with red and coral accents, business growth charts and arrows, modern corporate aesthetic, purely visual composition',
    comportamento:   'deep purple gradient background, mindfulness symbols, brain neural patterns, zen and meditation aesthetic, purely visual composition',
    espiritualidade: 'deep purple and gold background, spiritual light rays, ethereal atmosphere, mystical ambient lighting, purely visual composition',
    relacionamentos: 'warm dark background, romantic ambient lighting, connection symbols, hearts and warmth, purely visual composition',
    culinaria:       'dark warm background, fresh ingredients and herbs, gourmet food photography style, rich textures, purely visual composition',
    educacao:        'dark blue background, open books and knowledge symbols, academic achievement aesthetic, purely visual composition',
    familia:         'warm dark background, family silhouettes, love and togetherness atmosphere, purely visual composition',
    carreira:        'dark teal background, career growth ladder, professional achievement symbols, purely visual composition',
    default:         'dramatic dark gradient background, modern abstract shapes, premium book cover aesthetic, purely visual',
  };

  return (
    `Professional e-book cover background art, portrait orientation, high quality digital art. ` +
    `${styles[category] || styles.default}. ` +
    `Dramatic cinematic lighting, premium quality, photorealistic or high-end digital illustration. ` +
    `Abstract background with no overlay elements.`
  );
}

// ─── Prompt de ilustração de capítulo ────────────────────────────────────────
function buildIllustrationPrompt(chapterTitle, topic) {
  return (
    `Abstract conceptual oil painting, wide landscape format, museum quality fine art. ` +
    `Symbolic visual metaphor for "${chapterTitle}" within the theme of "${topic}". ` +
    `Impressionist style: expressive brushstrokes, rich impasto texture, vibrant colors blending. ` +
    `Color palette: deep navy blue, golden yellow, warm amber, soft ivory highlights. ` +
    `Purely painterly composition with abstract shapes and light effects. ` +
    `Professional digital artwork suitable as a chapter header illustration.`
  );
}

// ─── Canvas: compõe texto sobre imagem de fundo ──────────────────────────────
async function compositeTextOnImage(bgBuffer, title, subtitle, topic, category) {
  const W = 1600, H = 2560;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  const theme  = COLOR_THEMES[category] || COLOR_THEMES.default;

  // 1. Fundo de segurança (caso a imagem AI não carregue)
  ctx.fillStyle = '#0D1B2A';
  ctx.fillRect(0, 0, W, H);

  // 2. Imagem de fundo gerada por AI
  try {
    const bgImg = await loadImage(bgBuffer);
    ctx.drawImage(bgImg, 0, 0, W, H);
  } catch (e) {
    logger.warn(`⚠️ Não foi possível carregar imagem de fundo: ${e.message}`);
  }

  // 3. Overlay escuro para garantir legibilidade do texto
  ctx.fillStyle = theme.overlay;
  ctx.fillRect(0, 0, W, H);

  // Gradiente extra no topo e base para contraste
  const topGrad = ctx.createLinearGradient(0, 0, 0, 400);
  topGrad.addColorStop(0, 'rgba(0,0,0,0.7)');
  topGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, 400);

  const botGrad = ctx.createLinearGradient(0, H - 500, 0, H);
  botGrad.addColorStop(0, 'rgba(0,0,0,0)');
  botGrad.addColorStop(1, 'rgba(0,0,0,0.8)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, H - 500, W, 500);

  // 4. Linha accent no topo
  const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0, 'transparent');
  accentGrad.addColorStop(0.3, theme.accent);
  accentGrad.addColorStop(0.7, theme.accent);
  accentGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, 0, W, 10);

  // 5. Badge "GENIA EDITORIAL"
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(80, 60, 360, 64, 32);
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = theme.accent;
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'left';
  ctx.letterSpacing = '3px';
  ctx.fillText('VELOXIS EDITORIAL', 108, 100);
  ctx.letterSpacing = '0px';

  // 6. Título (ocupa parte inferior da imagem)
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 30;

  const titleY = H * 0.58;
  const maxTitleW = W - 160;

  // Quebrar título em linhas
  const titleLines = breakText(ctx, title, maxTitleW, 'bold 94px sans-serif', 'bold 76px sans-serif', 'bold 62px sans-serif');
  ctx.font = titleLines.font;
  const lineH = titleLines.size + 18;

  ctx.fillStyle = '#FFFFFF';
  titleLines.lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, titleY + i * lineH);
  });

  // 7. Linha separadora accent
  const sepY = titleY + titleLines.lines.length * lineH + 24;
  ctx.shadowBlur = 0;
  ctx.fillStyle = theme.accent;
  ctx.fillRect(W / 2 - 220, sepY, 440, 5);

  // 8. Subtítulo
  const subY = sepY + 56;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 20;
  ctx.fillStyle = theme.accent;
  ctx.font = '500 46px sans-serif';
  const subLines = breakText(ctx, subtitle || '', maxTitleW - 80, '500 46px sans-serif');
  subLines.lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, subY + i * 62);
  });
  ctx.shadowBlur = 0;

  // 9. Badges de benefícios
  const badgeY = H - 460;
  const badges = ['✓ Guia Completo', '✓ Linguagem Clara', '✓ Resultados Reais'];
  ctx.font = 'bold 34px sans-serif';
  const bSpacing = W / (badges.length + 1);
  badges.forEach((badge, i) => {
    const bx = bSpacing * (i + 1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.roundRect(bx - 165, badgeY - 44, 330, 68, 34);
    ctx.fill();
    ctx.strokeStyle = theme.accent + 'AA';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(badge, bx, badgeY);
  });

  // 10. Autor (sem preço)
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '36px sans-serif';
  ctx.fillText(process.env.AUTHOR_NAME || 'Veloxis Editorial', W / 2, H - 260);

  // 12. Linha accent no rodapé
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, H - 10, W, 10);

  return canvas.toBuffer('image/png');
}

// ─── Canvas puro (sem AI) para fallback total ─────────────────────────────────
function generatePureCanvas(title, subtitle, topic) {
  const cat   = detectCategory(topic);
  const theme = COLOR_THEMES[cat] || COLOR_THEMES.default;
  const W = 1600, H = 2560;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background gradient sólido
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#0D1B2A');
  bgGrad.addColorStop(1, '#1B4332');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Padrão geométrico
  ctx.globalAlpha = 0.07;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(W * 0.85, H * 0.3 + i * 120, 300 - i * 25, 0, Math.PI * 2);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Reusar compositeTextOnImage sem bg image (passa buffer vazio)
  return compositeTextOnImage(null, title, subtitle, topic, cat);
}

// ─── Quebra de texto em linhas com ajuste de tamanho ─────────────────────────
function breakText(ctx, text, maxWidth, ...fonts) {
  if (!text) return { lines: [], font: fonts[0], size: 46 };
  for (const font of fonts) {
    ctx.font = font;
    const sizeMatch = font.match(/(\d+)px/);
    const size = sizeMatch ? parseInt(sizeMatch[1]) : 46;
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    if (lines.length <= 4) return { lines, font, size };
  }
  // Último font disponível com truncagem
  const font = fonts[fonts.length - 1];
  ctx.font = font;
  const sizeMatch = font.match(/(\d+)px/);
  const size = sizeMatch ? parseInt(sizeMatch[1]) : 46;
  return { lines: text.split(' ').slice(0, 8).join(' ').split(/(.{30})/g).filter(Boolean).slice(0, 4), font, size };
}

// ─── Geração interna de uma tentativa de capa ────────────────────────────────
async function _generateCoverOnce(title, subtitle, topic) {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const cat = detectCategory(topic);

  // ── Provider 0: HTML/CSS viral via Puppeteer (PRIMÁRIO — melhor qualidade) ──
  // Usa Gemini Text para gerar HTML com design viral, renderizado pelo browser
  // Resultado: tipografia profissional, Google Fonts, layouts criativos por categoria
  if (generateHTMLCover) {
    try {
      logger.info('🎨 Provider 0: Capa HTML viral (Gemini Text → Puppeteer)...');
      const htmlPath = await generateHTMLCover(title, subtitle, topic, cat);
      if (htmlPath && fs.existsSync(htmlPath)) {
        logger.info(`✅ Capa HTML viral gerada: ${path.basename(htmlPath)}`);
        return htmlPath;
      }
    } catch (e) {
      logger.warn(`⚠️ Capa HTML viral falhou: ${e.message} — tentando Gemini Image`);
    }
  }

  // ── Provider 1: Gemini Image — fundo AI + Canvas sobrepõe texto ──
  if (geminiImage?.isAvailable()) {
    try {
      logger.info('🌟 Provider 1: Gemini Image — gerando fundo para capa...');
      const bgPrompt = buildBackgroundPrompt(title, topic, cat);
      const tmpPath  = path.join(COVERS_DIR, `gemini_bg_${Date.now()}.tmp.png`);
      await geminiImage.generateImage(bgPrompt, tmpPath);
      const bgBuffer = fs.readFileSync(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      const filename = `cover_${Date.now()}.png`;
      const outPath  = path.join(COVERS_DIR, filename);
      const finalBuf = await compositeTextOnImage(bgBuffer, title, subtitle, topic, cat);
      fs.writeFileSync(outPath, finalBuf);
      logger.info(`✅ Capa Gemini Image gerada: ${filename} (${Math.round(finalBuf.length/1024)}KB)`);
      return outPath;
    } catch (e) {
      logger.warn(`⚠️ Gemini Image falhou: ${e.message} — tentando imageGenAgent`);
    }
  }

  // ── Provider 2+: imageGenAgent (Higgsfield/Pollinations/DALL-E) + canvas text overlay ──
  const filename = `cover_${Date.now()}.png`;
  const outPath  = path.join(COVERS_DIR, filename);
  const bgPrompt = buildBackgroundPrompt(title, topic, cat);

  let bgBuffer   = null;
  let bgProvider = 'canvas';

  try {
    const tmpPath = outPath + '.bg.tmp';
    const result  = await generateImage({ prompt: bgPrompt, width: 1024, height: 1792, outputPath: tmpPath });
    bgBuffer   = fs.readFileSync(tmpPath);
    bgProvider = result.provider;
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  } catch (e) {
    logger.warn(`⚠️ Fundo AI falhou: ${e.message} — usando canvas puro`);
  }

  const finalBuffer = await compositeTextOnImage(bgBuffer, title, subtitle, topic, cat);
  fs.writeFileSync(outPath, finalBuffer);
  logger.info(`🖼️  Capa gerada (fundo: ${bgProvider}): ${filename} (${Math.round(finalBuffer.length / 1024)}KB)`);
  return outPath;
}

// ─── FUNÇÃO PRINCIPAL com QA automático ──────────────────────────────────────
async function generateCover(title, subtitle, topic, category = null) {
  logger.info(`🎨 Gerando capa com QA: "${title}"`);
  return ensureQualityCover(_generateCoverOnce, title, subtitle, topic);
}

// ─── ILUSTRAÇÃO DE CAPÍTULO via Gemini Image ─────────────────────────────────
async function generateChapterIllustration(chapterTitle, topic, outputDir) {
  const prompt  = buildIllustrationPrompt(chapterTitle, topic);
  const outPath = path.join(outputDir, `illustration_${Date.now()}.png`);

  // Provider 0: Gemini Image
  if (geminiImage?.isAvailable()) {
    try {
      await geminiImage.generateImage(prompt, outPath);
      logger.info(`✅ Ilustração Gemini Image: ${path.basename(outPath)}`);
      return outPath;
    } catch (e) {
      logger.warn(`⚠️ Gemini Image ilustração falhou: ${e.message} — usando imageGenAgent`);
    }
  }

  // Fallback: imageGenAgent (HuggingFace / Canvas)
  const { generateImage } = require('./imageGenAgent');
  await generateImage({ prompt, width: 1200, height: 400, outputPath: outPath });
  return outPath;
}

module.exports = {
  generateCover,
  generateChapterIllustration,
  detectCategory,
  buildCoverPrompt: buildBackgroundPrompt,
  buildIllustrationPrompt,
};
