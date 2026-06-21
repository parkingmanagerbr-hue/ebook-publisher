'use strict';
let puppeteer; try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = require('puppeteer-core'); }
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '9223';

async function collectAsinsOnPage(p) {
  return p.evaluate(() => {
    const set = new Set();
    document.querySelectorAll('a[href*="title-setup/kindle/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/title-setup\/kindle\/([A-Z0-9]{8,})/);
      if (m) set.add(m[1]);
    });
    return [...set];
  });
}

(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://localhost:' + PORT, defaultViewport: null });
  const p = await b.newPage();
  await p.goto('https://kdp.amazon.com/pt_BR/bookshelf', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(5000);
  if (/\/ap\/signin/i.test(p.url())) { console.log('DESLOGADO'); await b.disconnect(); process.exit(2); }

  // coleta ASINs pagina por pagina clicando nos numeros de pagina
  const asins = new Set();
  (await collectAsinsOnPage(p)).forEach(a => asins.add(a));
  for (let pageNum = 2; pageNum <= 6; pageNum++) {
    const clicked = await p.evaluate((n) => {
      const els = [...document.querySelectorAll('button,a,li,span')];
      const b = els.find(x => (x.textContent || '').trim() === String(n) && x.getBoundingClientRect().width > 0);
      if (b) { (b.closest('button,a') || b).click(); return true; }
      return false;
    }, pageNum);
    if (!clicked) break;
    await sleep(3500);
    (await collectAsinsOnPage(p)).forEach(a => asins.add(a));
  }
  const list = [...asins];
  console.log('ASINs coletados:', list.length);

  // titulo de cada um pela pagina de detalhes (campo de titulo)
  const books = [];
  for (const asin of list) {
    try {
      await p.goto('https://kdp.amazon.com/pt_BR/title-setup/kindle/' + asin + '/details', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2500);
      const info = await p.evaluate(() => {
        const ti = document.querySelector('#data-print-book-title input, input[name*="title" i], #title input, [id*="title"] input');
        let title = ti ? ti.value : '';
        if (!title) { const h = document.querySelector('h1'); title = h ? h.textContent.trim() : ''; }
        const lang = (document.querySelector('[id*="language"] [aria-checked="true"], [name*="language"]:checked') || {}).value || '';
        return { title: (title || '').trim().slice(0, 90), lang };
      });
      books.push({ asin, title: info.title, lang: info.lang });
      console.log('  ', asin, '|', info.title);
    } catch (e) { books.push({ asin, title: '', err: e.message.slice(0, 30) }); }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'kdp_drafts.json'), JSON.stringify(books, null, 2));
  console.log('SALVO data/kdp_drafts.json —', books.length, 'livros (', books.filter(x => x.title).length, 'com titulo )');
  await b.disconnect();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
