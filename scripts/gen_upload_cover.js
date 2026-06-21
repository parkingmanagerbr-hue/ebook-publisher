'use strict';
// gera uma capa (HTML->JPEG 1600x2560) e sobe no rascunho KDP via Chrome real (9223).
// uso: node gen_upload_cover.js <ASIN> "<titulo>" "<subtitulo>"
let puppeteer; try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = require('puppeteer-core'); }
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ASIN = process.argv[2];
const TITLE = process.argv[3] || '';
const SUB = process.argv[4] || '';
const TMP = path.join(__dirname, '..', 'data', 'kdp_covers_tmp');
fs.mkdirSync(TMP, { recursive: true });

function coverHtml(title, sub) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1600px;height:2560px}
.c{width:1600px;height:2560px;background:linear-gradient(160deg,#0b0b0f 0%,#15151c 55%,#0b0b0f 100%);position:relative;font-family:Georgia,'Times New Roman',serif;overflow:hidden}
.sh{position:absolute;top:-160px;left:-160px;width:760px;height:560px;background:#e23744;transform:rotate(-12deg);opacity:.92}
.sh2{position:absolute;bottom:-220px;right:-160px;width:620px;height:520px;background:radial-gradient(circle,#e23744 0%,rgba(226,55,68,0) 70%);opacity:.5}
.badge{position:absolute;top:60px;right:70px;background:#e23744;color:#fff;font-family:Arial,sans-serif;font-weight:800;font-size:34px;letter-spacing:2px;padding:14px 26px;border-radius:8px;transform:rotate(6deg)}
.mid{position:absolute;top:34%;left:0;right:0;padding:0 120px;text-align:center}
.t{color:#fff;font-size:120px;line-height:1.1;font-weight:700;text-shadow:0 4px 30px rgba(226,55,68,.5)}
.s{color:#f2a3aa;font-family:Arial,sans-serif;font-weight:700;font-size:46px;line-height:1.35;margin-top:60px}
.feat{position:absolute;bottom:330px;left:0;right:0;text-align:center;color:#e8a;font-family:Arial,sans-serif;font-size:38px;line-height:2}
.feat b{color:#e23744}
.ed{position:absolute;bottom:130px;left:0;right:0;text-align:center;color:#cfcfd6;font-family:Arial,sans-serif;font-size:40px;letter-spacing:1px}
</style></head><body><div class="c">
<div class="sh"></div><div class="sh2"></div><div class="badge">BESTSELLER</div>
<div class="mid"><div class="t">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>${sub ? `<div class="s">${sub.replace(/</g,'&lt;')}</div>` : ''}</div>
<div class="feat"><b>✔</b> Guia prático e completo<br><b>✔</b> Passo a passo aplicável<br><b>✔</b> Resultados reais</div>
<div class="ed">Veloxis Editorial</div>
</div></body></html>`;
}

async function uploadToKdp(jpg) {
  const b = await puppeteer.connect({ browserURL: 'http://localhost:9223', defaultViewport: null });
  const p = await b.newPage();
  await p.goto('https://kdp.amazon.com/pt_BR/title-setup/kindle/' + ASIN + '/content', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (/\/ap\/signin/i.test(p.url())) { console.log('DESLOGADO'); b.disconnect(); return false; }
  const input = await p.$('#data-assets-cover-file-upload-AjaxInput');
  if (!input) { console.log('sem input de capa'); b.disconnect(); return false; }
  await input.uploadFile(jpg);
  let ok = false;
  for (let i = 0; i < 30; i++) { await sleep(2500); const s = await p.evaluate(() => /Upload da capa bem-sucedido/i.test(document.body.innerText || '') ? 'ok' : 'w'); if (s === 'ok') { ok = true; break; } }
  await p.evaluate(() => { const cb = [...document.querySelectorAll('input[type="checkbox"]')].find(c => { const l = c.closest('label'); return l && /confirmo que minhas respostas/i.test(l.textContent || ''); }) || ([...document.querySelectorAll('div,section')].find(d => /parece que você fez o upload/i.test(d.textContent || '')) || {}).querySelector?.('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); });
  await sleep(1200);
  await p.evaluate(() => { const x = [...document.querySelectorAll('button,a')].find(e => /salvar como rascunho|save as draft/i.test(e.textContent || '')); if (x) x.click(); });
  await sleep(6000);
  b.disconnect();
  return ok;
}

(async () => {
  // render HTML -> JPEG 1600x2560 via Chrome local
  const lb = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
  const lp = await lb.newPage();
  await lp.setViewport({ width: 1600, height: 2560, deviceScaleFactor: 1 });
  await lp.setContent(coverHtml(TITLE, SUB), { waitUntil: 'networkidle0' });
  await sleep(500);
  const jpg = path.join(TMP, ASIN + '_gen.jpg');
  await lp.screenshot({ path: jpg, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1600, height: 2560 } });
  await lb.close();
  console.log('capa gerada:', jpg, fs.statSync(jpg).size, 'bytes');
  const ok = await uploadToKdp(jpg);
  console.log('RESULTADO:', ok ? 'CAPA SUBIU ✓' : 'falhou');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
