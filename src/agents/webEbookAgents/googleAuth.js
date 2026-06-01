'use strict';
/**
 * googleAuth.js — Injeta sessão Google em Puppeteer e resolve OAuth
 *
 * Fluxo:
 * 1. Carrega cookies do arquivo de sessão Google
 * 2. Abre uma página accounts.google.com e injeta os cookies
 * 3. Quando o serviço redireciona para Google OAuth, o browser já está autenticado
 * 4. Detecta e clica automaticamente no botão "Continuar como [email]"
 */
const fs   = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Injeta cookies Google no browser (em página inicial neutra).
 * Deve ser chamado ANTES de navegar ao serviço.
 */
async function injectGoogleSession(browser, googleSessionFile) {
  if (!fs.existsSync(googleSessionFile)) {
    throw new Error(`Sessão Google não encontrada: ${googleSessionFile}`);
  }

  const session = JSON.parse(fs.readFileSync(googleSessionFile, 'utf8'));
  const cookies = session.cookies || [];

  if (cookies.length === 0) {
    throw new Error(`Sessão Google vazia: ${googleSessionFile}`);
  }

  // Abre uma página em branco e injeta cookies para o contexto do browser
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    // Puppeteer setCookie aceita cookies por domínio — injetar todos os Google cookies
    for (const cookie of cookies) {
      try {
        const c = {
          name:     cookie.name,
          value:    cookie.value,
          domain:   cookie.domain,
          path:     cookie.path || '/',
          httpOnly: cookie.httpOnly || false,
          secure:   cookie.secure || false,
          sameSite: cookie.sameSite || 'Lax',
        };
        if (cookie.expires && cookie.expires > 0) c.expires = Math.floor(cookie.expires);
        await page.setCookie(c);
      } catch {}
    }
    console.log(`[googleAuth] ✅ ${cookies.length} cookies Google injetados para ${session.email}`);
  } finally {
    await page.close().catch(() => {});
  }

  return session.email;
}

/**
 * Aguarda e resolve o popup/redirect de OAuth do Google.
 * Detecta o botão "Continue as [email]" ou "Continuar como" e clica.
 *
 * @param {Page} servicePage - Página principal do serviço
 * @param {string} email - Email esperado da conta Google
 * @param {number} timeout - Timeout em ms (padrão 30s)
 * @returns {boolean} true se OAuth resolvido com sucesso
 */
async function resolveGoogleOAuth(servicePage, email, timeout = 30000) {
  const browser = servicePage.browser();
  const deadline = Date.now() + timeout;

  // Padrões de texto no botão de continuação
  const continueTexts = [
    'continue as', 'continuar como', 'continue with', 'continuar com',
    'continue', 'continuar', 'sign in as', 'entrar como',
    email.toLowerCase().split('@')[0], // nome de usuário
  ];

  while (Date.now() < deadline) {
    // Verificar se a página do serviço já mudou (OAuth resolvido por redirect)
    const currentUrl = servicePage.url();
    if (!currentUrl.includes('accounts.google.com') &&
        !currentUrl.includes('oauth') &&
        currentUrl !== 'about:blank' &&
        !currentUrl.startsWith('chrome-extension')) {
      // Verificar se há indicação de login bem-sucedido
      const pageContent = await servicePage.evaluate(() =>
        document.body?.innerText?.slice(0, 500) || ''
      ).catch(() => '');
      if (pageContent && !pageContent.toLowerCase().includes('sign in') &&
          !pageContent.toLowerCase().includes('entrar')) {
        console.log('[googleAuth] OAuth resolvido via redirect direto');
        return true;
      }
    }

    // Procurar popup aberto pelo OAuth
    const pages = await browser.pages();
    for (const p of pages) {
      if (p === servicePage) continue;
      const url = p.url();
      if (!url.includes('accounts.google.com') && !url.includes('oauth')) continue;

      // Temos o popup Google OAuth
      try {
        // Esperar o botão aparecer
        const clicked = await p.evaluate((texts) => {
          // Tentar botões de "Continue as"
          const allBtns = Array.from(document.querySelectorAll(
            'button, [role="button"], input[type="submit"], a[href*="oauth"]'
          ));
          for (const btn of allBtns) {
            const t = (btn.textContent || btn.value || '').trim().toLowerCase();
            const r = btn.getBoundingClientRect();
            if (r.width === 0) continue;
            for (const txt of texts) {
              if (t.includes(txt)) {
                btn.click();
                return 'clicked: ' + t.slice(0, 60);
              }
            }
          }
          // Tentar link com email
          const links = Array.from(document.querySelectorAll('a, div[data-authuser]'));
          for (const l of links) {
            const t = (l.textContent || '').toLowerCase();
            if (t.includes('@gmail') || t.includes('@google')) {
              l.click();
              return 'email-link clicked: ' + t.slice(0, 40);
            }
          }
          return null;
        }, continueTexts);

        if (clicked) {
          console.log(`[googleAuth] ${clicked}`);
          await sleep(3000);
          // Popup deve fechar após login
          try { await p.waitForNavigation({ timeout: 10000 }); } catch {}
          return true;
        }
      } catch {}
    }

    // Verificar se na própria servicePage há um elemento OAuth embedded
    try {
      const embeddedClicked = await servicePage.evaluate((texts) => {
        const iframe = document.querySelector('iframe[src*="accounts.google"]');
        if (iframe) return 'has-iframe';
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of allBtns) {
          const t = (btn.textContent || '').toLowerCase();
          if (texts.some(tx => t.includes(tx))) {
            btn.click();
            return 'embedded-click: ' + t.slice(0, 40);
          }
        }
        return null;
      }, continueTexts);

      if (embeddedClicked && embeddedClicked !== 'has-iframe') {
        console.log(`[googleAuth] ${embeddedClicked}`);
        await sleep(3000);
        return true;
      }
    } catch {}

    await sleep(1000);
  }

  console.warn('[googleAuth] Timeout ao resolver OAuth do Google');
  return false;
}

/**
 * Salva sessão do serviço (cookies + localStorage) após login bem-sucedido.
 */
async function saveServiceSession(page, sessionFile, meta = {}) {
  const cookies = await page.cookies().catch(() => []);
  let localStorage = {};
  try {
    localStorage = await page.evaluate(() => {
      const obj = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        obj[k] = window.localStorage.getItem(k);
      }
      return obj;
    });
  } catch {}

  const session = {
    ...meta,
    cookies,
    localStorage,
    savedAt:     Date.now(),
    savedAtHuman: new Date().toLocaleString('pt-BR'),
    url:         page.url(),
  };

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  console.log(`[googleAuth] Sessão salva: ${sessionFile} (${cookies.length} cookies)`);
  return session;
}

/**
 * Carrega sessão do serviço e injeta cookies na página.
 * Retorna true se carregou com sucesso.
 */
async function loadServiceSession(page, sessionFile) {
  if (!fs.existsSync(sessionFile)) return false;

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const cookies = session.cookies || [];
    if (cookies.length === 0) return false;

    for (const cookie of cookies) {
      try {
        const c = {
          name:     cookie.name,
          value:    cookie.value,
          domain:   cookie.domain,
          path:     cookie.path || '/',
          httpOnly: cookie.httpOnly || false,
          secure:   cookie.secure || false,
        };
        if (cookie.expires && cookie.expires > 0) c.expires = Math.floor(cookie.expires);
        await page.setCookie(c);
      } catch {}
    }

    // Restaurar localStorage
    if (session.localStorage && Object.keys(session.localStorage).length > 0) {
      try {
        await page.evaluate((ls) => {
          for (const [k, v] of Object.entries(ls)) {
            try { window.localStorage.setItem(k, v); } catch {}
          }
        }, session.localStorage);
      } catch {}
    }

    console.log(`[googleAuth] Sessão carregada: ${sessionFile} (${cookies.length} cookies)`);
    return true;
  } catch (e) {
    console.warn(`[googleAuth] Erro ao carregar sessão: ${e.message}`);
    return false;
  }
}

module.exports = {
  injectGoogleSession,
  resolveGoogleOAuth,
  saveServiceSession,
  loadServiceSession,
};
