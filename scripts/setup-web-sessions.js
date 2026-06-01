#!/usr/bin/env node
/**
 * setup-web-sessions.js — Setup inicial de sessões para os serviços web de ebook
 *
 * EXECUTA NO WINDOWS (com Chrome visível).
 * Abre cada serviço num browser visível → usuário faz login com Google →
 * sessão salva localmente → enviada para o VPS automaticamente.
 *
 * Uso:
 *   node scripts/setup-web-sessions.js
 *   node scripts/setup-web-sessions.js gamma          # só Gamma
 *   node scripts/setup-web-sessions.js gamma piktochart # só esses dois
 *
 * Só precisa ser executado UMA VEZ por serviço (ou quando a sessão expirar).
 *
 * Contas sugeridas (na ordem de prioridade):
 *   1. mrovariz@gmail.com
 *   2. parkingmanagerbr@gmail.com
 *   3. whatsiahub@gmail.com
 *   4. contosfolks@gmail.com
 *   5. cortes30vs@gmail.com
 *   6. estoriasdeamor90@gmail.com
 */
'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const { execSync } = require('child_process');
const readline  = require('readline');

const SESS_DIR  = path.join(__dirname, '../data/sessions');
const VPS_SESS  = 'vps:/opt/platform/ebook-publisher/data/sessions/';
const GENIA_DIR = path.join(__dirname, '../data/genia');

fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(GENIA_DIR, { recursive: true });

// Gmail accounts a configurar em ordem de prioridade
const GMAIL_ACCOUNTS = [
  'mrovariz@gmail.com',
  'parkingmanagerbr@gmail.com',
  'whatsiahub@gmail.com',
  'contosfolks@gmail.com',
  'cortes30vs@gmail.com',
  'estoriasdeamor90@gmail.com',
];

// Serviços a configurar
const SERVICES = {
  gamma: {
    name:     'Gamma.app',
    loginUrl: 'https://gamma.app',
    checkUrl: 'https://gamma.app/home',
    successFn: (url) => url.includes('/home') || url.includes('/dashboard') || url.includes('/workspace'),
    domains:  ['gamma.app', '.gamma.app'],
  },
  piktochart: {
    name:     'Piktochart',
    loginUrl: 'https://create.piktochart.com/',
    checkUrl: 'https://create.piktochart.com/',
    successFn: (url) => !url.includes('/login') && !url.includes('/signup') && url.includes('piktochart.com'),
    domains:  ['create.piktochart.com', 'piktochart.com', '.piktochart.com'],
  },
  ebookmaker: {
    name:     'ebookmaker.ai',
    loginUrl: 'https://ebookmaker.ai/pt-BR/ebook/new',
    checkUrl: 'https://ebookmaker.ai/',
    successFn: (url) => url.includes('ebookmaker.ai') && !url.includes('/login') && !url.includes('/register'),
    domains:  ['ebookmaker.ai', '.ebookmaker.ai'],
  },
  visme: {
    name:     'Visme',
    loginUrl: 'https://www.visme.co/login/',
    checkUrl: 'https://dashboard.visme.co/v2/',
    successFn: (url) => url.includes('/v2/') || url.includes('/dashboard'),
    domains:  ['visme.co', '.visme.co', 'dashboard.visme.co'],
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function saveSession(page, service, email) {
  const cookies = await page.cookies().catch(() => []);
  let localStorageData = {};
  try {
    localStorageData = await page.evaluate(() => {
      const obj = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        obj[k] = localStorage.getItem(k);
      }
      return obj;
    });
  } catch {}

  const safeEmail = email.replace(/[@.]/g, '_');
  const sessFile  = path.join(SESS_DIR, `${service}_${safeEmail}.json`);
  const session   = {
    service,
    email,
    cookies,
    localStorage: localStorageData,
    savedAt:      Date.now(),
    savedAtHuman: new Date().toLocaleString('pt-BR'),
    url:          page.url(),
    cookieCount:  cookies.length,
  };

  fs.writeFileSync(sessFile, JSON.stringify(session, null, 2));
  console.log(`  💾 Sessão salva: ${sessFile} (${cookies.length} cookies)`);

  // Salvar também no genia
  const geniaFile = path.join(GENIA_DIR, 'web_service_sessions.json');
  let geniaLog = [];
  try { geniaLog = JSON.parse(fs.readFileSync(geniaFile, 'utf8')); } catch {}
  geniaLog = geniaLog.filter(e => !(e.service === service && e.email === email));
  geniaLog.unshift({ service, email, savedAt: new Date().toISOString(), sessionFile: sessFile, cookieCount: cookies.length });
  fs.writeFileSync(geniaFile, JSON.stringify(geniaLog, null, 2));

  return sessFile;
}

async function setupService(serviceName, email) {
  const svc = SERVICES[serviceName];
  if (!svc) { console.error('Serviço desconhecido: ' + serviceName); return false; }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🌐 ${svc.name} — ${email}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Abrindo browser visível em: ${svc.loginUrl}`);
  console.log(`👤 Faça login com sua conta Google: ${email}`);
  console.log(`⏳ Aguardando login (até 5 minutos)...`);

  // Encontrar Chrome instalado
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean);

  let executablePath = null;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) { executablePath = p; break; }
  }

  const browser = await puppeteer.launch({
    headless: false,  // Visível para o usuário interagir
    executablePath: executablePath || undefined,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();

    // Esconder sinais de automação
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(svc.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Aguardar o usuário fazer login (até 5 min)
    let loggedIn = false;
    const deadline = Date.now() + 300000;

    while (Date.now() < deadline) {
      const currentUrl = page.url();
      if (svc.successFn(currentUrl)) {
        loggedIn = true;
        break;
      }
      await sleep(2000);
    }

    if (!loggedIn) {
      console.log('  ⏰ Timeout — login não detectado');
      return false;
    }

    console.log(`  ✅ Login detectado! URL: ${page.url().slice(0, 70)}`);
    await sleep(2000); // Aguardar cookies serem salvos

    const sessFile = await saveSession(page, serviceName, email);
    console.log(`  ✅ ${svc.name}: sessão configurada para ${email}`);
    return sessFile;

  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const servicesToSetup = args.length > 0
    ? args.filter(a => SERVICES[a])
    : Object.keys(SERVICES);

  console.log('\n' + '═'.repeat(60));
  console.log('  GENIA — Setup de Sessões Web Ebook');
  console.log('═'.repeat(60));
  console.log('\nEste script abre um browser VISÍVEL para você fazer login.');
  console.log('Os serviços a configurar:\n');
  for (const s of servicesToSetup) {
    console.log(`  • ${SERVICES[s]?.name || s}: ${SERVICES[s]?.loginUrl}`);
  }

  console.log('\n🏦 Contas Gmail disponíveis:');
  GMAIL_ACCOUNTS.forEach((e, i) => console.log(`  ${i+1}. ${e}`));

  const emailAnswer = await prompt('\n📧 Qual conta usar? (número ou email completo, Enter para a primeira): ');
  let selectedEmail;
  const emailNum = parseInt(emailAnswer);
  if (emailNum >= 1 && emailNum <= GMAIL_ACCOUNTS.length) {
    selectedEmail = GMAIL_ACCOUNTS[emailNum - 1];
  } else if (emailAnswer.includes('@')) {
    selectedEmail = emailAnswer;
  } else {
    selectedEmail = GMAIL_ACCOUNTS[0];
  }
  console.log(`\n✅ Usando conta: ${selectedEmail}`);

  const savedFiles = [];

  for (const serviceName of servicesToSetup) {
    const svc = SERVICES[serviceName];
    if (!svc) continue;

    const again = await prompt(`\nConfigurar ${svc.name}? [S/n]: `);
    if (again.toLowerCase() === 'n') {
      console.log('  Pulando...');
      continue;
    }

    const sessFile = await setupService(serviceName, selectedEmail);
    if (sessFile) savedFiles.push(sessFile);

    if (servicesToSetup.indexOf(serviceName) < servicesToSetup.length - 1) {
      const next = await prompt('\nConfigurar próximo serviço? [S/n]: ');
      if (next.toLowerCase() === 'n') break;
    }
  }

  // Enviar para VPS
  if (savedFiles.length > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log('📤 Enviando sessões para o VPS...');
    const geniaFile = path.join(GENIA_DIR, 'web_service_sessions.json');
    const toSend = [...savedFiles];
    if (fs.existsSync(geniaFile)) toSend.push(geniaFile);

    try {
      execSync(
        `scp ${toSend.map(f => `"${f}"`).join(' ')} ${VPS_SESS}`,
        { stdio: 'inherit', timeout: 30000 }
      );
      console.log('✅ Sessões enviadas!');

      console.log('\n🔄 Reiniciando ebook-publisher no VPS...');
      execSync('ssh vps "bash /opt/platform/ebook-publisher/deploy.sh"', { stdio: 'inherit', timeout: 60000 });
      console.log('✅ Container reiniciado!');
    } catch (e) {
      console.warn('⚠️ Erro ao enviar para VPS:', e.message);
      console.log('\n📋 Envio manual:');
      savedFiles.forEach(f => console.log(`  scp "${f}" ${VPS_SESS}`));
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  console.log(`  ✅ ${savedFiles.length} sessão(ões) configurada(s)`);
  console.log('═'.repeat(60));

  if (savedFiles.length > 0) {
    console.log('\n🚀 Os agentes já podem usar os serviços configurados!');
    console.log('   Créditos disponíveis: Gamma(8/mês), Piktochart(5/mês), ebookmaker(10/mês), Visme(5/mês)');
    console.log('   Reset automático: dia 1 de cada mês');
    console.log('\n   Para configurar mais contas, execute novamente com outra conta Gmail.');
    console.log(`   Próximas contas sugeridas: ${GMAIL_ACCOUNTS.filter(e => e !== selectedEmail).slice(0,3).join(', ')}`);
  }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
