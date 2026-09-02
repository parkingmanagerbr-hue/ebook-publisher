'use strict';
// publish_one.js — completa pricing (70% + preço) e PUBLICA um rascunho KDP via Chrome real.
// uso: node publish_one.js <ASIN> [precoUSD]
let puppeteer; try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = require('puppeteer-core'); }
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ASIN = process.argv[2];
const PRICE = process.argv[3] || '4.99';
const DRY = process.env.DRY === '1';

(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://localhost:9223', defaultViewport: null });
  // fecha abas de title-setup orfas (evita confusao de aba/valores perdidos)
  for (const pg of await b.pages()) { if (/title-setup\/kindle/.test(pg.url())) { try { await pg.close(); } catch (_) {} } }
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 1000 });
  await p.goto('https://kdp.amazon.com/pt_BR/title-setup/kindle/' + ASIN + '/pricing', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(5000);
  if (/\/ap\/signin/i.test(p.url())) { console.log('DESLOGADO'); await b.disconnect(); process.exit(2); }

  // 1. KDP Select: deixar desmarcado (sem exclusividade). 2. royalty 70%
  const roy = await p.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type=radio]')];
    for (const r of radios) { const l = r.closest('label') || document.querySelector('label[for="' + r.id + '"]'); if (l && /70%/.test(l.textContent || '')) { if (!r.checked) r.click(); return true; } }
    return false;
  });
  console.log('royalty 70%:', roy);
  await sleep(3000);

  // 3. preço por marketplace (moeda local, faixa 70%). Valores GENIA §19.5 (já publicaram).
  // IMPORTANTE: o parser do campo usa PONTO decimal (apesar do rótulo pt-BR "0,00"). Vírgula é rejeitada.
  const PRICES = { US: String(PRICE), UK: '3.99', DE: '4.49', FR: '4.49', ES: '4.49', IT: '4.49', NL: '4.49', JP: '750', CA: '6.49', MX: '99', AU: '7.99', IN: '249', BR: '14.99' };
  let filled = 0;
  for (const [mk, val] of Object.entries(PRICES)) {
    const h = await p.evaluateHandle((m) => [...document.querySelectorAll('input')].find(i => (i.name || '').includes('[' + m + '][price_vat_inclusive]') && i.type === 'text') || null, mk);
    const el = h.asElement();
    if (!el) continue;
    try { await el.click({ clickCount: 3 }); await p.keyboard.press('Backspace'); await el.type(val, { delay: 35 }); await p.keyboard.press('Tab'); filled++; } catch (_) {}
    await sleep(400);
  }
  await sleep(3000);
  const usVal = await p.evaluate(() => { const i = [...document.querySelectorAll('input')].find(x => /\[US\]\[price_vat_inclusive\]/i.test(x.name || '')); return i ? i.value : '?'; });
  console.log('preços preenchidos:', filled, '| US =', usVal);
  await sleep(2000);

  // erros de elegibilidade?
  const errs = await p.evaluate(() => [...document.querySelectorAll('[class*=error],.a-alert-content')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 110 && /royalt|preço|price|elegív|eligib|inválid|interval/i.test(t)).slice(0, 4));
  if (errs.length) console.log('ERROS:', JSON.stringify(errs));

  // marca os termos/confirmações se houver (checkbox obrigatório de direitos)
  await p.evaluate(() => { document.querySelectorAll('input[type=checkbox]').forEach(c => { const l = c.closest('label'); const t = l ? l.textContent : ''; if (/confirmo|tenho os direitos|agree|concordo|terms/i.test(t) && !c.checked) c.click(); }); });
  await sleep(1000);
  await p.screenshot({ path: path.join(__dirname, '..', 'data', 'kdp_publish_' + ASIN + '.png'), fullPage: false });

  if (DRY) { console.log('DRY-RUN: não publiquei. Veja data/kdp_publish_' + ASIN + '.png'); await b.disconnect(); process.exit(0); }

  // 4. PUBLICAR
  const pub = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button,a,input[type=submit]')].find(x => /publicar seu ebook|publish your.*kindle/i.test((x.textContent || x.value || '')) && !x.disabled);
    if (b) { b.click(); return (b.textContent || b.value).trim().slice(0, 40); }
    return null;
  });
  console.log('publicar clicado:', pub);
  await sleep(10000);
  const after = await p.evaluate(() => ({ url: location.href, txt: (document.body.innerText || '').slice(0, 300) }));
  const ok = /bookshelf|em revis|in review|publicad|publishing|enviado para public/i.test(after.url + after.txt);
  await p.screenshot({ path: path.join(__dirname, '..', 'data', 'kdp_after_publish_' + ASIN + '.png'), fullPage: false });
  console.log('RESULTADO:', ok ? 'PUBLICADO ✓ (' + after.url.slice(0, 50) + ')' : 'incerto — ver screenshot. url=' + after.url.slice(0, 55));
  await b.disconnect();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
