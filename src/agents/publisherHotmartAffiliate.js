'use strict';
/**
 * publisherHotmartAffiliate.js
 * Configures the Hotmart affiliate program for all published products
 * using Puppeteer UI automation.
 *
 * Flow per product:
 *   1. Navigate to /products/manage/{id}/affiliation-setup
 *   2. If "Configurar programa" visible → run 4-step wizard
 *      Step 1: Select "Afiliação de 1 clique" (1-click) → Continuar
 *      Step 2: Enter commission % → Continuar
 *      Step 3: Select email → Continuar
 *      Step 4: Enter description → Finalizar
 *   3. If already configured → skip
 */

const fs      = require('fs');
const https   = require('https');
const puppeteer = require('puppeteer');
const { createLogger } = require('../core/logger');
const log = createLogger('hotmart-affiliate');

const SESSION_FILE = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CAS TGT → Service Ticket ─────────────────────────────────────────────────
function getCASTicket(tgt, serviceUrl) {
  return new Promise((resolve, reject) => {
    const body = 'service=' + encodeURIComponent(serviceUrl);
    const opts = {
      hostname: 'sso.hotmart.com',
      path: '/v1/tickets/' + tgt,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.trim() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Refresh JWT via CAS TGT ───────────────────────────────────────────────────
async function refreshJWT(browser, session) {
  const hmSso = session.cookies.find(c => c.name === 'hmSsoExp');
  if (!hmSso) {
    log.warn('hmSsoExp cookie not found — using existing token');
    return session.localStorage && session.localStorage.token;
  }

  const tgt = hmSso.value.split('|').slice(1).join('|');
  const oauth2Service = 'https://sso.hotmart.com/oauth2.0/callbackAuthorize?client_id=8cef361b-94f8-4679-bd92-9d1cb496452d&scope=openid+profile+email&redirect_uri=https%3A%2F%2Fapp.hotmart.com%2Flogout&response_type=code';

  const st = await getCASTicket(tgt, oauth2Service);
  log.info('CAS ST status: ' + st.status);

  const lp = await browser.newPage();
  for (const c of session.cookies) {
    try {
      const x = { ...c };
      delete x.sameSite; delete x.sameParty;
      if (x.expires === -1) delete x.expires;
      if (!x.url) x.url = x.domain && x.domain.startsWith('.') ? 'https://' + x.domain.slice(1) : 'https://' + (x.domain || 'hotmart.com');
      await lp.setCookie(x);
    } catch (_) {}
  }

  try {
    await lp.goto(oauth2Service + '&ticket=' + st.body, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    log.warn('OAuth callback error: ' + e.message.slice(0, 60));
  }
  await sleep(5000);

  const tok = await lp.evaluate(() => localStorage.getItem('token')).catch(() => null);
  await lp.close();

  if (tok) { log.info('JWT refreshed via CAS ✓'); return tok; }
  const fallback = session.localStorage && session.localStorage.token;
  log.warn('JWT via CAS failed, using existing token');
  return fallback || null;
}

// ── Setup new page with anti-detection ───────────────────────────────────────
async function setupPage(page, session, jwt) {
  // Set default timeout for all page operations (evaluate, click, etc.) to 15s
  page.setDefaultTimeout(15000);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // Note: CDP SSO monitor intercept is set up per-product in configureProductAffiliateUI(),
  // not here, because the OIDC navigation during product loading creates a new renderer
  // context that requires a fresh CDPSession.

  await page.evaluateOnNewDocument(() => {
    const orig = String.prototype.replace;
    Object.defineProperty(Object.prototype, 'replace', {
      value: function(...a) { return orig.apply(String(this == null ? '' : this), a); },
      writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const ls = { ...(session.localStorage || {}) };
  if (jwt) ls.token = jwt;
  await page.evaluateOnNewDocument((ls) => {
    Object.entries(ls).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
  }, ls);

  for (const c of session.cookies) {
    try {
      const x = { ...c };
      delete x.sameSite; delete x.sameParty;
      if (x.expires === -1) delete x.expires;
      if (!x.url) x.url = x.domain && x.domain.startsWith('.') ? 'https://' + x.domain.slice(1) : 'https://' + (x.domain || 'hotmart.com');
      await page.setCookie(x);
    } catch (_) {}
  }
}

// ── Shadow DOM helpers (run inside page.evaluate) ─────────────────────────────
const SHADOW_HELPERS = `
  function deepFindButton(text) {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('button,[role="button"]')) {
          const t = (el.textContent || el.innerText || '').trim();
          if (t === text || t.startsWith(text)) return el;
        }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function deepFindInput() {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('input[type="text"],input[type="number"],input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])')) {
          return el;
        }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function deepFindRadio(index) {
    const radios = [];
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        ctx.querySelectorAll('input[type="radio"],[role="radio"]').forEach(el => radios.push(el));
        ctx.querySelectorAll('*').forEach(child => { if (child.shadowRoot) walk(child); });
      } catch(e) {}
    }
    walk(document.documentElement);
    return radios[index] || null;
  }

  function deepFindTextarea() {
    function walk(node) {
      try {
        const ctx = node.shadowRoot || node;
        for (const el of ctx.querySelectorAll('textarea')) { return el; }
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot) { const f = walk(child); if (f) return f; }
        }
      } catch(e) {}
      return null;
    }
    return walk(document.documentElement);
  }

  function pageHasText(text) {
    return (document.body && document.body.innerText || '').includes(text);
  }
`;

// ── Enable CDP Fetch intercept for SSO session/monitor ──────────────────────
// Prevents the Hotmart SPA from triggering infinite OIDC re-auth loops.
// Returns the CDP session so it can be checked/reattached later.
async function enableCDPSSOIntercept(page, label) {
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*sso.hotmart.com/rest/v1/session/monitor*' }]
    });
    cdp.on('Fetch.requestPaused', async (evt) => {
      try {
        await cdp.send('Fetch.fulfillRequest', {
          requestId: evt.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from('{"active":true}').toString('base64'),
        });
        log.info(`[${label}] SSO monitor intercepted → returned 200`);
      } catch (_) {}
    });
    return cdp;
  } catch (e) {
    log.warn(`[${label}] CDP intercept setup failed: ${e.message.slice(0, 50)}`);
    return null;
  }
}

// ── Configure a single product's affiliate via UI wizard ─────────────────────
async function configureProductAffiliateUI(page, productId, opts = {}) {
  const commission  = opts.commission  ?? 50;   // 50 = 50%
  const description = opts.description ?? 'Programa de afiliados com comissão competitiva. Promova este produto e ganhe por cada venda confirmada.';
  // Commission input mask: each keystroke appends a digit, shifting decimals
  // To get "50.00", type "5000" (4 digits)
  const commDigits = String(Math.round(commission * 100)).padStart(4, '0'); // 50 → "5000"

  const setupUrl = `https://app.hotmart.com/products/manage/${productId}/affiliation-setup`;
  log.info(`[${productId}] Navigating to ${setupUrl}`);

  try {
    await page.goto(setupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    // ERR_ABORTED is common with SPAs doing client-side routing — not fatal
    log.warn(`[${productId}] goto error: ${e.message.slice(0, 60)}`);
  }

  // Enable CDP SSO intercept immediately after navigation.
  // When the SPA's session/monitor fires (~42s after OIDC), we return 200
  // so it doesn't trigger another re-auth redirect loop.
  await enableCDPSSOIntercept(page, productId);

  // Poll for SPA to fully render (up to 120s).
  //
  // The Hotmart SPA OIDC flow:
  //   1. Navigate to affiliation-setup → SPA loads with HOT-LOADING spinner
  //   2. ~42s: SPA fires sso.hotmart.com/session/monitor → server returns non-200
  //   3. SPA triggers OIDC re-auth → page navigates to /oidc/authorize → /login → /callback
  //   4. After OIDC completes (~20s), page returns to affiliation-setup URL
  //   5. SPA continues loading → HOT-LOADING eventually clears → page ready
  //
  // Total expected time: ~60-90s for first product (full OIDC), ~20-30s for subsequent.
  // During OIDC redirect phases, page.evaluate() throws "execution context was destroyed"
  // or eval_timeout — we catch these and keep waiting.
  log.info(`[${productId}] Waiting for SPA to render (up to 120s, handling OIDC redirect)...`);
  let oauthSeen = false;
  let cdpReenabled = false;

  // HOT-LOADING check that also walks shadow DOM (Hotmart uses nested HOT-LOADING for routes)
  const HAS_HOT_LOADING_FN = `
    function hasHotLoading(node, depth) {
      if (depth > 6) return false;
      try {
        if (node.tagName === 'HOT-LOADING') return true;
        const ctx = node.shadowRoot || node;
        if (ctx.querySelector && ctx.querySelector('HOT-LOADING')) return true;
        for (const child of ctx.querySelectorAll('*')) {
          if (child.shadowRoot && hasHotLoading(child, depth + 1)) return true;
        }
      } catch(e) {}
      return false;
    }
    return hasHotLoading(document.documentElement, 0);
  `;

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const state = await Promise.race([
      page.evaluate(new Function(`
        const hotLoading = (function() { ${HAS_HOT_LOADING_FN} })();
        return { url: location.href, hotLoading, bodyLen: document.body ? document.body.innerHTML.length : 0 };
      `)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('eval_timeout')), 8000)),
    ]).catch(e => {
      // "execution context was destroyed" = page is navigating (OIDC redirect in progress)
      // "eval_timeout" = page is loading or frame is in a broken state
      return { url: page.url(), hotLoading: true, bodyLen: 0, navigating: true };
    });

    const currentUrl = state.url || page.url();

    // Detect OIDC redirect phase (page navigated away from product URL)
    const atProductUrl = currentUrl.includes('affiliation-setup');
    const atOAuth = currentUrl.includes('sso.hotmart.com') || currentUrl.includes('/auth/login') ||
                    currentUrl.includes('oidc/authorize') || currentUrl.includes('callbackAuthorize');

    if (atOAuth && !oauthSeen) {
      oauthSeen = true;
      log.info(`[${productId}] OIDC auth redirect detected at ${i+1}s — waiting for return...`);
    }

    if (!atProductUrl) {
      // Still in OIDC flow or at login page — keep waiting
      if (i % 10 === 9) {
        log.info(`[${productId}] Waiting for OIDC to complete... ${i+1}s url=${currentUrl.slice(-60)}`);
      }
      continue;
    }

    // Page returned to product URL after OIDC — re-attach CDP intercept.
    // The initial OIDC navigation creates a new renderer; re-enabling ensures
    // the session/monitor intercept is active on the fresh renderer.
    if (oauthSeen && !cdpReenabled) {
      cdpReenabled = true;
      await enableCDPSSOIntercept(page, productId);
      log.info(`[${productId}] CDP intercept re-attached after OIDC return`);
    }

    // We're at the product URL — check for HOT-LOADING (including nested shadow DOM)
    if (!state.hotLoading && state.bodyLen > 2000) {
      log.info(`[${productId}] HOT-LOADING cleared after ${i + 1}s (body: ${state.bodyLen}b${oauthSeen ? ', after OIDC' : ''})`);
      break;
    }

    if (i % 5 === 4) {
      log.info(`[${productId}] Loading... ${i + 1}s hotLoading=${state.hotLoading} body=${state.bodyLen}`);
    }
    if (i === 119) {
      log.warn(`[${productId}] Still loading after 120s — proceeding anyway`);
    }
  }

  // Secondary poll: wait for wizard content to appear (up to 30s).
  // The affiliation micro-frontend may load AFTER the main HOT-LOADING clears.
  log.info(`[${productId}] Waiting for wizard content (up to 30s)...`);
  let wizardFound = false;
  for (let j = 0; j < 30; j++) {
    await sleep(1000);
    const wiz = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      return {
        hasConfigurar: !!deepFindButton('Configurar programa'),
        hasEditar: !!deepFindButton('Editar programa'),
        hasContinuar: !!deepFindButton('Continuar'),
        hasFinalizar: !!deepFindButton('Finalizar'),
      };
    `)).catch(() => ({}));
    if (wiz.hasConfigurar || wiz.hasEditar || wiz.hasContinuar || wiz.hasFinalizar) {
      log.info(`[${productId}] Wizard content ready after ${j+1}s`);
      wizardFound = true;
      break;
    }
    if (j % 5 === 4) {
      log.info(`[${productId}] Waiting for wizard... ${j+1}s`);
    }
  }

  // Check if we're on the right page (not redirected to login)
  const landedUrl = page.url();
  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    return { ok: false, reason: 'session_expired' };
  }
  if (landedUrl.includes('not-found') || landedUrl.includes('/404')) {
    log.warn(`[${productId}] Redirected to not-found: ${landedUrl.slice(-50)}`);
    return { ok: false, reason: 'product_not_found', url: landedUrl };
  }

  // Use shadow DOM button detection (document.body.innerText misses shadow DOM content)
  const btnState = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasConfigurar: !!deepFindButton('Configurar programa'),
      hasEditar: !!deepFindButton('Editar programa'),
      hasContinuar: !!deepFindButton('Continuar'),
      hasFinalizar: !!deepFindButton('Finalizar'),
      hasRadio: !!deepFindRadio(0),
      hasInput: !!deepFindInput(),
      url: location.href,
    };
  `)).catch(e => ({ error: e.message }));

  log.info(`[${productId}] Page state: ${JSON.stringify(btnState)}`);

  // If already configured
  if (btnState.hasEditar) {
    log.info(`[${productId}] Affiliate already configured (Editar found), skipping`);
    return { ok: true, skipped: true, reason: 'already_configured' };
  }

  // If "Configurar programa" not found and no wizard buttons either → can't configure
  if (!btnState.hasConfigurar && !btnState.hasContinuar && !btnState.hasFinalizar) {
    // Capture shadow DOM text (deep) to understand what's on the page
    const pageText = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      function getAllShadowText(node, depth) {
        if (depth > 6) return '';
        let text = '';
        try {
          const ctx = node.shadowRoot || node;
          const nodeText = (ctx.innerText || ctx.textContent || '').replace(/\\s+/g,' ').trim();
          if (nodeText) text += nodeText.slice(0, 300) + ' | ';
          ctx.querySelectorAll('*').forEach(child => {
            if (child.shadowRoot) text += getAllShadowText(child, depth + 1);
          });
        } catch(e) {}
        return text;
      }
      return getAllShadowText(document.documentElement, 0).slice(0, 800);
    `)).catch(() => 'eval error');
    log.warn('[' + productId + '] No wizard buttons found. URL: ' + landedUrl.slice(-60));
    log.warn('[' + productId + '] Page content: ' + pageText);
    return { ok: false, reason: 'no_wizard_buttons', url: landedUrl };
  }

  // ── STEP 0: Click "Configurar programa" (if present — otherwise wizard may already be open) ──
  if (btnState.hasConfigurar) {
    log.info(`[${productId}] Step 0: Clicking "Configurar programa"`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Configurar programa')?.click();`));
    await sleep(2500);
  }

  // Helper: poll for wizard state change after Continuar click (up to 8s)
  async function pollWizardStep(label, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(400);
      const s = await page.evaluate(new Function(`
        ${SHADOW_HELPERS};
        return {
          hasRadio:     !!deepFindRadio(0),
          hasInput:     !!deepFindInput(),
          hasTextarea:  !!deepFindTextarea(),
          hasContinuar: !!deepFindButton('Continuar'),
          hasFinalizar: !!deepFindButton('Finalizar'),
        };
      `)).catch(() => null);
      if (!s) continue;
      // Something new appeared: textarea (desc step), Finalizar, or new radio (email step)
      if (s.hasTextarea || s.hasFinalizar || (s.hasRadio && !s.hasInput)) {
        log.info(`[${productId}] ${label}: next step appeared (${JSON.stringify(s)})`);
        return s;
      }
    }
    // Timeout — return current state anyway
    const fallback = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      return {
        hasRadio:!!deepFindRadio(0), hasInput:!!deepFindInput(),
        hasTextarea:!!deepFindTextarea(), hasContinuar:!!deepFindButton('Continuar'),
        hasFinalizar:!!deepFindButton('Finalizar'),
      };
    `)).catch(() => ({}));
    log.warn(`[${productId}] ${label}: step poll timed out, state=${JSON.stringify(fallback)}`);
    return fallback;
  }

  // ── STEP 1: Choose affiliation type (look for radio buttons) ─────────────────
  const step1State = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return { hasRadio: !!deepFindRadio(0), hasContinuar: !!deepFindButton('Continuar') };
  `)).catch(() => ({}));

  let afterStep1 = step1State;
  if (step1State.hasRadio) {
    log.info(`[${productId}] Step 1: Selecting 1-click affiliation`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
    await sleep(500);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    afterStep1 = await pollWizardStep('after-step1');
  } else if (step1State.hasContinuar) {
    log.info(`[${productId}] Step 1: Already past radio selection`);
  }

  // ── STEP 2: Set commission (look for text input) ─────────────────────────────
  // afterStep1 tells us if commission input is present
  const step2State = afterStep1.hasInput ? afterStep1 : await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return { hasInput: !!deepFindInput(), hasContinuar: !!deepFindButton('Continuar') };
  `)).catch(() => ({}));

  let afterStep2 = null;
  if (step2State.hasInput) {
    log.info(`[${productId}] Step 2: Setting commission ${commission}% (typing "${commDigits}")`);
    await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      const inp = deepFindInput();
      if (inp) {
        inp.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, '');
        inp.dispatchEvent(new Event('input', {bubbles: true}));
      }
    `));
    await sleep(300);

    for (const digit of commDigits) {
      await page.keyboard.type(digit, { delay: 80 });
    }
    await sleep(500);

    const commValue = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      const inp = deepFindInput();
      return inp ? inp.value : 'not_found';
    `));
    log.info(`[${productId}] Commission field value: "${commValue}"`);

    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    afterStep2 = await pollWizardStep('after-step2', 10000);
  }

  // ── STEP 3: Contact email (check for radio + no textarea yet) ────────────────
  const step3State = afterStep2 || await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasRadio: !!deepFindRadio(0),
      hasInput: !!deepFindInput(),
      hasTextarea: !!deepFindTextarea(),
      hasContinuar: !!deepFindButton('Continuar'),
      hasFinalizar: !!deepFindButton('Finalizar'),
    };
  `)).catch(() => ({}));

  log.info(`[${productId}] Step 3 state: ${JSON.stringify(step3State)}`);
  let afterStep3 = step3State;
  if (step3State.hasRadio && !step3State.hasTextarea && !step3State.hasFinalizar) {
    log.info(`[${productId}] Step 3: Selecting Hotmart email`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
    await sleep(500);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
    afterStep3 = await pollWizardStep('after-step3', 10000);
  }

  // ── STEP 4: Benefits description (check for textarea or Finalizar) ───────────
  const step4State = (afterStep3.hasTextarea || afterStep3.hasFinalizar) ? afterStep3
    : await page.evaluate(new Function(`
        ${SHADOW_HELPERS};
        return { hasTextarea: !!deepFindTextarea(), hasFinalizar: !!deepFindButton('Finalizar') };
      `)).catch(() => ({}));

  log.info(`[${productId}] Step 4 state: ${JSON.stringify(step4State)}`);
  if (step4State.hasTextarea || step4State.hasFinalizar) {
    log.info(`[${productId}] Step 4: Entering description`);

    if (step4State.hasTextarea) {
      await page.evaluate(new Function(`
        ${SHADOW_HELPERS};
        const ta = deepFindTextarea();
        if (ta) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(ta, '');
          ta.dispatchEvent(new Event('input', {bubbles: true}));
          ta.focus();
        }
      `));
      await page.keyboard.type(description, { delay: 10 });
      await sleep(500);
    }

    log.info(`[${productId}] Step 4: Clicking Finalizar`);
    await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Finalizar')?.click();`));
    await sleep(4000);
  } else {
    log.warn(`[${productId}] Step 4 not reached — no textarea or Finalizar button found`);
  }

  // ── Verify result ───────────────────────────────────────────────────────────
  const finalUrl = page.url();
  const finalState = await page.evaluate(new Function(`
    ${SHADOW_HELPERS};
    return {
      hasEditar: !!deepFindButton('Editar programa'),
      hasFinalizar: !!deepFindButton('Finalizar'),
      hasConfigurar: !!deepFindButton('Configurar programa'),
    };
  `)).catch(() => ({}));

  // Success: wizard gone (no Finalizar), or "Editar programa" appeared
  const isSuccess = finalState.hasEditar || (!finalState.hasFinalizar && !finalState.hasConfigurar);

  log.info(`[${productId}] Final: url=${finalUrl.slice(-50)} editar=${finalState.hasEditar} finalizar=${finalState.hasFinalizar} success=${isSuccess}`);

  return { ok: isSuccess, finalUrl };
}

// ── Launch authenticated Hotmart browser ─────────────────────────────────────
async function launchHotmartBrowser() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('Session not found: ' + SESSION_FILE);
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });

  let jwt = null;
  try {
    jwt = await refreshJWT(browser, session);
  } catch (e) {
    log.warn('JWT refresh failed: ' + e.message);
    jwt = session.localStorage && session.localStorage.token;
  }

  const page = await browser.newPage();
  await setupPage(page, session, jwt);

  // Warm up session
  log.info('Warming up Hotmart session...');
  await page.goto('https://app.hotmart.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (_) {}
  await sleep(4000);

  const landedUrl = page.url();
  log.info(`Warmed up at: ${landedUrl.slice(0, 80)}`);

  if (landedUrl.includes('sso.hotmart.com') || landedUrl.includes('/login')) {
    await browser.close();
    throw new Error('Session expired — re-run capture-hotmart-session.js');
  }

  const token = await page.evaluate(() => localStorage.getItem('token') || '').catch(() => '');
  log.info(`Token present: ${!!token}`);

  return { browser, page, jwt, token };
}

// ── DB ───────────────────────────────────────────────────────────────────────
function getPublishedHotmartProducts() {
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/metrics.db');
  db.pragma('journal_mode = WAL');
  const rows = db.prepare(`
    SELECT id, title, hotmart_product_id FROM ebooks
    WHERE status = 'published'
      AND hotmart_product_id IS NOT NULL AND hotmart_product_id != ''
    ORDER BY created_at DESC
  `).all();
  db.close();
  return rows.filter(r => /^\d+$/.test(String(r.hotmart_product_id || '')));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function setupAllAffiliates(opts = {}) {
  const commission  = opts.commission  ?? 50;
  const limit       = opts.limit       ?? 999;

  log.info(`Starting UI-based affiliate setup: commission=${commission}%`);

  let products;
  try {
    products = getPublishedHotmartProducts().slice(0, limit);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  log.info(`Found ${products.length} products with Hotmart IDs`);

  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
  } catch (e) {
    return { ok: false, error: 'Browser launch failed: ' + e.message };
  }

  const results = [];
  let done = 0, skipped = 0, failed = 0;

  try {
    for (const product of products) {
      const numericId = String(product.hotmart_product_id);
      try {
        const r = await configureProductAffiliateUI(page, numericId, { commission });
        results.push({ id: numericId, title: product.title, ...r });
        if (r.ok && r.skipped) skipped++;
        else if (r.ok) done++;
        else failed++;
        await sleep(2000);
      } catch (e) {
        log.error(`Error on ${numericId}: ${e.message}`);
        results.push({ id: numericId, title: product.title, ok: false, error: e.message });
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log.info(`Done: ${done} configured, ${skipped} skipped (already done), ${failed} failed`);
  return { ok: true, total: products.length, done, skipped, failed, results };
}

async function setupSingleAffiliate(hotmartProductId, opts = {}) {
  let browser, page;
  try {
    ({ browser, page } = await launchHotmartBrowser());
    const result = await configureProductAffiliateUI(page, String(hotmartProductId), opts);
    await browser.close().catch(() => {});
    return result;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e.message };
  }
}

module.exports = { setupAllAffiliates, setupSingleAffiliate };
