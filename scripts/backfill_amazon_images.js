/* eslint-disable */
// backfill_amazon_images.js — busca a imagem principal dos produtos Amazon sem image_url
// visitando a página do produto (og:image / #landingImage).
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hires = u => (u || '').replace(/\._[^.]+_\./, '.');

(async () => {
  const db = new D(path.join(__dirname, '../data/db/ebooks.db'));
  const missing = db.prepare("SELECT id, product_id FROM affiliate_products WHERE platform='amazon' AND (image_url IS NULL OR image_url='')").all();
  console.log('sem imagem:', missing.length);
  if (!missing.length) process.exit(0);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  // sessão amazon se existir (evita captcha)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/sessions/amazon.json'), 'utf8'));
    const client = await page.target().createCDPSession();
    await client.send('Network.setCookies', { cookies: (s.cookies || []).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly, expires: c.expires > 0 ? c.expires : undefined })) });
  } catch (_) {}

  let ok = 0;
  const upd = db.prepare('UPDATE affiliate_products SET image_url=? WHERE id=?');
  for (const m of missing) {
    if (!/^[A-Z0-9]{10}$/.test(m.product_id)) continue;
    try {
      await page.goto('https://www.amazon.com.br/dp/' + m.product_id, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1800 + Math.floor(Math.random() * 1200));
      const img = await page.evaluate(() => {
        const og = document.querySelector('meta[property="og:image"]');
        if (og && og.content) return og.content;
        const li = document.querySelector('#landingImage, #imgBlkFront, .a-dynamic-image');
        return li ? (li.getAttribute('data-old-hires') || li.src) : null;
      });
      if (img && /^https?:/.test(img)) { upd.run(hires(img), m.id); ok++; console.log('ok', m.product_id); }
      else console.log('--', m.product_id, '(sem img)');
    } catch (e) { console.log('err', m.product_id, e.message.slice(0, 40)); }
  }
  await browser.close();
  const r = db.prepare("SELECT count(*) t, sum(image_url IS NOT NULL) i FROM affiliate_products WHERE platform='amazon'").get();
  console.log('BACKFILL DONE: +' + ok + ' | amazon ' + r.i + '/' + r.t + ' com imagem');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
