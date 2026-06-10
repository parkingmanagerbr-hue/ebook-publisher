/* eslint-disable */
require('dotenv').config({ path: __dirname + '/../.env' });
const pup = require('puppeteer');
(async () => {
  const b = await pup.launch({ headless: 'new', executablePath: process.env.CHROME_EXECUTABLE, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 950 });
  await p.goto('https://ofertas.veloxisit.com.br', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));
  await p.screenshot({ path: __dirname + '/../live_hub.png' });
  await b.close();
  console.log('shot OK');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
