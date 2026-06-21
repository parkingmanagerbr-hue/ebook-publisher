'use strict';
// fix_kdp_covers_live.js — conserta capa dos rascunhos KDP dirigindo o Chrome REAL (porta 9223),
// casando a capa pelo nome do PDF do manuscrito. Salva como RASCUNHO (nao publica). Resumivel.
let puppeteer; try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = require('puppeteer-core'); }
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '9223';
const ROOT = path.join(__dirname, '..');
const PROG = path.join(ROOT, 'data', 'kdp_cover_progress.json');
const DRAFTS = path.join(ROOT, 'data', 'kdp_drafts.json');
const TMP = path.join(ROOT, 'data', 'kdp_covers_tmp');
fs.mkdirSync(TMP, { recursive: true });

function loadProg() { try { return JSON.parse(fs.readFileSync(PROG, 'utf8')); } catch { return { done: [], failed: [] }; } }
function saveProg(p) { fs.writeFileSync(PROG, JSON.stringify(p, null, 2)); }

const PCM = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pdf_cover_map.json'), 'utf8'));

// busca a capa JPEG (do VPS) que casa com o PDF do manuscrito; copia local. Retorna caminho local ou null.
function fetchCoverForPdf(pdfName) {
  try {
    const jpg = PCM[pdfName];           // caminho do _kdp.jpg no VPS (do mapa)
    if (!jpg) return null;
    const base = path.basename(jpg);
    const local = path.join(TMP, base);
    if (fs.existsSync(local) && fs.statSync(local).size > 0) return local;
    execSync(`ssh vps "docker cp platform-ebook-publisher-1:'${jpg}' /tmp/'${base}'"`, { timeout: 30000 });
    execSync(`scp vps:/tmp/'${base}' "${local}"`, { timeout: 30000 });
    return fs.existsSync(local) && fs.statSync(local).size > 0 ? local : null;
  } catch (e) { console.log('   fetchCover erro:', e.message.slice(0, 60)); return null; }
}

async function fixOne(page, asin) {
  await page.goto('https://kdp.amazon.com/pt_BR/title-setup/kindle/' + asin + '/content', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (/\/ap\/signin/i.test(page.url())) return { status: 'DESLOGADO' };

  // nome do PDF do manuscrito (do texto de sucesso)
  const pdfName = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/(ebook_\d+\.pdf)/i);
    return m ? m[1] : null;
  });
  if (!pdfName) return { status: 'sem_pdf' };

  const cover = fetchCoverForPdf(pdfName);
  if (!cover) return { status: 'sem_capa', pdf: pdfName };

  // sobe no input de capa correto
  const input = await page.$('#data-assets-cover-file-upload-AjaxInput');
  if (!input) return { status: 'sem_input_capa', pdf: pdfName };
  await input.uploadFile(cover);

  // aguarda "Upload da capa bem-sucedido!"
  let ok = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2500);
    const st = await page.evaluate(() => {
      const t = document.body.innerText || '';
      if (/Upload da capa bem-sucedido|Cover upload successful/i.test(t)) return 'ok';
      if (/Ocorreu um erro|error/i.test(t) && /capa|cover/i.test(t)) return 'erro';
      return 'wait';
    });
    if (st === 'ok') { ok = true; break; }
    if (st === 'erro') return { status: 'erro_upload', pdf: pdfName };
  }
  if (!ok) return { status: 'timeout_upload', pdf: pdfName };

  // marca o checkbox de confirmacao
  await page.evaluate(() => {
    const alert = [...document.querySelectorAll('div,section')].find(d => /parece que você fez o upload|confirmo que minhas respostas/i.test(d.textContent || ''));
    const cb = (alert && alert.querySelector('input[type="checkbox"]')) || [...document.querySelectorAll('input[type="checkbox"]')].find(c => { const l = c.closest('label'); return l && /confirmo que minhas respostas/i.test(l.textContent || ''); });
    if (cb && !cb.checked) cb.click();
  });
  await sleep(1500);

  // salvar como rascunho
  const saved = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')].find(x => /salvar como rascunho|save as draft/i.test((x.textContent || '') + (x.value || '')));
    if (b) { b.click(); return true; } return false;
  });
  await sleep(7000);
  return { status: 'OK', pdf: pdfName, saved };
}

(async () => {
  const drafts = JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  const prog = loadProg();
  const b = await puppeteer.connect({ browserURL: 'http://localhost:' + PORT, defaultViewport: null });
  const page = await b.newPage();
  let fixed = 0;
  for (const d of drafts) {
    if (prog.done.includes(d.asin)) { continue; }
    process.stdout.write('• ' + d.asin + ' ... ');
    let r;
    try { r = await fixOne(page, d.asin); } catch (e) { r = { status: 'ERR:' + e.message.slice(0, 40) }; }
    console.log(r.status + (r.pdf ? ' [' + r.pdf + ']' : ''));
    if (r.status === 'DESLOGADO') { console.log('\\n>> SESSAO CAIU. Relogue no Chrome e rode de novo (retoma).'); break; }
    if (r.status === 'OK') { prog.done.push(d.asin); fixed++; saveProg(prog); }
    else { prog.failed = prog.failed.filter(f => f.asin !== d.asin); prog.failed.push({ asin: d.asin, reason: r.status }); saveProg(prog); }
    await sleep(1500);
  }
  console.log('\\n=== consertadas nesta rodada: ' + fixed + ' | total done: ' + prog.done.length + '/' + drafts.length + ' ===');
  b.disconnect();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
