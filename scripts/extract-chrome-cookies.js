#!/usr/bin/env node
/**
 * extract-chrome-cookies.js
 *
 * Lê cookies diretamente do Chrome (incluindo HttpOnly) usando DPAPI.
 * Combina com localStorage capturado anteriormente e salva sessões atualizadas.
 *
 * Uso: node scripts/extract-chrome-cookies.js
 */
const chromeCookies = require('chrome-cookies-secure');
const path = require('path');
const fs = require('fs');

const SESS_DIR = path.join(__dirname, '../data/sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const PLATFORMS = {
  hotmart: {
    label: 'HOTMART',
    urls: [
      'https://app-vlc.hotmart.com/',
      'https://sso.hotmart.com/',
    ],
    testUrl: 'https://app-vlc.hotmart.com/products',
  },
  cakto: {
    label: 'CAKTO',
    urls: [
      'https://app.cakto.com.br/',
      'https://sso.cakto.com.br/',
    ],
    testUrl: 'https://app.cakto.com.br/dashboard',
  },
  amazon: {
    label: 'AMAZON KDP',
    urls: [
      'https://kdp.amazon.com/',
      'https://www.amazon.com.br/',
      'https://www.amazon.com/',
    ],
    testUrl: 'https://kdp.amazon.com/pt_BR/bookshelf',
  },
};

function getCookiesForUrl(url) {
  return new Promise((resolve, reject) => {
    chromeCookies.getCookies(url, 'puppeteer', (err, cookies) => {
      if (err) {
        console.warn(`  ⚠️  ${url}: ${err.message}`);
        resolve([]);
      } else {
        resolve(cookies || []);
      }
    });
  });
}

async function extractPlatform(platformKey, config) {
  console.log(`\n── ${config.label} ──────────────────────────────────────`);

  // Coletar cookies de todas as URLs da plataforma
  const allCookies = [];
  const seenNames = new Set();

  for (const url of config.urls) {
    const cookies = await getCookiesForUrl(url);
    for (const c of cookies) {
      const key = `${c.name}|${c.domain}`;
      if (!seenNames.has(key)) {
        seenNames.add(key);
        allCookies.push(c);
      }
    }
  }

  const httpOnlyCount = allCookies.filter(c => c.httpOnly).length;
  console.log(`  🍪 ${allCookies.length} cookies (${httpOnlyCount} HttpOnly)`);

  if (allCookies.length === 0) {
    console.log(`  ⚠️  Nenhum cookie encontrado — verifique se está logado no Chrome`);
    return false;
  }

  // Carregar sessão anterior para preservar localStorage
  const sessionFile = path.join(SESS_DIR, `${platformKey}.json`);
  let previousSession = {};
  if (fs.existsSync(sessionFile)) {
    try {
      previousSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    } catch (e) {}
  }

  const session = {
    platform: platformKey,
    url: config.testUrl,
    cookies: allCookies,
    localStorage:    previousSession.localStorage    || {},
    sessionStorage:  previousSession.sessionStorage  || {},
    savedAt:         Date.now(),
    savedAtHuman:    new Date().toLocaleString('pt-BR'),
    cookieCount:     allCookies.length,
    capturedVia:     'chrome-cookies-secure (DPAPI)',
  };

  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  console.log(`  ✅ Salvo: ${sessionFile}`);

  // Listar cookies importantes
  const importantNames = ['session', 'auth', 'token', 'sid', 'at-', 'tgt', 'access', 'refresh', 'sso', 'cas'];
  const important = allCookies.filter(c =>
    importantNames.some(n => c.name.toLowerCase().includes(n))
  );
  if (important.length > 0) {
    console.log(`  🔑 Cookies auth: ${important.map(c => c.name).join(', ')}`);
  }

  return true;
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  EXTRAÇÃO DE COOKIES DO CHROME (incluindo HttpOnly)');
  console.log('═'.repeat(60));
  console.log('\n⚠️  Certifique-se de estar logado no Chrome em todas as plataformas.\n');

  const results = {};
  for (const [key, config] of Object.entries(PLATFORMS)) {
    results[key] = await extractPlatform(key, config);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  for (const [key, ok] of Object.entries(results)) {
    console.log(`  ${ok ? '✅' : '❌'} ${PLATFORMS[key].label}`);
  }

  const anyOk = Object.values(results).some(Boolean);
  if (anyOk) {
    console.log('\n📤 Enviando para VPS...');
    const { execSync } = require('child_process');
    try {
      execSync(
        `scp "${SESS_DIR}/hotmart.json" "${SESS_DIR}/cakto.json" "${SESS_DIR}/amazon.json" ` +
        `vps:/opt/platform/data/ebook-publisher/db/sessions/`,
        { stdio: 'inherit' }
      );
      console.log('✅ Sessões enviadas!\n');

      console.log('🔄 Reiniciando ebook-publisher...');
      execSync(
        'ssh vps "cd /opt/platform && docker compose -f docker-compose.production.yml restart ebook-publisher"',
        { stdio: 'inherit' }
      );
      console.log('✅ Reiniciado!\n');
    } catch (e) {
      console.error('❌ Erro ao enviar/reiniciar:', e.message);
      console.log('\nEnvie manualmente:');
      console.log(`  scp data/sessions/*.json vps:/opt/platform/data/ebook-publisher/db/sessions/`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
