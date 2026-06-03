/**
 * coverAgentHTML — Capa viral via HTML/CSS + Puppeteer (v2 - Viral Designs)
 *
 * Fluxo:
 *   1. Gemini gera HTML completo com design viral específico por categoria
 *   2. Puppeteer renderiza o HTML em 1600×2560px (alta resolução KDP-ready)
 *   3. Screenshot PNG salvo como capa final
 *
 * Diferencial v2:
 *   - Designs virais por categoria (não genéricos)
 *   - Múltiplos estilos rotacionados (evita repetição)
 *   - Google Fonts via @import (Puppeteer tem acesso à rede)
 *   - Layouts dinâmicos: split, bold-type, magazine, cinematic
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { generate: generateText } = require('../core/aiClient');
const { createLogger } = require('../core/logger');
const logger = createLogger('coverAgentHTML');

const COVERS_DIR = path.join(__dirname, '../../data/covers');

// ─── Estilos virais por categoria ────────────────────────────────────────────
// Cada categoria tem 3 estilos possíveis, rotacionados aleatoriamente
const VIRAL_STYLES = {

  financas: [
    // Estilo 1: Minimalista black/gold (Wall Street Journal style)
    {
      bg: 'linear-gradient(135deg, #0A0A0A 0%, #1A1A1A 50%, #0D0D0D 100%)',
      accent: '#C9A84C',
      textColor: '#FFFFFF',
      secondaryColor: '#C9A84C',
      style: 'minimalist-gold',
      description: 'Elegante preto e ouro, estilo Wall Street — transmite autoridade financeira',
      elements: 'diagonal gold lines, subtle money symbols, clean typography, BESTSELLER badge top-right',
    },
    // Estilo 2: Vibrant green (growth/money)
    {
      bg: 'linear-gradient(180deg, #001A0A 0%, #003D1A 40%, #001A0A 100%)',
      accent: '#00FF88',
      textColor: '#FFFFFF',
      secondaryColor: '#00CC6A',
      style: 'growth-green',
      description: 'Verde crescimento com contraste forte — transmite prosperidade',
      elements: 'upward arrow graphics, stock chart line decoration, bold uppercase typography',
    },
    // Estilo 3: Red urgency (debt/problem solving)
    {
      bg: 'linear-gradient(160deg, #1A0000 0%, #3D0000 50%, #1A0000 100%)',
      accent: '#FF3333',
      textColor: '#FFFFFF',
      secondaryColor: '#FF6666',
      style: 'urgency-red',
      description: 'Vermelho urgência — para tópicos de sair de dívidas, emergências financeiras',
      elements: 'warning symbols, bold impact typography, breaking news style layout',
    },
  ],

  tecnologia: [
    // Estilo 1: Cyberpunk neon
    {
      bg: 'linear-gradient(135deg, #050010 0%, #0A0025 50%, #000518 100%)',
      accent: '#00FFFF',
      textColor: '#FFFFFF',
      secondaryColor: '#FF00FF',
      style: 'cyberpunk-neon',
      description: 'Cyberpunk com neon cyan e magenta — viral no nicho de IA e tecnologia',
      elements: 'circuit board SVG patterns, glowing neon borders, HUD-style text labels, matrix dots',
    },
    // Estilo 2: Clean tech (Apple-style)
    {
      bg: 'linear-gradient(180deg, #FFFFFF 0%, #F0F0F5 100%)',
      accent: '#0071E3',
      textColor: '#1D1D1F',
      secondaryColor: '#0071E3',
      style: 'clean-tech',
      description: 'Clean branco estilo Apple — premium e confiável para guias de tecnologia',
      elements: 'clean geometric shapes, minimal shadows, San Francisco-style typography',
    },
    // Estilo 3: Dark futuristic
    {
      bg: 'linear-gradient(180deg, #050505 0%, #0D0D1A 60%, #050510 100%)',
      accent: '#7B2FFF',
      textColor: '#FFFFFF',
      secondaryColor: '#00D4FF',
      style: 'dark-future',
      description: 'Escuro futurista roxo/azul — transmite inovação e futuro',
      elements: 'abstract tech shapes, gradient glow effects, bold modern sans-serif',
    },
  ],

  saude: [
    // Estilo 1: Fresh green (health/wellness)
    {
      bg: 'linear-gradient(160deg, #003320 0%, #005C38 50%, #003320 100%)',
      accent: '#00E676',
      textColor: '#FFFFFF',
      secondaryColor: '#A5D6A7',
      style: 'fresh-wellness',
      description: 'Verde fresco wellness — transmite saúde, natureza, transformação',
      elements: 'leaf/nature SVG decorations, clean circular badges, before/after potential',
    },
    // Estilo 2: Energy orange/yellow (fitness)
    {
      bg: 'linear-gradient(135deg, #1A0500 0%, #3D1000 50%, #1A0500 100%)',
      accent: '#FF6D00',
      textColor: '#FFFFFF',
      secondaryColor: '#FFD600',
      style: 'energy-fitness',
      description: 'Laranja energia fitness — ideal para emagrecimento e exercícios',
      elements: 'energy bolt symbols, dynamic diagonal lines, bold italic typography',
    },
    // Estilo 3: Medical white/blue (credibility)
    {
      bg: 'linear-gradient(180deg, #F8FEFF 0%, #E8F4FF 100%)',
      accent: '#0077B6',
      textColor: '#023047',
      secondaryColor: '#0096C7',
      style: 'medical-trust',
      description: 'Azul médico confiável — para guias de saúde baseados em ciência',
      elements: 'clean blue design, medical cross symbol, professional badge',
    },
  ],

  negocios: [
    // Estilo 1: Bold corporate (authority)
    {
      bg: 'linear-gradient(160deg, #050505 0%, #1A1A1A 100%)',
      accent: '#E63946',
      textColor: '#FFFFFF',
      secondaryColor: '#FF6B6B',
      style: 'bold-authority',
      description: 'Preto e vermelho autoridade corporativa — estilo Harvard Business Review',
      elements: 'bold geometric shapes, strong red accents, business chart decoration',
    },
    // Estilo 2: Blue ocean strategy
    {
      bg: 'linear-gradient(180deg, #002A4E 0%, #00529B 50%, #002A4E 100%)',
      accent: '#00B4D8',
      textColor: '#FFFFFF',
      secondaryColor: '#90E0EF',
      style: 'blue-ocean',
      description: 'Azul oceano confiável — para estratégia, liderança, gestão',
      elements: 'wave pattern, horizon line, professional badge layout',
    },
    // Estilo 3: Digital gold (online business)
    {
      bg: 'linear-gradient(135deg, #0D0D0D 0%, #1A1500 50%, #0D0D0D 100%)',
      accent: '#FFD700',
      textColor: '#FFFFFF',
      secondaryColor: '#FFA500',
      style: 'digital-gold',
      description: 'Ouro digital — para renda online, dropshipping, negócios digitais',
      elements: 'digital/money symbols, gold gradient typography, success badges',
    },
  ],

  comportamento: [
    {
      bg: 'linear-gradient(160deg, #1A0030 0%, #35006B 50%, #1A0030 100%)',
      accent: '#E040FB',
      textColor: '#FFFFFF',
      secondaryColor: '#CE93D8',
      style: 'mindset-purple',
      description: 'Roxo mindset — para hábitos, desenvolvimento pessoal, psicologia',
      elements: 'brain/mind SVG shapes, neuron pattern decoration, inspirational layout',
    },
    {
      bg: 'linear-gradient(180deg, #0A1628 0%, #1A2C4E 50%, #0A1628 100%)',
      accent: '#FFC300',
      textColor: '#FFFFFF',
      secondaryColor: '#FFE066',
      style: 'achievement-navy',
      description: 'Azul marinho + ouro conquista — estilo James Clear, Atomic Habits',
      elements: 'minimal geometric, strong typography hierarchy, bold numbers/stats',
    },
    {
      bg: 'linear-gradient(135deg, #F5F5F5 0%, #EBEBEB 100%)',
      accent: '#FF5722',
      textColor: '#1A1A1A',
      secondaryColor: '#FF8A65',
      style: 'modern-minimal',
      description: 'Branco moderno minimalista — para autoajuda clean e contemporânea',
      elements: 'clean white with orange accent, minimal decoration, impact typography',
    },
  ],

  espiritualidade: [
    {
      bg: 'linear-gradient(180deg, #0A0015 0%, #1A0030 40%, #0D0020 100%)',
      accent: '#FFD700',
      textColor: '#FFFFFF',
      secondaryColor: '#FFF3B0',
      style: 'divine-gold',
      description: 'Divino roxo e ouro — para livros cristãos, espiritualidade, devocionais',
      elements: 'cross/dove SVG, golden rays of light, sacred geometry decoration',
    },
    {
      bg: 'radial-gradient(ellipse at center, #1A0030 0%, #05000F 70%)',
      accent: '#9B59B6',
      textColor: '#FFFFFF',
      secondaryColor: '#DDA0DD',
      style: 'mystical-cosmos',
      description: 'Cosmos místico — para espiritualidade new age, meditação, universo',
      elements: 'star patterns, celestial circles, ethereal glow effects',
    },
    {
      bg: 'linear-gradient(180deg, #FEFCE8 0%, #FEF9C3 100%)',
      accent: '#B45309',
      textColor: '#1C1917',
      secondaryColor: '#D97706',
      style: 'warm-faith',
      description: 'Quente e acolhedor — para livros de fé, esperança, família cristã',
      elements: 'warm light rays, simple cross, scripture-like typography',
    },
  ],

  relacionamentos: [
    {
      bg: 'linear-gradient(160deg, #1A0010 0%, #3D0025 50%, #1A0010 100%)',
      accent: '#FF4081',
      textColor: '#FFFFFF',
      secondaryColor: '#FF80AB',
      style: 'passion-rose',
      description: 'Rosa paixão — para relacionamentos, amor, sedução',
      elements: 'rose/heart SVG decoration, flowing curves, romantic typography',
    },
    {
      bg: 'linear-gradient(180deg, #1A1A2E 0%, #2D2D4E 50%, #1A1A2E 100%)',
      accent: '#FF6B9D',
      textColor: '#FFFFFF',
      secondaryColor: '#FFB3CC',
      style: 'couple-blue',
      description: 'Azul noite + rosa — para comunicação, terapia de casal, divórcio',
      elements: 'two interlocking circles (Venn), communication symbols',
    },
  ],

  culinaria: [
    {
      bg: 'linear-gradient(135deg, #1A0800 0%, #3D1500 50%, #1A0800 100%)',
      accent: '#FF8C00',
      textColor: '#FFFFFF',
      secondaryColor: '#FFC04D',
      style: 'gourmet-orange',
      description: 'Laranja gourmet quente — para receitas, culinária, gastronomia',
      elements: 'food/spice SVG icons, warm bokeh circles, chef typography',
    },
    {
      bg: 'linear-gradient(180deg, #FAFAF7 0%, #F0EFE7 100%)',
      accent: '#2D6A4F',
      textColor: '#1B1B1B',
      secondaryColor: '#40916C',
      style: 'clean-healthy-food',
      description: 'Branco natural verde — para alimentação saudável, vegano, light',
      elements: 'leaf decoration, clean minimal layout, fresh food aesthetic',
    },
  ],

  educacao: [
    {
      bg: 'linear-gradient(160deg, #001830 0%, #003060 50%, #001830 100%)',
      accent: '#40C4FF',
      textColor: '#FFFFFF',
      secondaryColor: '#B3E5FC',
      style: 'knowledge-blue',
      description: 'Azul conhecimento — para educação, estudo, concursos',
      elements: 'book/knowledge symbols, star/rating elements, achievement badges',
    },
    {
      bg: 'linear-gradient(135deg, #1A0A00 0%, #3D2000 100%)',
      accent: '#FF8F00',
      textColor: '#FFFFFF',
      secondaryColor: '#FFD54F',
      style: 'smart-amber',
      description: 'Âmbar inteligência — para métodos de estudo, produtividade',
      elements: 'brain/lightbulb SVG, speed lines, bold achievement typography',
    },
  ],

  carreira: [
    {
      bg: 'linear-gradient(160deg, #001520 0%, #003040 50%, #001520 100%)',
      accent: '#00BCD4',
      textColor: '#FFFFFF',
      secondaryColor: '#80DEEA',
      style: 'career-teal',
      description: 'Azul teal profissional — para carreira, emprego, freelance',
      elements: 'upward career ladder, professional badge, clean corporate aesthetic',
    },
    {
      bg: 'linear-gradient(135deg, #F8F9FA 0%, #E9ECEF 100%)',
      accent: '#212529',
      textColor: '#212529',
      secondaryColor: '#495057',
      style: 'linkedin-white',
      description: 'Branco LinkedIn profissional — para vagas, currículo, entrevistas',
      elements: 'clean white, dark typography, professional minimal layout',
    },
  ],

  default: [
    {
      bg: 'linear-gradient(160deg, #0D0D1A 0%, #1A1A35 50%, #0D0D1A 100%)',
      accent: '#E94560',
      textColor: '#FFFFFF',
      secondaryColor: '#FF6B8A',
      style: 'signature-red',
      description: 'Azul escuro e vermelho — design padrão impactante',
      elements: 'geometric shapes, bold typography, accent line decorations',
    },
  ],
};

// ─── Escolher estilo aleatório para a categoria ───────────────────────────────
let _styleCounter = 0;
function pickStyle(category) {
  const styles = VIRAL_STYLES[category] || VIRAL_STYLES.default;
  const style = styles[_styleCounter % styles.length];
  _styleCounter++;
  return style;
}

// ─── PROMPT VIRAL para geração de HTML ───────────────────────────────────────
function buildViralHTMLPrompt(title, subtitle, topic, category) {
  const style = pickStyle(category);

  return `You are a world-class book cover designer for bestselling books on Amazon KDP and Hotmart. Your covers go viral and drive massive sales.

Create a VIRAL, HIGH-QUALITY HTML/CSS e-book cover that will stand out in a crowded marketplace.

DESIGN STYLE: "${style.style}" — ${style.description}
BACKGROUND: ${style.bg}
ACCENT COLOR: ${style.accent}
TEXT COLOR: ${style.textColor}
SECONDARY COLOR: ${style.secondaryColor}

BOOK DETAILS:
- Title: "${title}"
- Subtitle: "${subtitle || ''}"
- Topic/Niche: "${topic}"
- Target audience: Brazilian digital market (Hotmart, Amazon KDP)
- Price point: $4.99 — needs to look PREMIUM

DESIGN REQUIREMENTS (make it VIRAL not generic):
1. Canvas: exactly 1600px × 2560px, no scroll, overflow:hidden
2. Use Google Fonts: @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&family=Playfair+Display:wght@700;900&family=Oswald:wght@700&family=Inter:wght@300;400;700;900&display=swap')
3. VISUAL ELEMENTS (${style.elements}) — use CSS shapes, gradients, SVG inline
4. Strong visual hierarchy: The title must be the HERO element, largest and most impactful
5. Include a "BESTSELLER" or category badge in top-right corner
6. Include author "Veloxis Editorial" at bottom
7. 3 benefit bullets near bottom (short, impactful — translate to Portuguese if needed)
8. Use TEXT-SHADOW and GLOW effects for dramatic impact
9. Use TRANSFORMS and CLIP-PATH for dynamic, non-boring layouts
10. Make it feel like a book that costs R$200, not a free PDF

LAYOUT IDEAS (choose the best for this style):
- SPLIT: Color block on left, title on right
- FULL-BLEED: Title as hero over full background with visual texture
- MAGAZINE: Editorial layout with strong grid
- BOLD-TYPE: Typography IS the design (huge letters as background pattern)
- CINEMATIC: Wide color stripe at top/bottom, content in center

CRITICAL RULES:
- Output ONLY raw HTML from <!DOCTYPE html> to </html> — NO markdown, NO code blocks, NO explanation
- All CSS inline in <style> tag in <head>
- NO JavaScript
- NO external images (use CSS gradients, SVG inline, CSS shapes)
- body: margin:0; padding:0; overflow:hidden; width:1600px; height:2560px
- ALL elements inside a div with width:1600px; height:2560px; position:relative; overflow:hidden
- NEVER repeat designs — be creative and unique

Create a cover so stunning it makes people click "Buy Now" immediately.`;
}

// ─── Chave Gemini dedicada às CAPAS (fora do pool de texto _1.._5) ────────────
// Usada PRIMEIRO para gerar o HTML da capa, poupando a cota das chaves de texto.
// Se falhar (chave inválida/esgotada), cai no pool normal via generateText.
const COVER_KEY = process.env.GEMINI_COVER_KEY || process.env.GEMINI_API_KEY_6;
const COVER_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

async function _generateViaCoverKey(prompt) {
  if (!COVER_KEY) return null;
  try {
    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${COVER_MODEL}:generateContent?key=${COVER_KEY}`;
    const res = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 6000, temperature: 0.9 },
    }, { timeout: 60_000 });
    const text = res.data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    if (text.trim().length > 100) {
      logger.info('🔑 Capa gerada com chave Gemini dedicada (GEMINI_COVER_KEY)');
      return text;
    }
    return null;
  } catch (e) {
    const status = e?.response?.status;
    logger.warn(`⚠️ Chave de capa dedicada falhou (${status || e.message}) — usando pool de texto`);
    return null;
  }
}

// ─── Gerar HTML da capa via AI ────────────────────────────────────────────────
async function generateCoverHTML(title, subtitle, topic, category) {
  const prompt = buildViralHTMLPrompt(title, subtitle, topic, category);
  logger.info(`🎨 Gerando HTML viral para capa "${title}" [estilo: ${(VIRAL_STYLES[category] || VIRAL_STYLES.default)[0].style}]`);
  // Tenta primeiro a chave dedicada a capas; se falhar, pool de texto normal
  let raw = await _generateViaCoverKey(prompt);
  if (!raw) {
    const result = await generateText(prompt, '', { maxTokens: 6000 });
    raw = typeof result === 'string' ? result : (result?.text ?? '');
  }
  const html = typeof raw === 'string' ? raw : String(raw || '');

  // Limpar possíveis blocos markdown
  return html
    .replace(/^```html\n?/i, '')
    .replace(/^```\n?/, '')
    .replace(/\n?```$/m, '')
    .trim();
}

// ─── Renderizar HTML com Puppeteer → PNG ──────────────────────────────────────
async function renderHTMLtoPNG(html, outputPath) {
  const puppeteer = require('puppeteer');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 2560, deviceScaleFactor: 1 });

    // Carregar HTML — waitUntil networkidle2 para aguardar Google Fonts
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 20000 });

    // Aguardar renderização completa das fontes
    await new Promise(r => setTimeout(r, 1200));

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
  logger.info(`🚀 coverAgentHTML v2 VIRAL: "${title}" [cat=${category}]`);
  const t0 = Date.now();

  const filename = `cover_html_${Date.now()}.png`;
  const outPath  = path.join(COVERS_DIR, filename);
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const html = await generateCoverHTML(title, subtitle, topic, category);

  if (!html || (!html.includes('<html') && !html.includes('<!DOCTYPE'))) {
    throw new Error('AI não gerou HTML válido para a capa');
  }

  const buf = await renderHTMLtoPNG(html, outPath);
  const elapsed = Date.now() - t0;
  const sizeKb = Math.round(buf.length / 1024);
  logger.info(`✅ Capa viral gerada em ${elapsed}ms — ${sizeKb}KB`);

  return outPath;
}

module.exports = { generateHTMLCover, pickStyle, VIRAL_STYLES };
