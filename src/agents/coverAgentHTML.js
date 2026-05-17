/**
 * coverAgentHTML — Capa profissional via HTML/CSS + Puppeteer
 *
 * Fluxo:
 *   1. AI (Gemini/Groq/etc.) gera HTML completo com design de capa
 *   2. Puppeteer renderiza o HTML em 1600×2560px
 *   3. Screenshot PNG salvo como capa final
 *
 * Vantagens:
 *   - Texto 100% correto (renderizado pelo browser, não por difusão)
 *   - Design profissional via CSS/SVG/gradientes
 *   - Gratuito (usa modelos de texto já disponíveis)
 *   - Rápido (~3-5s total)
 */
const fs   = require('fs');
const path = require('path');
const { generate: generateText } = require('../core/aiClient');
const { createLogger } = require('../core/logger');
const logger = createLogger('coverAgentHTML');

const COVERS_DIR = path.join(__dirname, '../../data/covers');

// ─── Paletas por categoria ────────────────────────────────────────────────────
const THEMES = {
  financas:        { bg1: '#0D1B2A', bg2: '#1B3A5C', accent: '#FFD700', badge: 'rgba(255,215,0,0.15)' },
  tecnologia:      { bg1: '#070B1A', bg2: '#0A1628', accent: '#00D4FF', badge: 'rgba(0,212,255,0.12)' },
  saude:           { bg1: '#052E1C', bg2: '#0A4A2E', accent: '#00E676', badge: 'rgba(0,230,118,0.12)' },
  negocios:        { bg1: '#1A0A0A', bg2: '#2D1515', accent: '#FF5252', badge: 'rgba(255,82,82,0.12)' },
  comportamento:   { bg1: '#1A0A2E', bg2: '#2D1045', accent: '#CE93D8', badge: 'rgba(206,147,216,0.12)' },
  espiritualidade: { bg1: '#12001E', bg2: '#1E0030', accent: '#E040FB', badge: 'rgba(224,64,251,0.12)' },
  relacionamentos: { bg1: '#1A0010', bg2: '#2D0018', accent: '#FF4081', badge: 'rgba(255,64,129,0.12)' },
  culinaria:       { bg1: '#1A0A00', bg2: '#2D1800', accent: '#FFA726', badge: 'rgba(255,167,38,0.12)' },
  educacao:        { bg1: '#001830', bg2: '#002845', accent: '#40C4FF', badge: 'rgba(64,196,255,0.12)' },
  familia:         { bg1: '#1A0015', bg2: '#2D0025', accent: '#F48FB1', badge: 'rgba(244,143,177,0.12)' },
  carreira:        { bg1: '#001520', bg2: '#002030', accent: '#80CBC4', badge: 'rgba(128,203,196,0.12)' },
  default:         { bg1: '#0D1117', bg2: '#1A1A2E', accent: '#E94560', badge: 'rgba(233,69,96,0.12)'  },
};

// ─── Prompt para o LLM gerar o HTML da capa ──────────────────────────────────
function buildHTMLPrompt(title, subtitle, topic, category) {
  const theme = THEMES[category] || THEMES.default;
  return `You are a professional book cover designer. Create a stunning HTML ebook cover page.

REQUIREMENTS:
- Canvas: exactly 1600x2560px (portrait)
- Background: dark gradient from ${theme.bg1} to ${theme.bg2}, plus 2-3 decorative geometric shapes (circles, lines, diagonal strips) in accent color ${theme.accent} with 8-15% opacity
- Top badge "VELOXIS EDITORIAL" in accent color ${theme.accent} with small capsule border
- Large centered title: "${title}" — use white text, bold, 90-110px, wrapped if needed (max 3 lines)
- Accent horizontal separator bar (color ${theme.accent}, 400px wide, 5px tall)
- Subtitle: "${subtitle || ''}" — accent color ${theme.accent}, 48px, italic, below separator
- 3 benefit badges at bottom: "✓ Guia Completo", "✓ Linguagem Clara", "✓ Resultados Reais" — small capsule style with ${theme.badge} background and ${theme.accent} border
- Author line "Veloxis Editorial" in light gray at very bottom
- Accent gradient stripe (3px) at very top and very bottom of page

CRITICAL RULES:
- Output ONLY raw HTML starting with <!DOCTYPE html> — NO markdown, NO explanation, NO code blocks
- Use only CSS (no JS, no external fonts needed — use system fonts: 'Georgia', serif for title, sans-serif for rest)
- Everything must be position:absolute or position:fixed within a 1600x2560 container
- The design must look like a premium ebook/book cover, dark and elegant

Topic context: "${topic}"`;
}

// ─── Gerar HTML da capa via AI ────────────────────────────────────────────────
async function generateCoverHTML(title, subtitle, topic, category) {
  const prompt = buildHTMLPrompt(title, subtitle, topic, category);
  logger.info('🤖 Gerando HTML da capa via AI...');
  const result = await generateText(prompt, '', { maxTokens: 4000 });
  // generate() retorna { text, provider, elapsed } — extrair o texto
  // Usar String() para garantir que sempre seja string independente do tipo retornado
  const raw = typeof result === 'string' ? result : (result?.text ?? '');
  const html = typeof raw === 'string' ? raw : String(raw || '');

  // Limpar possíveis blocos markdown
  return html
    .replace(/^```html\n?/i, '')
    .replace(/^```\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

// ─── Renderizar HTML com Puppeteer → PNG ──────────────────────────────────────
async function renderHTMLtoPNG(html, outputPath) {
  const puppeteer = require('puppeteer');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 2560, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    // Aguardar renderização completa
    await new Promise(r => setTimeout(r, 500));

    const buf = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 1600, height: 2560 },
      fullPage: false,
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buf);
    return buf;
  } finally {
    await browser.close();
  }
}

// ─── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────
async function generateHTMLCover(title, subtitle, topic, category) {
  logger.info(`🎨 coverAgentHTML: Gerando capa HTML para "${title}"`);
  const t0 = Date.now();

  const filename = `cover_html_${Date.now()}.png`;
  const outPath  = path.join(COVERS_DIR, filename);
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const html = await generateCoverHTML(title, subtitle, topic, category);

  if (!html || !html.includes('<html') && !html.includes('<!DOCTYPE')) {
    throw new Error('AI não gerou HTML válido para a capa');
  }

  const buf = await renderHTMLtoPNG(html, outPath);
  logger.info(`✅ coverAgentHTML: Capa gerada em ${Date.now() - t0}ms (${Math.round(buf.length / 1024)}KB)`);

  return outPath;
}

module.exports = { generateHTMLCover };
