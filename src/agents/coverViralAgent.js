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
// Os termos de nudez/sensualidade no negativo NAO sao decorativos. Em 14/09/2026
// uma capa de livro sobre documentos de ADOCAO saiu com uma mulher de ombros nus
// e ar sensual — o Pollinations tende a sexualizar "retrato de mulher jovem"
// quando nada diz o contrario. Capa de e-book e vitrine publica de loja.
const NEG = 'blurry, distorted face, deformed, extra fingers, watermark, text, letters, logo, low quality, cartoon, ' +
  'nude, naked, topless, bare shoulders, cleavage, lingerie, swimsuit, sensual, sexy, seductive, suggestive, erotic';

/**
 * Cena e luz por categoria, SEM a pessoa.
 *
 * O prompt antigo trazia a pessoa embutida ("confident brazilian businessman in
 * elegant suit"), fixa por categoria. A semente aleatoria mudava detalhes, mas o
 * arquetipo era sempre o mesmo — oitenta livros de financas com o mesmo homem de
 * terno. Separar cena de pessoa deixa variar quem aparece sem perder o clima.
 */
const CENA = {
  financas:        'subtle city skyline at golden hour behind, wealth and success, sharp cinematic lighting',
  tecnologia:      'working with a laptop, dramatic neon blue and cyan tech lighting, futuristic digital atmosphere',
  saude:           'bright energetic natural light, wellness and vitality, radiant healthy look',
  negocios:        'dynamic dramatic lighting, ambition and success energy, modern setting',
  comportamento:   'calm powerful expression, deep teal and navy dramatic rim lighting, emotional depth',
  espiritualidade: 'soft golden light rays from above, warm spiritual atmosphere, serenity',
  relacionamentos: 'warm intimate lighting, genuine connection, soft focus background',
  educacao:        'studying with books, bright hopeful academic lighting, achievement and growth',
  familia:         'warm soft golden light, genuine tenderness and care, home setting',
  carreira:        'modern office, corporate success, sharp clean lighting',
  default:         'calm strong expression, dramatic cinematic lighting, deep rich background',
};
// Categorias cujo protagonista NAO e uma pessoa: o prompt original ja serve.
const SEM_PESSOA = new Set(['culinaria', 'pets']);

const PESSOAS = [
  'young woman in her twenties with curly hair',
  'man in his thirties with a short beard',
  'woman in her forties with straight dark hair',
  'senior man in his sixties with grey hair',
  'young man in his twenties with a friendly smile',
  'woman in her fifties with short silver hair',
  'man in his forties with glasses',
  'young woman with braided hair',
  'middle-aged woman with wavy auburn hair',
  'man in his fifties wearing a casual shirt',
  'woman in her thirties with a ponytail',
  'young man with dark skin and short hair',
  'woman with East Asian features in her thirties',
  'man with olive skin in his thirties',
];

/** Pessoa estavel por livro: o mesmo e-book regerado mantem o rosto; livros diferentes variam. */
function pessoaPara(chave) {
  let h = 0;
  for (const c of String(chave || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PESSOAS[h % PESSOAS.length];
}

function promptDaCapa(category, title, topic) {
  const st = STYLE[category] || STYLE.default;
  const base = SEM_PESSOA.has(category)
    ? st.img
    : `professional portrait of a ${pessoaPara(title)}, fully clothed in modest professional attire, ` +
      `shoulders covered, friendly and trustworthy, family-friendly, ${CENA[category] || CENA.default}`;
  return `${base}, theme: ${String(topic || title).slice(0, 80)}. ` +
    // A composicao que tornava o acervo Flow melhor: pessoa nos dois tercos de
    // cima, terco de baixo escuro e limpo — e onde o titulo e escrito.
    'Subject framed in the upper two thirds, lower third dark and uncluttered. ' +
    `Professional book cover photography, ultra detailed, high contrast, dramatic. Negative: ${NEG}`;
}

/**
 * Rotulos da capa por idioma.
 *
 * O badge e o kicker eram texto fixo em portugues, entao livro em ingles saia
 * com "PASSO A PASSO" e "METODO PRATICO" na capa — o comprador ve a capa antes
 * de qualquer outra coisa, e ela dizia que o livro era portugues.
 *
 * Idioma nao mapeado cai no INGLES, nao no portugues: para um livro em holandes
 * o rotulo em ingles passa despercebido, o em portugues denuncia erro.
 */
const ROTULOS = {
  'pt-BR': { passo: 'Passo a Passo', zero: 'Do Zero ao Pro', completo: 'Guia Completo', guia: 'Guia 2026', kicker: 'Método Prático' },
  'en-US': { passo: 'Step by Step',  zero: 'Zero to Pro',    completo: 'Complete Guide', guia: '2026 Guide', kicker: 'Practical Method' },
  'es-ES': { passo: 'Paso a Paso',   zero: 'De Cero a Pro',  completo: 'Guía Completa',  guia: 'Guía 2026',  kicker: 'Método Práctico' },
  'fr-FR': { passo: 'Pas à Pas',     zero: 'De Zéro à Pro',  completo: 'Guide Complet',  guia: 'Guide 2026', kicker: 'Méthode Pratique' },
  'de-DE': { passo: 'Schritt für Schritt', zero: 'Von Null auf Pro', completo: 'Kompletter Leitfaden', guia: 'Leitfaden 2026', kicker: 'Praktische Methode' },
  'it-IT': { passo: 'Passo per Passo', zero: 'Da Zero a Pro', completo: 'Guida Completa', guia: 'Guida 2026', kicker: 'Metodo Pratico' },
  'nl-NL': { passo: 'Stap voor Stap', zero: 'Van Nul naar Pro', completo: 'Complete Gids', guia: 'Gids 2026', kicker: 'Praktische Methode' },
  'pl-PL': { passo: 'Krok po Kroku', zero: 'Od Zera do Pro', completo: 'Kompletny Przewodnik', guia: 'Przewodnik 2026', kicker: 'Metoda Praktyczna' },
  'ja-JP': { passo: 'ステップバイステップ', zero: 'ゼロからプロへ', completo: '完全ガイド', guia: '2026年ガイド', kicker: '実践メソッド' },
  'zh-CN': { passo: '循序渐进', zero: '从零到专业', completo: '完整指南', guia: '2026指南', kicker: '实用方法' },
  'ko-KR': { passo: '단계별 가이드', zero: '제로부터 프로까지', completo: '완벽 가이드', guia: '2026 가이드', kicker: '실전 방법' },
  'ru-RU': { passo: 'Шаг за Шагом', zero: 'С Нуля до Про', completo: 'Полное Руководство', guia: 'Руководство 2026', kicker: 'Практический Метод' },
};
function rotulos(idioma) { return ROTULOS[idioma] || ROTULOS['en-US']; }

function badgeFor(subtitle, topic, idioma) {
  const r = rotulos(idioma);
  const t = ((topic || '') + ' ' + (subtitle || '')).toLowerCase();
  // As pistas so existem em portugues, entao so valem quando o livro e portugues.
  if (idioma === 'pt-BR') {
    if (/passo|método|guia prático/.test(t)) return r.passo;
    if (/iniciante|zero|começar/.test(t))    return r.zero;
    if (/completo|definitivo/.test(t))        return r.completo;
  } else {
    if (/step|paso|schritt|passo/.test(t))            return r.passo;
    if (/beginner|zero|principiante|anfänger/.test(t)) return r.zero;
    if (/complete|completo|komplett/.test(t))          return r.completo;
  }
  return r.guia;
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
  // Kicker: com o texto fixo "Metodo Pratico" (14 chars) nunca havia colisao.
  // Com a dor escrita pelo LLM ele chega a 40 chars e passava POR BAIXO do
  // badge — verificado a olho numa capa real: "VIVENDO DE SALARIO MINIM" com o
  // selo por cima. Agora a fonte e o espacamento encolhem conforme o tamanho, e
  // o bloco reserva a faixa do badge dos dois lados (ver .top no CSS).
  const kickLen = String(kicker || '').length;
  const kickSize = kickLen > 30 ? 26 : kickLen > 22 ? 31 : 38;
  const kickSpacing = kickLen > 30 ? 4 : kickLen > 22 ? 6 : 10;

  // LARGURA DO CARACTERE: 0.55 em e o Anton em caixa alta. Japones, chines e
  // coreano ocupam ~1 em e nao tem espaco entre palavras — com 0.55 a fonte saia
  // grande demais e o navegador quebrava a linha no meio da palavra ("見え / る化
  // する", visto a olho numa capa em 14/09/2026). Sem espaco, o texto inteiro
  // conta como uma "palavra" so, entao o limite de largura tambem precisa dela.
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(main + accent);
  const fatorChar = cjk ? 1.0 : 0.55;

  let big = (main + accent).length > 14 ? 200 : 250;
  big = Math.max(90, Math.min(big, Math.floor(1380 / (fatorChar * maxWord))));

  // ALTURA DE LINHA: 0.9 sobrepunha as linhas — visto a olho numa capa real
  // ("NA PESQUISA" / "ACADEMICA": o circunflexo do A batia na perna do Q).
  // Em caixa alta acentuada o Anton passa da caixa em cima (acento) e embaixo
  // (Q, J), entao 0.9 nao cabe. 1.06 e o menor valor que separa os dois casos.
  // Titulo com 3+ linhas fica mais alto, entao a fonte encolhe para o bloco
  // continuar cabendo — senao consertar a sobreposicao criaria transbordo.
  const charsPorLinha = Math.max(1, Math.floor(1380 / (fatorChar * big)));
  const linhas = Math.ceil((main + ' ' + accent).trim().length / charsPorLinha);
  if (linhas >= 3) big = Math.max(90, Math.floor(big * 0.86));
  // Em CJK, com o bloco sem espacos, a fonte precisa caber na linha INTEIRA de
  // cada parte (main e destaque), senao o navegador parte o destaque ao meio.
  if (cjk) {
    const maiorParte = Math.max(String(main).length, String(accent).length, 1);
    big = Math.max(80, Math.min(big, Math.floor(1380 / (fatorChar * maiorParte))));
  }
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
.top{position:absolute;top:120px;left:360px;right:360px;text-align:center;z-index:6}
.kick{font-family:'Space Grotesk';font-weight:700;letter-spacing:${kickSpacing}px;font-size:${kickSize}px;color:#eaf2ff;text-transform:uppercase;text-shadow:0 2px 20px rgba(0,0,0,.85)}
.badge{position:absolute;top:116px;right:105px;z-index:6;background:${st.a1};color:#0a0a0a;font-family:'Space Grotesk';font-weight:700;letter-spacing:3px;font-size:31px;text-transform:uppercase;padding:17px 28px;border-radius:14px;transform:rotate(5deg);box-shadow:0 14px 40px ${st.a1}66}
.mid{position:absolute;left:100px;right:100px;bottom:360px;text-align:center;z-index:6}
.bar{width:120px;height:10px;margin:0 auto 40px;border-radius:6px;background:${st.a1};box-shadow:0 0 40px ${st.a1}}
.title{font-family:'Anton';color:#fff;line-height:${/[çÇ,;]/.test(main + accent) ? 1.22 : 1.06};letter-spacing:1px;font-size:${big}px;text-transform:uppercase;text-shadow:0 18px 70px rgba(0,0,0,.85);word-break:keep-all;overflow-wrap:anywhere}
.title b{color:${st.accent};text-shadow:0 0 55px ${st.a1}88}
.sub{margin-top:44px;font-family:'Archivo';font-weight:800;font-size:58px;line-height:1.22;color:#e8eefc;max-width:1320px;margin:44px auto 0;text-shadow:0 4px 24px rgba(0,0,0,.85);word-break:keep-all;overflow-wrap:anywhere}
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

async function generateViralCover(title, subtitle, topic, category, coversDir, idioma, opts) {
  const lang = idioma || 'pt-BR';
  const exigirGancho = !!(opts && opts.exigirGancho);
  _ultimaFalhaFoiImagem = false;
  if (!puppeteer) { log.warn('sem puppeteer'); return null; }
  const st = STYLE[category] || STYLE.default;
  const dir = coversDir || path.join(__dirname, '..', '..', 'data', 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `viral_bg_${Date.now()}.jpg`);
  try {
    // 0. TEXTO ANTES DA IMAGEM.
    //
    // A ordem era o contrario, e custava caro: com a IA de texto fora, a capa
    // saia com o titulo comum, era descartada pelo chamador e a imagem ja tinha
    // sido gerada a toa. Num passe medido, 19 de 20 imagens foram jogadas fora
    // assim. Perguntar primeiro pelo texto — que e o barato — evita pagar pelo
    // caro quando o resultado ja nasceria descartavel.
    let pkPrev = null;
    try {
      const { gerarPackaging } = require('./coverPackaging');
      pkPrev = await gerarPackaging({ titulo: title, subtitulo: subtitle, topico: topic, categoria: category, idioma: lang });
    } catch (e) { log.warn(`packaging indisponivel: ${e.message.slice(0, 70)}`); }
    _ultimoComGancho = !!(pkPrev && pkPrev.titulo);
    if (exigirGancho && !_ultimoComGancho) {
      log.warn('sem gancho de IA — pulando antes de gastar imagem');
      return null;
    }

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
    // GERAR PRIMEIRO, acervo so como reserva.
    //
    // A ordem era o contrario: o acervo tinha 4 imagens por categoria e era
    // consultado antes de gerar. Com ~80 livros por categoria, cada rosto se
    // repetia umas vinte vezes — e categoria fora da lista (educacao, por
    // exemplo) caia no grupo "geral", mais 4 imagens dividindo o resto do
    // catalogo. Gerando por livro, com pessoa variada e semente aleatoria, cada
    // capa tem rosto proprio; o acervo so entra se a geracao falhar.
    // Com exigirImagemUnica (passe de troca de capas), o acervo NAO serve de
    // reserva. Medido em 14/09/2026: 172 de 356 capas do dia cairam no acervo —
    // quase metade com o mesmo rosto — porque o passe e a geracao de livros novos
    // batiam no Pollinations ao mesmo tempo e ele recusava a concorrencia. A
    // recusa passa em segundos: tenta de novo com espera e, se nao vier, desiste
    // do livro (volta depois) em vez de estampar rosto repetido.
    const exigirImagemUnica = !!(opts && opts.exigirImagemUnica);
    const tentativasImagem = exigirImagemUnica ? 3 : 1;
    let gerou = false;
    for (let t = 1; t <= tentativasImagem && !gerou; t++) {
      if (t > 1) await new Promise(r => setTimeout(r, 8000 * t));
      try {
        await generateImage({ prompt: promptDaCapa(category, title, topic), width: 1024, height: 1536, outputPath: tmp });
        gerou = fs.existsSync(tmp) && fs.statSync(tmp).size >= 6000;
      } catch (e) { log.warn(`geracao falhou (tentativa ${t}/${tentativasImagem}): ${e.message.slice(0, 60)}`); }
    }
    if (!gerou && exigirImagemUnica) {
      log.warn('sem imagem propria — pulando em vez de usar rosto repetido do acervo');
      _ultimaFalhaFoiImagem = true;
      return null;
    }
    if (!gerou) {
      const doPool = escolherDoPool(category);
      if (doPool) {
        fs.copyFileSync(doPool, tmp);
        log.info(`fundo do acervo Flow (reserva): ${path.basename(doPool)}`);
      }
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 6000) throw new Error('imagem vazia/falhou');
    const imgB64 = fs.readFileSync(tmp).toString('base64');

    // 2. embalagem VIRAL (dor + promessa) e composição HTML premium
    //
    // O texto padrao era o titulo do e-book + kicker fixo "Metodo Pratico" —
    // embalagem sem angulo, que o playbook viral do GENIA descarta de saida.
    // Aqui o LLM escreve mirando a DOR, e a tecnica de gancho vem de um bandit
    // que aprende com o resultado. Se a IA falhar, cai no texto de antes: capa
    // com titulo comum e melhor que pipeline parado.
    const pk = pkPrev;   // ja pedido antes da imagem (ver etapa 0)

    const html = coverHTML({
      title:    pk ? pk.titulo    : title,
      subtitle: pk ? pk.subtitulo : subtitle,
      kicker:   pk ? pk.kicker    : badgeKicker(topic, lang),
      badge:    pk && pk.badge ? pk.badge : badgeFor(subtitle, topic, lang),
      st, imgB64,
    });
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
function badgeKicker(topic, idioma) {
  return rotulos(idioma).kicker;
}

let _ultimoComGancho = false;
let _ultimaFalhaFoiImagem = false;
/** A ultima capa foi pulada por falta de imagem propria (e nao de gancho)? */
function ultimaFalhaFoiImagem() { return _ultimaFalhaFoiImagem; }
/** A ULTIMA capa gerada saiu com gancho de IA? (false = titulo comum) */
function ultimoTeveGancho() { return _ultimoComGancho; }

module.exports = { generateViralCover, STYLE, ultimoTeveGancho, ultimaFalhaFoiImagem };
