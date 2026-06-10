/* eslint-disable */
// preview_design.js — gera hub + página com o novo design e tira screenshots.
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const path = require('path');
const { buildHubHtml, buildLocalizedPage } = require('../src/agents/landingPageAgent');
const D = require('better-sqlite3');

(async () => {
  const root = path.join(__dirname, '..');
  const db = new D(path.join(root, 'data/db/ebooks.db'));
  const prods = db.prepare("SELECT * FROM affiliate_products WHERE platform='amazon' AND affiliate_link IS NOT NULL AND image_url IS NOT NULL LIMIT 12").all();
  const items = prods.map(p => ({ slug: 'x', name: p.product_name, id: p.id, image: p.image_url, price: p.price || 0, category: p.category || '', emoji: '🛍️' }));
  fs.writeFileSync(path.join(root, 'hub_preview.html'), buildHubHtml(items, 'pt', ['pt', 'en', 'es']));
  const tracked = { ...prods[0], affiliate_link: 'https://publisher.veloxisit.com.br/api/go/' + prods[0].id };
  fs.writeFileSync(path.join(root, 'page_preview.html'), buildLocalizedPage(tracked, 'pt', 'https://ofertas.veloxisit.com.br/x/', '/'));

  const pup = require('puppeteer');
  const b = await pup.launch({ headless: 'new', executablePath: process.env.CHROME_EXECUTABLE, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  await p.goto('file:///' + path.join(root, 'hub_preview.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 40000 }).catch(() => {});
  await p.screenshot({ path: path.join(root, 'hub_preview.png') });
  await p.goto('file:///' + path.join(root, 'page_preview.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0', timeout: 40000 }).catch(() => {});
  await p.screenshot({ path: path.join(root, 'page_preview.png') });
  await b.close();
  console.log('screenshots OK');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
