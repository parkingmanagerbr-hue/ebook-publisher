'use strict';
// fix_kdp_cover.js — sobe capa JPEG num rascunho KDP, marca confirmação, SALVA COMO RASCUNHO
// (não publica) e verifica o preview. Uso: node fix_kdp_cover.js <ASIN> <coverPng|coverJpg>
const puppeteer = require('/app/node_modules/puppeteer');
const fs = require('fs');
const { execFileSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const ASIN = process.argv[2];
const SRC  = process.argv[3];

function toJpeg(src) {
  if (!src || !fs.existsSync(src)) return null;
  if (/\.(jpe?g)$/i.test(src)) return src;
  const jpg = src.replace(/\.[^.]+$/, '') + '_kdp.jpg';
  if (fs.existsSync(jpg) && fs.statSync(jpg).size > 0) return jpg;
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf',
      'scale=1600:2560:force_original_aspect_ratio=decrease,pad=1600:2560:(ow-iw)/2:(oh-ih)/2:black', '-q:v', '2', jpg]);
    return fs.existsSync(jpg) ? jpg : null;
  } catch (e) { return null; }
}

async function injectSession(page, s) {
  if (s.localStorage) await page.evaluateOnNewDocument((ls) => { Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }); }, s.localStorage);
  const cl = await page.target().createCDPSession();
  await cl.send('Network.setCookies', { cookies: s.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly, expires: c.expires > 0 ? c.expires : undefined })) });
}

// clica o botão de upload de capa e aceita o arquivo
async function uploadCover(page, jpg) {
  // tenta via file chooser (clicando o botão da seção de capa)
  try {
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8000 }),
      page.evaluate(() => {
        const texts = ['carregar uma imagem de capa', 'carregar imagem de capa', 'carregar capa',
          'fazer upload de uma capa', 'fazer upload de imagem', 'upload a cover', 'upload cover',
          'selecionar arquivo de capa', 'escolher capa'];
        const btns = [...document.querySelectorAll('button,a,[role="button"],span.a-button-text,label')];
        for (const t of texts) {
          const b = btns.find(el => { const tx = (el.textContent || '').trim().toLowerCase(); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && tx.includes(t) && !tx.includes('creator') && !tx.includes('criador'); });
          if (b) { b.click(); return 'btn:' + b.textContent.trim().slice(0, 30); }
        }
        return null;
      }),
    ]);
    await chooser.accept([jpg]);
    return 'chooser';
  } catch (e) { /* fallback */ }
  // fallback: setar no input de imagem diretamente
  const inputs = await page.$$('input[type="file"]');
  for (let i = inputs.length - 1; i >= 0; i--) {
    const accept = await page.evaluate(el => el.getAttribute('accept') || '', inputs[i]);
    if (/image|jpeg|jpg|png/i.test(accept) || i === inputs.length - 1) { await inputs[i].uploadFile(jpg); return 'input#' + i; }
  }
  return null;
}

(async () => {
  const jpg = toJpeg(SRC);
  console.log('JPEG:', jpg || 'FALHOU');
  if (!ASIN || !jpg) process.exit(1);
  const s = JSON.parse(fs.readFileSync('/app/data/sessions/amazon.json', 'utf8'));
  const browser = await puppeteer.launch({ headless: true, executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,1000'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto('https://kdp.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await injectSession(page, s);
  await page.goto('https://kdp.amazon.com/pt_BR/title-setup/kindle/' + ASIN + '/content', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  if (/\/ap\/signin/i.test(page.url())) { console.log('DESLOGADO'); await browser.close(); process.exit(2); }

  // scroll pra renderizar a seção de capa
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await sleep(1500);
  const up = await uploadCover(page, jpg);
  console.log('upload via:', up);
  if (!up) { console.log('SEM botão/input de capa'); await browser.close(); process.exit(1); }

  // aguarda processar a capa
  let attached = false;
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    const st = await page.evaluate(() => {
      const cover = [...document.querySelectorAll('img')].find(im => { const w = im.naturalWidth || 0, h = im.naturalHeight || 0; const src = im.src || ''; return (/blob:|data:image|\/images\/[IP]\/|media-amazon/i.test(src) || /cover|capa/i.test((im.alt || '') + im.className)) && w > 120 && h > 150 && h >= w; });
      if (cover) return 'attached';
      const sp = document.querySelector('.a-spinner,[class*="uploading"],[class*="spinner"]');
      return sp ? 'processing' : 'waiting';
    });
    if (i % 3 === 0 || st === 'attached') console.log('  cover:', st);
    if (st === 'attached') { attached = true; break; }
  }

  // marca o checkbox de confirmação ("confirmo que minhas respostas estão corretas")
  const confirmed = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('label, span, div')];
    const lab = labels.find(l => /confirmo que minhas respostas|confirmo que as informa|confirm.*answers.*correct/i.test(l.textContent || ''));
    let cb = null;
    if (lab) cb = lab.querySelector('input[type="checkbox"]') || lab.closest('div,section')?.querySelector('input[type="checkbox"]');
    if (!cb) {
      // checkbox dentro do alerta "Parece que você fez o upload"
      const alert = [...document.querySelectorAll('div,section')].find(d => /parece que você fez o upload|you.*uploaded a new/i.test(d.textContent || ''));
      if (alert) cb = alert.querySelector('input[type="checkbox"]');
    }
    if (cb && !cb.checked) { cb.click(); return true; }
    return cb ? 'already' : 'no-checkbox';
  });
  console.log('confirmação:', confirmed);
  await sleep(1500);

  // SALVAR COMO RASCUNHO (não publicar)
  const saved = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')];
    const b = btns.find(x => /salvar como rascunho|save as draft|salvar rascunho/i.test((x.textContent || '') + (x.value || '')));
    if (b) { b.click(); return 'salvar-rascunho'; }
    const b2 = btns.find(x => /salvar e continuar|save and continue/i.test((x.textContent || '') + (x.value || '')));
    if (b2) { b2.click(); return 'salvar-continuar'; }
    return 'sem-botao-salvar';
  });
  console.log('salvar:', saved);
  await sleep(8000);
  await page.screenshot({ path: '/app/data/logs/fix_cover_' + ASIN + '.png' });
  console.log('RESULTADO:', attached ? 'CAPA COLOU ✓ (salvo:' + saved + ')' : 'capa nao confirmada visualmente (salvo:' + saved + ')');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
