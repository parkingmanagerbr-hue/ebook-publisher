'use strict';
/**
 * coverViralAgent.js — Capa VIRAL: imagem IA (rosto/cena por categoria) + composição HTML premium.
 * Rosto full-bleed + color grade + scrim + tipografia Anton + badge. 1600x2560 (KDP).
 * É o Provider 0 do coverAgent. Fallback seguro (retorna null se falhar → cai nos outros providers).
 */
const fs = require('fs');
const path = require('path');
let puppeteer; try { puppeteer = require('puppeteer'); } catch (_) { try { puppeteer = require('puppeteer-core'); } catch (__) { puppeteer = null; } }
const { generateImage } = require('./imageGenAgent');
let log; try { log = require('../core/logger').createLogger('coverViral'); }
catch (_) { log = { info: (...a) => console.log('[coverViral]', ...a), warn: (...a) => console.warn('[coverViral]', ...a) }; }

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE ||
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');

// ── Categoria → imagem (rosto/cena viral) + paleta de acento ──────────────────
const STYLE = {
  financas:         { img: 'confident brazilian businessman in elegant suit, arms crossed, subtle city skyline at golden hour behind, wealth and success, sharp cinematic lighting', a1:'#ffc24b', accent:'#ffd166' },
  tecnologia:       { img: 'focused young brazilian person working on laptop, dramatic neon blue and cyan tech lighting, futuristic digital atmosphere, innovation', a1:'#22d3ff', accent:'#63e6ff' },
  saude:            { img: 'fit healthy athletic brazilian person, radiant confident smile, bright energetic natural light, wellness and vitality', a1:'#39d98a', accent:'#7bf0b0' },
  negocios:         { img: 'confident brazilian entrepreneur looking at camera with determination, dynamic dramatic lighting, ambition and success energy', a1:'#ff8a3d', accent:'#ffb072' },
  comportamento:    { img: 'serene confident brazilian person, calm powerful expression, eyes forward, deep teal and navy dramatic rim lighting, emotional depth', a1:'#ffc24b', accent:'#ffd166' },
  espiritualidade:  { img: 'peaceful brazilian person eyes closed in serenity, soft golden light rays from above, warm spiritual atmosphere, faith and hope', a1:'#f5c451', accent:'#ffde8a' },
  relacionamentos:  { img: 'happy brazilian couple embracing, warm intimate romantic lighting, genuine connection and love, soft focus', a1:'#ff6f91', accent:'#ff9db3' },
  culinaria:        { img: 'delicious gourmet homemade brazilian dish beautifully plated, vibrant fresh ingredients, warm appetizing professional food photography, top-down dramatic light', a1:'#ff7a45', accent:'#ffa06b' },
  educacao:         { img: 'determined focused brazilian student studying with books, bright hopeful academic lighting, achievement and growth', a1:'#4f8bff', accent:'#7fa8ff' },
  familia:          { img: 'loving brazilian mother tenderly holding her child, warm soft golden light, genuine tenderness and care', a1:'#ffb072', accent:'#ffcaa0' },
  carreira:         { img: 'confident brazilian professional in modern office, corporate success, sharp clean lighting, ambition', a1:'#4f8bff', accent:'#7fa8ff' },
  pets:             { img: 'adorable happy dog and cat together, joyful expression, warm bright natural light, professional pet photography, heartwarming', a1:'#ffb072', accent:'#ffcaa0' },
  default:          { img: 'confident inspiring brazilian person portrait, calm strong expression, dramatic cinematic lighting, deep rich background', a1:'#ffc24b', accent:'#ffd166' },
};
const NEG = 'blurry, distorted face, deformed, extra fingers, watermark, text, letters, logo, low quality, cartoon';

function badgeFor(subtitle, topic) {
  const t = ((topic || '') + ' ' + (subtitle || '')).toLowerCase();
  if (/passo|método|guia prático/.test(t)) return 'Passo a Passo';
  if (/iniciante|zero|começar/.test(t))    return 'Do Zero ao Pro';
  if (/completo|definitivo/.test(t))        return 'Guia Completo';
  return 'Guia 2026';
}
// separa o título: última palavra (ou palavra-chave) vira o destaque colorido
function splitTitle(title) {
  const clean = (title || '').replace(/:.*/, '').trim(); // sem subtítulo após ':'
  const words = clean.split(/\s+/);
  if (words.length === 1) return { main: '', accent: words[0] };
  const accent = words.pop();
  return { main: words.join(' '), accent };
}

function coverHTML({ title, subtitle, kicker, badge, st, imgB64 }) {
  const { main, accent } = splitTitle(title);
  const IMG = 'data:image/jpeg;base64,' + imgB64;
  const sub = (subtitle || '').slice(0, 90);
  // fonte auto-ajustada: limitada pelo total E pela palavra mais longa (Anton ~0.55em/char em caixa alta)
  const maxWord = Math.max(...(main + ' ' + accent).trim().split(/\s+/).map(w => w.length));
  let big = (main + accent).length > 14 ? 200 : 250;
  big = Math.max(90, Math.min(big, Math.floor(1380 / (0.55 * maxWord))));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@700;800&family=Space+Grotesk:wght@600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}html,body{width:1600px;height:2560px}
.cv{position:relative;width:1600px;height:2560px;overflow:hidden;background:#05070d;font-family:'Archivo',sans-serif}
.photo{position:absolute;inset:0;background:url('${IMG}') center 16%/cover no-repeat}
.grade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,30,45,.22),rgba(5,7,13,.05) 35%,rgba(5,7,13,.12) 58%);mix-blend-mode:multiply}
.warm{position:absolute;inset:0;background:radial-gradient(120% 60% at 50% 6%,${st.a1}22,transparent 55%)}
.scrim{position:absolute;left:0;right:0;bottom:0;height:1520px;background:linear-gradient(180deg,transparent 0%,rgba(5,7,13,.55) 38%,rgba(5,7,13,.93) 66%,#05070d 100%)}
.topfade{position:absolute;left:0;right:0;top:0;height:520px;background:linear-gradient(180deg,rgba(5,7,13,.78),transparent)}
.grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")}
.top{position:absolute;top:120px;left:0;right:0;text-align:center;z-index:6}
.kick{font-family:'Space Grotesk';font-weight:700;letter-spacing:10px;font-size:38px;color:#eaf2ff;text-transform:uppercase;text-shadow:0 2px 20px rgba(0,0,0,.85)}
.badge{position:absolute;top:116px;right:105px;z-index:6;background:${st.a1};color:#0a0a0a;font-family:'Space Grotesk';font-weight:700;letter-spacing:3px;font-size:31px;text-transform:uppercase;padding:17px 28px;border-radius:14px;transform:rotate(5deg);box-shadow:0 14px 40px ${st.a1}66}
.mid{position:absolute;left:100px;right:100px;bottom:360px;text-align:center;z-index:6}
.bar{width:120px;height:10px;margin:0 auto 40px;border-radius:6px;background:${st.a1};box-shadow:0 0 40px ${st.a1}}
.title{font-family:'Anton';color:#fff;line-height:.9;letter-spacing:1px;font-size:${big}px;text-transform:uppercase;text-shadow:0 18px 70px rgba(0,0,0,.85)}
.title b{color:${st.accent};text-shadow:0 0 55px ${st.a1}88}
.sub{margin-top:44px;font-family:'Archivo';font-weight:800;font-size:58px;line-height:1.22;color:#e8eefc;max-width:1320px;margin:44px auto 0;text-shadow:0 4px 24px rgba(0,0,0,.85)}
.foot{position:absolute;bottom:110px;left:0;right:0;text-align:center;z-index:6}
.auth{font-family:'Space Grotesk';font-weight:600;letter-spacing:8px;font-size:36px;color:#aeb9d6;text-transform:uppercase}
</style></head><body><div class="cv">
<div class="photo"></div><div class="grade"></div><div class="warm"></div>
<div class="topfade"></div><div class="scrim"></div><div class="grain"></div>
<div class="top"><div class="kick">${kicker}</div></div>
<div class="badge">${badge}</div>
<div class="mid"><div class="bar"></div><div class="title">${main ? main + ' <b>' + accent + '</b>' : '<b>' + accent + '</b>'}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
<div class="foot"><div class="auth">${(process.env.AUTHOR_NAME || 'GENIA Editorial').toUpperCase()}</div></div>
</div></body></html>`;
}

// Sorteia uma imagem do acervo curado para a categoria.
//
// Sorteio (e nao rodizio sequencial) de proposito: o pipeline roda varios
// processos e um contador compartilhado exigiria estado; com sorteio, capas
// seguidas do mesmo tema ja saem diferentes sem coordenacao nenhuma.
const COVER_POOL = process.env.COVER_POOL_DIR
  || path.join(__dirname, '..', '..', 'data', 'cover_pool');

function escolherDoPool(category) {
  try {
    const candidatos = [category, 'default', 'geral'].filter(Boolean);
    for (const c of candidatos) {
      const dir = path.join(COVER_POOL, String(c));
      if (!fs.existsSync(dir)) continue;
      const arquivos = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
      if (!arquivos.length) continue;
      return path.join(dir, arquivos[Math.floor(Math.random() * arquivos.length)]);
    }
  } catch (e) {
    log.warn(`acervo indisponivel (${e.message.slice(0, 60)}) — gerando por API`);
  }
  return null;
}

async function generateViralCover(title, subtitle, topic, category, coversDir) {
  if (!puppeteer) { log.warn('sem puppeteer'); return null; }
  const st = STYLE[category] || STYLE.default;
  const dir = coversDir || path.join(__dirname, '..', '..', 'data', 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `viral_bg_${Date.now()}.jpg`);
  try {
    // 1. fundo: acervo curado primeiro, geracao por API depois.
    //
    // O acervo (COVER_POOL) sao imagens geradas no Google Flow (Nano Banana 2),
    // que sai bem melhor que os provedores de API disponiveis hoje: enquadra a
    // pessoa nos dois tercos de cima e deixa o terco de baixo escuro e limpo,
    // que e exatamente onde a composicao escreve o titulo. Gerar no Flow nao da
    // para automatizar (nao tem API publica, so navegador), mas o acervo se
    // reabastece em lote e serve muitos e-books.
    //
    // Sem imagem para a categoria, cai na geracao por API — o pipeline nunca
    // depende do acervo estar populado.
    const doPool = escolherDoPool(category);
    if (doPool) {
      fs.copyFileSync(doPool, tmp);
      log.info(`fundo do acervo Flow: ${path.basename(doPool)}`);
    } else {
      const prompt = `${st.img}. Professional book cover photography, ultra detailed, 8k, high contrast, dramatic. Negative: ${NEG}`;
      await generateImage({ prompt, width: 1024, height: 1536, outputPath: tmp });
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 6000) throw new Error('imagem vazia/falhou');
    const imgB64 = fs.readFileSync(tmp).toString('base64');

    // 2. composição HTML premium
    const html = coverHTML({ title, subtitle, kicker: badgeKicker(topic), badge: badgeFor(subtitle, topic), st, imgB64 });
    const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 2560, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await new Promise(r => setTimeout(r, 900));
      const out = path.join(dir, `cover_${Date.now()}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height: 2560 } });
      log.info(`✅ Capa viral (rosto/cena ${category}): ${path.basename(out)}`);
      return out;
    } finally { await browser.close().catch(() => {}); }
  } catch (e) {
    log.warn(`capa viral falhou: ${e.message.slice(0, 80)} — fallback`);
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function badgeKicker(topic) {
  return 'Método Prático';
}

module.exports = { generateViralCover, STYLE };
