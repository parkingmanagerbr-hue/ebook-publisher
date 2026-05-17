#!/usr/bin/env node
/**
 * capture-sessions-puppeteer.js
 *
 * Abre um browser VISÍVEL para cada plataforma, aguarda o login,
 * e captura TODOS os cookies (incluindo HttpOnly) via page.cookies().
 *
 * Uso: node scripts/capture-sessions-puppeteer.js [platform]
 *   node scripts/capture-sessions-puppeteer.js           → todas
 *   node scripts/capture-sessions-puppeteer.js hotmart
 *   node scripts/capture-sessions-puppeteer.js cakto
 *   node scripts/capture-sessions-puppeteer.js amazon
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESS_DIR = path.join(__dirname, '../data/sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const targetPlatform = process.argv[2]?.toLowerCase() || null;

const ALL_PLATFORMS = {
  hotmart: {
    label: 'HOTMART',
    loginUrl: 'https://app-vlc.hotmart.com',
    testUrl:  'https://app-vlc.hotmart.com/products',
    loginCheck: url => url.includes('/login') || url.includes('sso.hotmart'),
  },
  cakto: {
    label: 'CAKTO',
    loginUrl: 'https://app.cakto.com.br',
    testUrl:  'https://app.cakto.com.br/dashboard',
    loginCheck: url => url.includes('/login') || url.includes('/auth'),
  },
  amazon: {
    label: 'AMAZON KDP',
    loginUrl: 'https://kdp.amazon.com/pt_BR/bookshelf',
    testUrl:  'https://kdp.amazon.com/pt_BR/bookshelf',
    loginCheck: url => url.includes('signin') || url.includes('ap/signin'),
  },
};

const PLATFORMS = targetPlatform
  ? (ALL_PLATFORMS[targetPlatform] ? { [targetPlatform]: ALL_PLATFORMS[targetPlatform] } : ALL_PLATFORMS)
  : ALL_PLATFORMS;

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

async function capturePlatform(platformKey, config) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  📋 Capturando sessão: ${config.label}`);
  console.log(`${'═'.repeat(60)}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const page = await browser.newPage();

  // Disfarçar automação
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log(`\n🌐 Abrindo ${config.label}...`);
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const currentUrl = page.url();
  const needsLogin = config.loginCheck(currentUrl);

  if (needsLogin) {
    console.log(`\n⚠️  Faça login no ${config.label} na janela do browser que abriu.`);
    console.log(`   Após fazer login e chegar no painel principal,`);
  } else {
    console.log(`\n✅ Já logado no ${config.label}!`);
  }

  await ask(`   Pressione ENTER quando estiver na página principal (após login)... `);

  // Navegar para URL autenticada para confirmar
  try {
    await page.goto(config.testUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) {
    console.log('   (timeout na navegação — capturando assim mesmo)');
  }

  // Capturar TODOS os cookies (incluindo HttpOnly)
  const cookies = await page.cookies();

  // Capturar localStorage
  let localStorage = {};
  try {
    localStorage = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        d[k] = window.localStorage.getItem(k);
      }
      return d;
    });
  } catch (e) {}

  // Capturar sessionStorage
  let sessionStorage = {};
  try {
    sessionStorage = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        d[k] = window.sessionStorage.getItem(k);
      }
      return d;
    });
  } catch (e) {}

  const finalUrl = page.url();

  // Verificar se está logado
  if (config.loginCheck(finalUrl)) {
    console.log(`\n❌ Parece que não está logado (URL: ${finalUrl})`);
    const retry = await ask('   Tentar capturar mesmo assim? (s/N): ');
    if (retry.toLowerCase() !== 's') {
      await browser.close();
      return false;
    }
  }

  await browser.close();

  const session = {
    platform: platformKey,
    url: finalUrl,
    cookies,
    localStorage,
    sessionStorage,
    savedAt: Date.now(),
    savedAtHuman: new Date().toLocaleString('pt-BR'),
    cookieCount: cookies.length,
    capturedVia: 'puppeteer-headful',
  };

  const sessionFile = path.join(SESS_DIR, `${platformKey}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

  const httpOnlyCount = cookies.filter(c => c.httpOnly).length;
  console.log(`\n✅ ${config.label} salvo!`);
  console.log(`   📊 ${cookies.length} cookies (${httpOnlyCount} HttpOnly), ${Object.keys(localStorage).length} localStorage`);
  console.log(`   💾 ${sessionFile}`);

  return true;
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  CAPTURA DE SESSÕES — Puppeteer (inclui HttpOnly cookies)');
  console.log('═'.repeat(60));
  console.log('\nEste script abre um browser real para cada plataforma.');
  console.log('Faça login manualmente se necessário e pressione ENTER.\n');

  const results = {};

  for (const [key, config] of Object.entries(PLATFORMS)) {
    try {
      results[key] = await capturePlatform(key, config);
    } catch (e) {
      console.error(`❌ Erro ao capturar ${config.label}: ${e.message}`);
      results[key] = false;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  console.log('═'.repeat(60));
  for (const [key, ok] of Object.entries(results)) {
    const label = ALL_PLATFORMS[key]?.label || key;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  }

  const allOk = Object.values(results).every(Boolean);
  if (allOk) {
    console.log('\n🎉 Todas as sessões capturadas com sucesso!');
    console.log('\nPróximo passo — enviar para o VPS:');
    console.log('  node scripts/sync-sessions-to-vps.js');
  } else {
    console.log('\n⚠️  Algumas sessões falharam. Execute novamente para as plataformas com erro.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
