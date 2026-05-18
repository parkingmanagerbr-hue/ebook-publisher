#!/usr/bin/env node
/**
 * capture-sessions-auto.js  v2
 *
 * Abre browser visível por plataforma e aguarda o usuário completar o login.
 * Detecta autenticação pelo domínio final (não só ausência de /login).
 * Sem input manual necessário — detecta login automaticamente.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SESS_DIR = path.join(__dirname, '../data/sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const targetPlatform = process.argv[2]?.toLowerCase() || null;

const ALL_PLATFORMS = {
  hotmart: {
    label: 'HOTMART',
    loginUrl: 'https://app-vlc.hotmart.com/products',
    // Autenticado = chegou no app real (não em SSO nem Google)
    isAuthenticated: url =>
      (url.includes('app-vlc.hotmart.com') || url.includes('app.hotmart.com')) &&
      !url.includes('sso.hotmart') && !url.includes('accounts.google.com'),
  },
  cakto: {
    label: 'CAKTO',
    loginUrl: 'https://app.cakto.com.br/dashboard',
    // Autenticado = no dashboard (não na página de login)
    isAuthenticated: url =>
      url.includes('app.cakto.com.br') && !url.includes('/login') && !url.includes('sso.cakto'),
  },
  amazon: {
    label: 'AMAZON KDP',
    loginUrl: 'https://kdp.amazon.com/pt_BR/bookshelf',
    isAuthenticated: url =>
      url.includes('kdp.amazon.com') && !url.includes('signin') && !url.includes('ap/signin'),
  },
};

const PLATFORMS = targetPlatform
  ? (ALL_PLATFORMS[targetPlatform] ? { [targetPlatform]: ALL_PLATFORMS[targetPlatform] } : ALL_PLATFORMS)
  : ALL_PLATFORMS;

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntilAuthenticated(page, config, timeoutMs = 180000) {
  const start = Date.now();
  return new Promise(resolve => {
    const interval = setInterval(async () => {
      try {
        const url = page.url();
        if (config.isAuthenticated(url)) {
          clearInterval(interval);
          resolve({ status: 'ok', url });
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve({ status: 'timeout', url });
        } else {
          const elapsed = Math.round((Date.now() - start) / 1000);
          const remaining = Math.round((timeoutMs - (Date.now() - start)) / 1000);
          process.stdout.write(`\r   ⏳ Aguardando login... ${remaining}s restantes (URL: ${url.slice(0, 60)})   `);
        }
      } catch (e) {
        clearInterval(interval);
        resolve({ status: 'error', url: '' });
      }
    }, 2000);
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

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log(`\n🌐 Abrindo ${config.label}...`);
  console.log(`   Se precisar de login, faça agora na janela que abriu.`);
  console.log(`   (aguarda até 3 minutos)\n`);

  try {
    // networkidle2 aguarda redirects JS completarem antes de retornar
    await page.goto(config.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    // timeout de carregamento — continua
  }
  // Pausa extra para redirects JavaScript (auth check pós-SPA load)
  await waitMs(4000);

  // Verificar se já está autenticado (após redirects completos)
  const initialUrl = page.url();
  console.log(`   URL atual: ${initialUrl.slice(0, 70)}`);
  if (config.isAuthenticated(initialUrl)) {
    console.log(`\n✅ Já logado! Aguardando página estabilizar...`);
    await waitMs(2000);
  } else {
    // Aguardar login manual
    const result = await waitUntilAuthenticated(page, config, 180000);
    console.log(); // nova linha após progress
    if (result.status !== 'ok') {
      console.log(`\n❌ Timeout — ${config.label} não autenticado. Pulando.`);
      await browser.close();
      return false;
    }
    console.log(`\n✅ Login detectado! Aguardando carregamento...`);
    await waitMs(3000);
  }

  // Capturar TODOS os cookies da sessão
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
  await browser.close();

  // Verificar cookies de autenticação
  const authNames = ['session', 'auth', 'token', 'sid', 'tgt', 'castgc', 'sso', 'access', 'refresh', 'jwt'];
  const authCookies = cookies.filter(c => authNames.some(n => c.name.toLowerCase().includes(n)));
  const httpOnlyCount = cookies.filter(c => c.httpOnly).length;

  console.log(`\n📊 ${cookies.length} cookies (${httpOnlyCount} HttpOnly)`);
  if (authCookies.length > 0) {
    console.log(`   🔑 Auth cookies: ${authCookies.map(c => c.name).join(', ')}`);
  }

  if (cookies.length === 0) {
    console.log(`❌ Nenhum cookie capturado — sessão inválida`);
    return false;
  }

  const session = {
    platform: platformKey,
    url: finalUrl,
    cookies,
    localStorage,
    sessionStorage,
    savedAt: Date.now(),
    savedAtHuman: new Date().toLocaleString('pt-BR'),
    cookieCount: cookies.length,
    capturedVia: 'puppeteer-headful-auto-v2',
  };

  const sessionFile = path.join(SESS_DIR, `${platformKey}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  console.log(`✅ ${config.label} salvo! (${Math.round(JSON.stringify(session).length / 1024)}KB)`);
  console.log(`   📁 ${sessionFile}`);

  return true;
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  CAPTURA DE SESSÕES v2 — Login automático por plataforma');
  console.log('═'.repeat(60));
  console.log('\nBrowsers vão abrir. Faça login se necessário.');
  console.log('O script detecta o login automaticamente (sem ENTER).\n');

  const results = {};

  for (const [key, config] of Object.entries(PLATFORMS)) {
    try {
      results[key] = await capturePlatform(key, config);
    } catch (e) {
      console.error(`\n❌ Erro ao capturar ${config.label}: ${e.message}`);
      results[key] = false;
    }
  }

  // Resumo
  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  console.log('═'.repeat(60));
  for (const [key, ok] of Object.entries(results)) {
    const label = ALL_PLATFORMS[key]?.label || key;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  }

  const anyOk = Object.values(results).some(Boolean);
  if (!anyOk) {
    console.log('\n❌ Nenhuma sessão capturada.');
    return;
  }

  // Enviar para VPS
  const { execSync } = require('child_process');
  const VPS_SESS = 'vps:/opt/platform/data/ebook-publisher/db/sessions/';

  const filesToSend = Object.entries(results)
    .filter(([, ok]) => ok)
    .map(([key]) => `"${path.join(SESS_DIR, `${key}.json`)}"`);

  console.log('\n📤 Enviando sessões para o VPS...');
  try {
    execSync(`scp ${filesToSend.join(' ')} ${VPS_SESS}`, { stdio: 'inherit', timeout: 30000 });
    console.log('✅ Sessões enviadas!');

    console.log('\n🔄 Reiniciando ebook-publisher...');
    execSync('ssh vps "docker restart platform-ebook-publisher-1"', { stdio: 'inherit', timeout: 30000 });
    console.log('✅ Container reiniciado com sessões frescas!');
  } catch (e) {
    console.error('❌ Erro ao enviar:', e.message);
    console.log('\n📋 Execute manualmente:');
    console.log(`  scp data/sessions/*.json ${VPS_SESS}`);
  }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
