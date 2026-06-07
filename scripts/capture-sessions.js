'use strict';
/**
 * capture-sessions.js
 * Abre janelas visíveis do Puppeteer para login manual.
 * Detecta login automaticamente e salva sessão.
 * Run: node scripts/capture-sessions.js
 */
const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const SESS_DIR = path.resolve(__dirname, '../data/sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const PLATFORMS = [
  {
    key:      'hotmart',
    label:    'HOTMART',
    url:      'https://app.hotmart.com/',
    checkFn:  async (page) => {
      return page.evaluate(() =>
        localStorage.getItem('token') ||
        localStorage.getItem('access_token') ||
        localStorage.getItem('@hotmart:token') || ''
      ).catch(() => '');
    },
    successUrl: /app(-vlc)?\.hotmart\.com\/(products|dashboard)/,
  },
  {
    key:      'cakto',
    label:    'CAKTO',
    url:      'https://app.cakto.com.br/dashboard',
    checkFn:  async (page) => {
      const url = page.url();
      // Logged in if NOT on login page
      if (!url.includes('/login') && url.includes('cakto.com.br')) return 'cakto_session';
      return '';
    },
    successUrl: /app\.cakto\.com\.br\/dashboard/,
  },
];

async function captureSession(platform, browser) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`🔐 ${platform.label} — Faça login na janela que abriu`);
  console.log(`   URL: ${platform.url}`);

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  let attempts = 0;
  while (attempts++ < 200) { // up to 10 min
    await new Promise(r => setTimeout(r, 3000));
    try {
      const token = await platform.checkFn(page);
      if (!token) continue;

      const cookies = await page.cookies();
      const ls = await page.evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      }).catch(() => ({}));

      const session = {
        platform: platform.key,
        url:      page.url(),
        cookies,
        localStorage: ls,
        sessionStorage: {},
        savedAt:      Date.now(),
        savedAtHuman: new Date().toLocaleString('pt-BR'),
        capturedVia:  'capture-sessions.js (Puppeteer manual)',
      };

      const outFile = path.join(SESS_DIR, `${platform.key}.json`);
      fs.writeFileSync(outFile, JSON.stringify(session, null, 2));

      console.log(`\n✅ ${platform.label} — sessão salva!`);
      console.log(`   Arquivo: ${outFile}`);
      console.log(`   Cookies: ${cookies.length} | localStorage: ${Object.keys(ls).length} keys`);

      if (platform.key === 'hotmart') {
        const tgt = cookies.find(c => c.name === 'hmSsoExp' || c.name === 'CASTGC');
        console.log(`   CAS TGT: ${tgt ? '✅ ' + tgt.name : '⚠️  não encontrado (login Google?)'}`);
        const tok = ls['token'] || ls['access_token'];
        if (tok) {
          try {
            const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
            console.log(`   JWT exp: ${new Date(payload.exp * 1000).toLocaleString('pt-BR')}`);
          } catch (_) {}
        }
      }

      await page.close();
      return true;
    } catch (_) {
      // page navigating, retry
    }
  }

  console.log(`❌ ${platform.label} — timeout aguardando login`);
  await page.close();
  return false;
}

(async () => {
  console.log('═'.repeat(50));
  console.log('  CAPTURA DE SESSÕES — GENIA EbookPublisher');
  console.log('═'.repeat(50));
  console.log('\nAbrindo browsers... faça login em cada janela.\n');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  const results = {};
  for (const platform of PLATFORMS) {
    results[platform.key] = await captureSession(platform, browser);
  }

  await browser.close();

  console.log('\n' + '═'.repeat(50));
  console.log('  RESUMO');
  for (const [k, ok] of Object.entries(results)) {
    console.log(`  ${ok ? '✅' : '❌'} ${k}`);
  }

  const captured = Object.entries(results).filter(([, ok]) => ok).map(([k]) => k);
  if (captured.length === 0) {
    console.log('\n❌ Nenhuma sessão capturada.');
    process.exit(1);
  }

  // Upload to VPS
  console.log('\n📤 Enviando para VPS...');
  const { execSync } = require('child_process');
  const files = captured.map(k => `"${path.join(SESS_DIR, k + '.json')}"`).join(' ');
  try {
    execSync(`scp ${files} vps:/opt/platform/data/ebook-publisher/db/sessions/`, { stdio: 'inherit', timeout: 30000 });
    console.log('✅ Sessões enviadas!');

    console.log('\n🔄 Reiniciando container...');
    execSync('ssh vps "docker restart platform-ebook-publisher-1"', { stdio: 'inherit', timeout: 60000 });
    console.log('✅ Container reiniciado! Sistema publicando novamente.\n');
  } catch (e) {
    console.error('❌ Erro no upload:', e.message);
    console.log('\n📋 Envio manual:');
    console.log(`  scp data/sessions/*.json vps:/opt/platform/data/ebook-publisher/db/sessions/`);
    console.log('  ssh vps "docker restart platform-ebook-publisher-1"');
  }
})();
