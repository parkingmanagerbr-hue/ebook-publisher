/**
 * sessionAgent.js — Agente autônomo de saúde e renovação de sessões
 *
 * Responsabilidades:
 *   - Verifica validade das sessões Hotmart + Cakto a cada 2h
 *   - Detecta expiração de JWT antes que aconteça (aviso 24h antecipado)
 *   - Renova silenciosamente via Puppeteer (SSO/cookie re-auth)
 *   - Atualiza data/sessions/*.json com tokens frescos
 *   - Desativa publisher temporariamente se renovação falhar
 *   - Re-ativa publisher assim que renovação voltar a funcionar
 *
 * Integração: chamado por autonomousAgent.js antes de cada ciclo de publicação.
 */
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const { createLogger } = require('../core/logger');
const logger = createLogger('sessionAgent');

const SESS_DIR = path.join(__dirname, '../../data/sessions');

const PLATFORMS = {
  hotmart: {
    sessionFile:   path.join(SESS_DIR, 'hotmart.json'),
    testUrl:       'https://app-vlc.hotmart.com/products',
    baseUrl:       'https://app-vlc.hotmart.com',
    loginUrl:      'https://app-vlc.hotmart.com/login',
    apiCheck:      'https://api-sec-vlc.hotmart.com/payment/api/v1/subscription?page=0&max=1',
    loginCheck:    url => url.includes('/login') || url.includes('/auth/login'),
    localStorageTokenKey: 'token',
    envKey:        'AUTO_PUBLISH_HOTMART',
  },
  cakto: {
    sessionFile:   path.join(SESS_DIR, 'cakto.json'),
    testUrl:       'https://app.cakto.com.br/dashboard',
    baseUrl:       'https://app.cakto.com.br',
    loginUrl:      'https://app.cakto.com.br/login',
    loginCheck:    url => url.includes('/login') || url.includes('/auth'),
    apiCheck:      null,
    localStorageTokenKey: 'token',
    envKey:        'AUTO_PUBLISH_CAKTO',
  },
  amazon: {
    sessionFile:   path.join(SESS_DIR, 'amazon.json'),
    testUrl:       'https://kdp.amazon.com/pt_BR/bookshelf',
    baseUrl:       'https://kdp.amazon.com',
    loginUrl:      'https://kdp.amazon.com',
    loginCheck:    url => url.includes('signin') || url.includes('ap/signin'),
    apiCheck:      null,
    localStorageTokenKey: null,   // Amazon não usa localStorage para token
    envKey:        'AUTO_PUBLISH_AMAZON',
  },
};

// Estado em memória (qual plataforma está degradada)
const degraded = { hotmart: false, cakto: false };

// ─── Ler e parsear sessão ─────────────────────────────────────────────────────
function readSession(platform) {
  const { sessionFile } = PLATFORMS[platform];
  try {
    if (!fs.existsSync(sessionFile)) return null;
    return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch { return null; }
}

function saveSession(platform, session) {
  const { sessionFile } = PLATFORMS[platform];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  session.savedAt      = Date.now();
  session.savedAtHuman = new Date().toLocaleString('pt-BR');
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
}

// ─── Decodificar JWT sem verificar assinatura ─────────────────────────────────
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
}

// ─── Verificar expiração via JWT ──────────────────────────────────────────────
function jwtExpiresIn(token) {
  const payload = decodeJwt(token);
  if (!payload?.exp) return null;
  return payload.exp * 1000 - Date.now(); // ms até expirar (negativo = já expirou)
}

// ─── Teste de validade via fetch HTTP ─────────────────────────────────────────
function httpGet(url, headers) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 8000 };
      https.get(opts, res => resolve({ status: res.statusCode }))
        .on('error', () => resolve({ status: 0 }))
        .on('timeout', () => resolve({ status: 0 }));
    } catch { resolve({ status: 0 }); }
  });
}

async function checkSessionViaApi(platform, session) {
  const { apiCheck, localStorageTokenKey } = PLATFORMS[platform];
  if (!apiCheck) return null;
  const tokenRaw = session.localStorage?.[localStorageTokenKey];
  if (!tokenRaw) return false;
  // Usar access_token embutido no JWT payload se disponível (Hotmart CAS)
  const payload = decodeJwt(tokenRaw);
  const bearer  = payload?.access_token || tokenRaw;
  const { status } = await httpGet(apiCheck, {
    'Authorization': `Bearer ${bearer}`,
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
  });
  // 401/403 → sessão inválida; 404/5xx → endpoint mudou, não é erro de sessão
  if (status === 401 || status === 403) return false;
  if (status === 0 || status >= 500) return null; // inconclusivo
  return true;
}

// ─── Renovação via Puppeteer ──────────────────────────────────────────────────
async function renewViaPuppeteer(platform) {
  const { baseUrl, testUrl, loginUrl, loginCheck, localStorageTokenKey } = PLATFORMS[platform];

  logger.info(`🔄 [${platform}] Tentando renovar sessão via Puppeteer...`);

  const session = readSession(platform);
  if (!session) {
    logger.warn(`[${platform}] Nenhuma sessão para renovar.`);
    return false;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Injetar cookies existentes
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    for (const cookie of (session.cookies || [])) {
      try { await page.setCookie(cookie); } catch {}
    }

    // Injetar localStorage/sessionStorage
    if (session.localStorage) {
      await page.evaluate(ls => {
        Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
      }, session.localStorage);
    }

    // Navegar para a URL autenticada
    await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const currentUrl = page.url();
    const isLoggedIn = !(loginCheck ? loginCheck(currentUrl) : currentUrl.includes('/login'));

    if (!isLoggedIn) {
      logger.warn(`[${platform}] Renovação falhou — redirecionado para login (${currentUrl})`);
      await browser.close();
      return false;
    }

    // Capturar sessão atualizada
    const newCookies = await page.cookies();
    const newLs = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        d[k] = localStorage.getItem(k);
      }
      return d;
    });
    const newSs = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        d[k] = sessionStorage.getItem(k);
      }
      return d;
    });

    // Verificar se token foi renovado
    const newToken = newLs[localStorageTokenKey];
    if (newToken) {
      const exp = jwtExpiresIn(newToken);
      if (exp !== null && exp > 0) {
        const hours = Math.round(exp / 3600000);
        logger.info(`✅ [${platform}] Sessão renovada! Token válido por ~${hours}h`);
      }
    }

    const updated = {
      ...session,
      cookies:       newCookies.length ? newCookies : session.cookies,
      localStorage:  Object.keys(newLs).length ? newLs : session.localStorage,
      sessionStorage: Object.keys(newSs).length ? newSs : session.sessionStorage,
      url:           currentUrl,
      cookieCount:   newCookies.length,
      lastRenewed:   new Date().toISOString(),
    };

    saveSession(platform, updated);
    logger.info(`✅ [${platform}] Sessão atualizada e salva (${newCookies.length} cookies)`);
    await browser.close();
    return true;

  } catch (err) {
    logger.error(`[${platform}] Erro na renovação: ${err.message}`);
    try { await browser.close(); } catch {}
    return false;
  }
}

// ─── Verificação principal de uma plataforma ─────────────────────────────────
async function checkPlatform(platform) {
  const { localStorageTokenKey, envKey } = PLATFORMS[platform];

  // Se a plataforma não está ativada, não verifica
  if (process.env[envKey] !== 'true') return;

  const session = readSession(platform);
  if (!session) {
    logger.warn(`[${platform}] Sem sessão salva. Execute: node scripts/setup-sessions.js`);
    degraded[platform] = true;
    return;
  }

  // ── 1. Verificar expiração do JWT ──────────────────────────────────────────
  const token = session.localStorage?.[localStorageTokenKey];
  let needsRenewal = false;

  if (token) {
    const msLeft = jwtExpiresIn(token);
    if (msLeft === null) {
      // Não é JWT — verificar por data de salvamento
      const ageDays = (Date.now() - (session.savedAt || 0)) / 86400000;
      if (ageDays > 6) {
        logger.warn(`[${platform}] Sessão com ${ageDays.toFixed(1)} dias — renovando preventivamente`);
        needsRenewal = true;
      }
    } else if (msLeft <= 0) {
      logger.warn(`[${platform}] JWT expirado há ${Math.abs(Math.round(msLeft / 60000))} min — renovando`);
      needsRenewal = true;
    } else if (msLeft < 24 * 3600000) {
      logger.warn(`[${platform}] JWT expira em ${Math.round(msLeft / 3600000)}h — renovando preventivamente`);
      needsRenewal = true;
    } else {
      const h = Math.round(msLeft / 3600000);
      logger.info(`✅ [${platform}] Sessão válida (~${h}h restantes)`);
    }
  } else {
    // Sem token JWT — testar por data de salvamento
    const ageDays = (Date.now() - (session.savedAt || 0)) / 86400000;
    if (ageDays > 5) {
      needsRenewal = true;
      logger.warn(`[${platform}] Sessão antiga (${ageDays.toFixed(1)} dias) — renovando`);
    }
  }

  // ── 2. Verificar via API (Hotmart) ─────────────────────────────────────────
  if (!needsRenewal && platform === 'hotmart' && PLATFORMS[platform].apiCheck) {
    const valid = await checkSessionViaApi(platform, session);
    if (valid === false) {
      logger.warn(`[${platform}] API retornou não-autenticado — renovando`);
      needsRenewal = true;
    }
  }

  if (!needsRenewal) {
    if (degraded[platform]) {
      logger.info(`✅ [${platform}] Sessão recuperada — publisher reativado`);
      degraded[platform] = false;
    }
    return;
  }

  // ── 3. Tentar renovação ────────────────────────────────────────────────────
  const ok = await renewViaPuppeteer(platform);
  if (ok) {
    degraded[platform] = false;
    logger.info(`✅ [${platform}] Publisher ativo`);
  } else {
    degraded[platform] = true;
    logger.error(`❌ [${platform}] Renovação falhou — publisher pausado até próxima tentativa`);
    logger.error(`   Execute: node scripts/setup-sessions.js  para reconfigurar`);
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Garante que a sessão de uma plataforma está válida ANTES de publicar.
 * Se estiver expirando/expirada → renova agora via Puppeteer.
 * Retorna true se a sessão está pronta para uso, false se não conseguiu renovar.
 */
async function ensureSession(platform) {
  const { envKey } = PLATFORMS[platform];
  if (process.env[envKey] !== 'true') return false;

  const session = readSession(platform);
  if (!session) {
    logger.warn(`[${platform}] Sem sessão — execute: node scripts/setup-sessions.js ${platform}`);
    return false;
  }

  const { localStorageTokenKey } = PLATFORMS[platform];
  const token = localStorageTokenKey ? session.localStorage?.[localStorageTokenKey] : null;
  let needsRenewal = false;

  if (token) {
    const msLeft = jwtExpiresIn(token);
    if (msLeft !== null && msLeft < 2 * 3600000) {   // menos de 2h → renovar agora
      logger.warn(`[${platform}] JWT expira em ${Math.round(msLeft/60000)}min — renovando agora`);
      needsRenewal = true;
    }
  } else {
    // Sem JWT — verificar por idade da sessão
    const ageDays = (Date.now() - (session.savedAt || 0)) / 86400000;
    if (ageDays > 6) {
      logger.warn(`[${platform}] Sessão com ${ageDays.toFixed(1)} dias — renovando`);
      needsRenewal = true;
    }
  }

  if (needsRenewal) {
    const ok = await renewViaPuppeteer(platform);
    if (!ok) {
      logger.error(`❌ [${platform}] Renovação falhou — execute: node scripts/setup-sessions.js ${platform}`);
      degraded[platform] = true;
      return false;
    }
    degraded[platform] = false;
  }

  return true;
}

/** Retorna true se a plataforma está degradada (renovação falhou) */
function isPlatformDegraded(platform) {
  return degraded[platform] === true;
}

/** Verifica todas as plataformas ativas (chama checkPlatform para log/aviso precoce) */
async function checkAllSessions() {
  logger.info('🔍 Verificando saúde das sessões...');
  for (const platform of Object.keys(PLATFORMS)) {
    await checkPlatform(platform).catch(e => logger.error(`[${platform}] erro: ${e.message}`));
  }
}

/** Loop autônomo: verifica a cada SESSION_CHECK_HOURS horas */
async function startSessionWatcher() {
  const intervalHours = parseFloat(process.env.SESSION_CHECK_HOURS || '2');
  const intervalMs    = intervalHours * 3600 * 1000;

  logger.info(`🕐 Session watcher iniciado — verifica a cada ${intervalHours}h`);

  setTimeout(async () => {
    await checkAllSessions();
    setInterval(checkAllSessions, intervalMs);
  }, 30_000);
}

module.exports = { startSessionWatcher, checkAllSessions, ensureSession, isPlatformDegraded, renewViaPuppeteer };
