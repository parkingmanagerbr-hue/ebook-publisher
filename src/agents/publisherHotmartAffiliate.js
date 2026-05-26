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

// ── JWT expiry extension (no signature verification — SPA trusts its own tokens) ──
// Most SPAs decode JWT payload without verifying signature to check exp locally.
// We re-encode the payload with exp += 48h, keeping the original (invalid) signature.
// This prevents OIDC re-auth when the token is expired but we can't refresh via CAS.
function extendJWTExpiry(token) {
  if (!token || typeof token !== 'string') return token;
  const parts = token.split('.');
  if (parts.length !== 3) return token;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const newExp = Math.floor(Date.now() / 1000) + 48 * 3600;
    if (payload.exp && payload.exp > newExp) return token; // already valid
    payload.exp = newExp;
    const newPayload = Buffer.from(JSON.stringify(payload))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return parts[0] + '.' + newPayload + '.' + parts[2]; // original signature kept
  } catch (_) {
    return token;
  }
}

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
    // Use 'domcontentloaded' — fires early enough for SPA to start, then we poll for token
    await lp.goto(oauth2Service + '&ticket=' + st.body, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    log.warn('OAuth callback navigate: ' + e.message.slice(0, 50));
  }

  // Retry reading token from localStorage (SPA sets it async after OAuth redirect)
  let tok = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    tok = await lp.evaluate(() => localStorage.getItem('token')).catch(() => null);
    if (tok) break;
    await sleep(1500);
  }
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

// ── Master CDP intercept — single session handles ALL SSO/OIDC interceptions ──
// Must use ONE CDP session (multiple Fetch.enable sessions conflict in Chrome).
// Intercepts:
//   session/monitor → {"active":true}  (prevent SPA from detecting expired SSO)
//   oidc/authorize  → JS page that sets extended token + navigates back to product
//   accessToken     → fake token response with extended JWT
//   oauth2.0/profile → fake user profile
let _masterCdp = null;

async function enableMasterCDPIntercept(page, extToken, label) {
  // Disable any previous intercept
  if (_masterCdp) {
    try { await _masterCdp.send('Fetch.disable'); } catch (_) {}
    _masterCdp = null;
  }

  try {
    _masterCdp = await page.target().createCDPSession();

    const tokenB64 = extToken
      ? Buffer.from(JSON.stringify({
          access_token: extToken,
          id_token: extToken,
          token_type: 'Bearer',
          expires_in: 172800,
          scope: 'openid profile email',
        })).toString('base64')
      : null;

    const profileB64 = Buffer.from(JSON.stringify({
      sub: 'user', email: 'mrovariz@gmail.com', name: 'GENIA',
    })).toString('base64');

    await _masterCdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*sso.hotmart.com/rest/v1/session/monitor*' },
        { urlPattern: '*hotmart.com/oidc/authorize*' },
        { urlPattern: '*sso.hotmart.com/oauth2.0/accessToken*' },
        { urlPattern: '*sso.hotmart.com/oauth2.0/profile*' },
        { urlPattern: '*sso.hotmart.com/cas/oauth2.0/accessToken*' },
      ],
    });

    _masterCdp.on('Fetch.requestPaused', async (evt) => {
      try {
        const url = evt.request.url;

        if (url.includes('/session/monitor')) {
          await _masterCdp.send('Fetch.fulfillRequest', {
            requestId: evt.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from('{"active":true}').toString('base64'),
          });
          log.info(`[${label}] session/monitor → active`);

        } else if (url.includes('/oidc/authorize') || url.includes('/cas/oauth2.0/authorize')) {
          // Return JS that sets the extended token in localStorage then navigates back.
          // We return HTML for the authorize URL so it runs in the SPA's domain context
          // — this avoids the code exchange loop from a fake callback redirect.
          const currentUrl = await page.url().catch(() => '');
          const safeToken = (extToken || '').replace(/'/g, "\\'");
          const safeDest  = currentUrl.replace(/'/g, "\\'") || 'https://app.hotmart.com/';
          const htmlBody  = `<!DOCTYPE html><html><body><script>
try{localStorage.setItem('token','${safeToken}');}catch(_){}
window.location.replace('${safeDest}');
</script></body></html>`;
          await _masterCdp.send('Fetch.fulfillRequest', {
            requestId: evt.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/html' }],
            body: Buffer.from(htmlBody).toString('base64'),
          });
          log.info(`[${label}] oidc/authorize intercepted → inject token + redirect to SPA`);

        } else if (url.includes('/accessToken')) {
          if (tokenB64) {
            await _masterCdp.send('Fetch.fulfillRequest', {
              requestId: evt.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: 'content-type', value: 'application/json' },
                { name: 'access-control-allow-origin', value: '*' },
              ],
              body: tokenB64,
            });
            log.info(`[${label}] accessToken intercepted → returned extended token`);
          } else {
            await _masterCdp.send('Fetch.continueRequest', { requestId: evt.requestId });
          }

        } else if (url.includes('/profile')) {
          await _masterCdp.send('Fetch.fulfillRequest', {
            requestId: evt.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: profileB64,
          });
          log.info(`[${label}] oauth profile intercepted → returned fake profile`);

        } else {
          await _masterCdp.send('Fetch.continueRequest', { requestId: evt.requestId }).catch(() => {});
        }
      } catch (e) {
        try { await _masterCdp.send('Fetch.continueRequest', { requestId: evt.requestId }); } catch (_) {}
      }
    });

    log.info(`[${label}] Master CDP intercept enabled (session/monitor + oidc + token)`);
    return _masterCdp;
  } catch (e) {
    log.warn(`[${label}] Master CDP intercept failed: ${e.message.slice(0, 60)}`);
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

  // Master CDP intercept is already active from launchHotmartBrowser — handles session/monitor,
  // oidc/authorize, accessToken and profile for the entire browser session.

  try {
    await page.goto(setupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    // ERR_ABORTED is common with SPAs doing client-side routing — not fatal
    log.warn(`[${productId}] goto error: ${e.message.slice(0, 60)}`);
  }

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

  // Secondary poll: wait for wizard content to appear (up to 60s).
  // The affiliation micro-frontend (app-vlc.hotmart.com iframe) may load AFTER
  // the main HOT-LOADING element clears. With slow OIDC, it can take 40-50s.
  log.info(`[${productId}] Waiting for wizard content (up to 60s)...`);
  let wizardFound = false;
  for (let j = 0; j < 60; j++) {
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

  // ── Generic wizard loop: handles any number of steps ─────────────────────────
  // The Hotmart affiliate wizard has variable steps (radio, input, textarea).
  // We loop up to 8 times, handling each step by type:
  //   radio      → click first radio → Continuar
  //   input      → if commission not set yet: type commission; else click Continuar (default)
  //   textarea   → type description → Finalizar (final step)
  //   Finalizar  → click (final step)
  //   Continuar only → click Continuar (informational/toggle step)
  let commissionSet = false;
  let wizardDone    = false;

  for (let step = 1; step <= 8 && !wizardDone; step++) {
    await sleep(3000); // Wait for SPA to render step

    const s = await page.evaluate(new Function(`
      ${SHADOW_HELPERS};
      return {
        hasRadio:     !!deepFindRadio(0),
        hasInput:     !!deepFindInput(),
        hasTextarea:  !!deepFindTextarea(),
        hasContinuar: !!deepFindButton('Continuar'),
        hasFinalizar: !!deepFindButton('Finalizar'),
        hasConfigurar: !!deepFindButton('Configurar programa'),
        hasEditar:    !!deepFindButton('Editar programa'),
      };
    `)).catch(() => ({}));

    log.info(`[${productId}] Wizard step ${step}: ${JSON.stringify(s)}`);

    if (s.hasEditar) {
      log.info(`[${productId}] Wizard: "Editar programa" appeared — already configured`);
      wizardDone = true; break;
    }
    if (!s.hasContinuar && !s.hasFinalizar && !s.hasTextarea) {
      log.warn(`[${productId}] Wizard step ${step}: no actionable element — stopping`);
      break;
    }

    if (s.hasTextarea || s.hasFinalizar) {
      // Final step: description + Finalizar
      log.info(`[${productId}] Wizard step ${step}: FINAL — entering description`);

      if (s.hasTextarea) {
        // Phase 1: Fill textarea using ElementHandle.type() (uses CDP DOM.focus = reliable focus)
        // Previous approach (page.mouse.click + page.keyboard.type) may fail if an overlay
        // absorbs the click, leaving focus on the wrong element.

        // 1a. Get textarea info and element handle
        const taInfo = await page.evaluate(new Function(`
          ${SHADOW_HELPERS};
          const ta = deepFindTextarea();
          if (!ta) return null;
          const r = ta.getBoundingClientRect();
          return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
                   name: ta.name, id: ta.id, w: Math.round(r.width), h: Math.round(r.height),
                   taClass: (ta.className||'').slice(0,40) };
        `)).catch(() => null);
        log.info(`[${productId}] Wizard step ${step}: textarea=${JSON.stringify(taInfo)}`);

        const taHandle = await page.evaluateHandle(new Function(`
          ${SHADOW_HELPERS}; return deepFindTextarea();
        `)).catch(() => null);
        const taEl = taHandle && taHandle.asElement ? taHandle.asElement() : null;

        let typedOk = false;
        if (taEl) {
          try {
            // Use ElementHandle methods: CDP DOM.focus + trusted key events
            await taEl.click();  // ElementHandle.click uses exact bbox coords
            await sleep(200);
            // Select all and clear
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Delete');
            await sleep(100);
            await taEl.type(description, { delay: 12 }); // ElementHandle.type → DOM.focus + keystrokes
            await sleep(400);
            await page.keyboard.press('Tab'); // blur → triggers validation
            await sleep(600);

            // Check state immediately after typing
            const afterType = await page.evaluate(new Function(`
              ${SHADOW_HELPERS};
              const ta = deepFindTextarea();
              const btn = deepFindButton('Finalizar');
              const active = document.activeElement;
              // also check all framework properties on btn and ta
              const btnKeys = btn ? Object.getOwnPropertyNames(btn).filter(k=>k.startsWith('_')||k.startsWith('__')).slice(0,10) : [];
              return {
                taVal: ta ? ta.value.slice(0,30) : null,
                btnDisabled: btn ? btn.disabled : null,
                activeEl: active ? active.tagName : null,
                btnKeys,
              };
            `));
            log.info(`[${productId}] Wizard step ${step}: afterType=${JSON.stringify(afterType)}`);
            typedOk = afterType.btnDisabled === false; // button enabled by typing alone!
          } catch(e) {
            log.warn(`[${productId}] Wizard step ${step}: elementHandle.type failed: ${e.message.slice(0,60)}`);
          }
        }

        if (!typedOk && taInfo && taInfo.x > 0) {
          // Fallback: coordinate-based click + keyboard type
          await page.mouse.click(taInfo.x, taInfo.y);
          await sleep(300);
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await sleep(200);
          await page.keyboard.type(description, { delay: 15 });
          await sleep(500);
          await page.keyboard.press('Tab');
          await sleep(800);
        }

        // Phase 2 (React): Drive React's state directly.
        // CONFIRMED: Form is React with __reactFiber$<nonce> / __reactProps$<nonce> on elements.
        // Strategy:
        //   1. Set textarea.value via native setter (bypasses React's controlled-input guard)
        //   2. Call props.onChange → updates component's `information` state
        //   3. Wait 800ms for React async re-render (batched state update)
        //   4. Call props.onBlur → triggers validation → enables Finalizar button
        //   5. Wait 1500ms more for validation re-render
        //   6. Walk fiber tree → dispatch to ANY string-typed useState hook (not just empty)
        //   7. Dispatch native input/change events (React 17+ root-delegated listener)
        const vueResult = await page.evaluate(new Function(`
          ${SHADOW_HELPERS};
          const desc = ${JSON.stringify(description)};
          const ta = deepFindTextarea();
          if (!ta) return {error: 'no ta'};

          // 1. Set textarea value via native setter (React no-op bypass trick)
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, desc);

          const reactInfo = {};
          let reactCalled = false;
          let blurCalled  = false;

          const reactPropsKey = Object.getOwnPropertyNames(ta).find(k => k.startsWith('__reactProps$'));
          const reactFiberKey = Object.getOwnPropertyNames(ta).find(k => k.startsWith('__reactFiber$'));
          reactInfo.propsKey = !!reactPropsKey;
          reactInfo.fiberKey = !!reactFiberKey;

          const changeEvt = {target:ta, currentTarget:ta, type:'change',
                             nativeEvent:{target:ta, type:'change'},
                             preventDefault:()=>{}, stopPropagation:()=>{}};
          const blurEvt   = {target:ta, currentTarget:ta, type:'blur',
                             nativeEvent:{target:ta, type:'blur'},
                             preventDefault:()=>{}, stopPropagation:()=>{}};

          // 2a. Call React onChange — updates component state
          if (reactPropsKey) {
            const props = ta[reactPropsKey];
            reactInfo.propKeys = Object.keys(props||{}).filter(k=>k.startsWith('on')).slice(0,10);
            for (const evName of ['onChange','onInput','onBeforeInput']) {
              if (!reactCalled && typeof props[evName] === 'function') {
                try { props[evName](changeEvt); reactCalled = true; reactInfo.calledVia = evName; }
                catch(e) { reactInfo[evName+'Err'] = String(e).slice(0,60); }
              }
            }
          }

          // 2b. Parent element onChange fallback
          if (!reactCalled) {
            let ael = ta.parentElement;
            for (let i = 0; i < 5 && ael; i++) {
              const pk = Object.getOwnPropertyNames(ael).find(k => k.startsWith('__reactProps$'));
              if (pk && typeof ael[pk].onChange === 'function') {
                try { ael[pk].onChange(changeEvt); reactCalled = true; reactInfo.calledVia = 'parent@'+ael.tagName; } catch(e) {}
                break;
              }
              ael = ael.parentElement;
            }
          }

          // 3. Also dispatch native events for React 17+ root-delegated listener
          ta.dispatchEvent(new InputEvent('input',  {bubbles:true,cancelable:true,composed:true,inputType:'insertText',data:desc}));
          ta.dispatchEvent(new Event   ('change',   {bubbles:true,cancelable:true,composed:true}));

          // 4. Walk fiber tree — dispatch to ALL string-typed useState hooks
          //    (not just empty: after navigation, some hooks may already have short defaults)
          const stateUpdates = [];
          if (reactFiberKey) {
            let fiber = ta[reactFiberKey];
            let depth = 0;
            while (fiber && depth < 60) {
              let hook = fiber.memoizedState;
              let hi = 0;
              while (hook && hi < 30) {
                const ms  = hook.memoizedState;
                const dsp = hook.queue && hook.queue.dispatch;
                if (typeof dsp === 'function' && (ms === '' || ms === null || typeof ms === 'string')) {
                  try { dsp(desc); stateUpdates.push('h['+hi+']@d'+depth+'='+JSON.stringify((ms||'').slice(0,20))); } catch(e) {}
                }
                hook = hook.next; hi++;
              }
              fiber = fiber.return; depth++;
            }
          }
          if (stateUpdates.length) reactInfo.stateUpdates = stateUpdates;

          // 5. Wait 800ms for React to process onChange + fiber dispatches, then call onBlur
          return new Promise(resolve => {
            setTimeout(() => {
              // Call onBlur — often triggers form validation that enables the submit button
              if (reactPropsKey) {
                const props2 = ta[reactPropsKey];
                if (typeof props2.onBlur === 'function') {
                  try { props2.onBlur(blurEvt); blurCalled = true; reactInfo.blurCalled = true; } catch(e) { reactInfo.blurErr = String(e).slice(0,60); }
                }
              }
              // Also dispatch native blur
              ta.dispatchEvent(new FocusEvent('blur',  {bubbles:true,composed:true}));
              ta.dispatchEvent(new FocusEvent('focus', {bubbles:true,composed:true}));
              ta.dispatchEvent(new FocusEvent('blur',  {bubbles:true,composed:true}));

              // Wait another 1500ms for React validation re-render
              setTimeout(() => {
                const btn2 = deepFindButton('Finalizar');
                // Also check if FORM has onSubmit we can call directly
                const form = ta.closest('form');
                const formPropsKey = form && Object.getOwnPropertyNames(form).find(k => k.startsWith('__reactProps$'));
                reactInfo.formHasOnSubmit = !!(formPropsKey && form[formPropsKey] && typeof form[formPropsKey].onSubmit === 'function');
                resolve({
                  reactCalled,
                  blurCalled,
                  reactInfo,
                  stateUpdatesCount: stateUpdates.length,
                  taValue: (deepFindTextarea()?.value||'').slice(0,50),
                  finDisabled: btn2 ? btn2.disabled : null,
                  finExists: !!btn2,
                });
              }, 1500);
            }, 800);
          });
        `)).catch(e => ({error: String(e).slice(0, 80)}));

        log.info(`[${productId}] Wizard step ${step}: vue=${JSON.stringify(vueResult)}`);
      }

      // Check Finalizar state and click
      const finPos = await page.evaluate(new Function(`
        ${SHADOW_HELPERS};
        const btn = deepFindButton('Finalizar');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), disabled: btn.disabled };
      `)).catch(() => null);
      log.info(`[${productId}] Wizard step ${step}: Finalizar=${JSON.stringify(finPos)}`);

      if (finPos && !finPos.disabled && finPos.x > 0) {
        // Button enabled — clean click
        log.info(`[${productId}] Wizard step ${step}: clicking Finalizar (enabled)`);
        await page.mouse.click(finPos.x, finPos.y);
      } else {
        // Button still disabled — try calling form onSubmit first (React form), then force-click
        log.warn(`[${productId}] Wizard step ${step}: Finalizar disabled — trying form submit then force-click`);
        const forceResult = await page.evaluate(new Function(`
          ${SHADOW_HELPERS};
          const ta  = deepFindTextarea();
          const btn = deepFindButton('Finalizar');
          const form = ta && ta.closest('form');
          const result = { formSubmit: false, forceClick: false };

          // Try React form onSubmit directly
          if (form) {
            const fpk = Object.getOwnPropertyNames(form).find(k => k.startsWith('__reactProps$'));
            if (fpk && typeof form[fpk].onSubmit === 'function') {
              try {
                const fakeSubmit = {target:form, currentTarget:form, type:'submit',
                                    preventDefault:()=>{}, stopPropagation:()=>{}};
                form[fpk].onSubmit(fakeSubmit);
                result.formSubmit = true;
              } catch(e) { result.formSubmitErr = String(e).slice(0,60); }
            }
          }

          // Also remove disabled attr and fire click
          if (btn) {
            btn.removeAttribute('disabled');
            btn.disabled = false;
            btn.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, composed:true}));
            result.forceClick = true;
          }
          return result;
        `)).catch(e => ({error: String(e).slice(0,60)}));
        log.info(`[${productId}] Wizard step ${step}: force result=${JSON.stringify(forceResult)}`);
      }

      // Wait for page to update
      await sleep(10000);
      wizardDone = true; break;
    }

    if (s.hasRadio) {
      // Radio step: click first option, then Continuar
      log.info(`[${productId}] Wizard step ${step}: radio — clicking option[0] + Continuar`);
      await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindRadio(0)?.click();`));
      await sleep(500);
      await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
      continue;
    }

    if (s.hasInput && !commissionSet) {
      // First input step: enter commission
      log.info(`[${productId}] Wizard step ${step}: commission input — typing "${commDigits}"`);
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
      `)).catch(() => 'error');
      log.info(`[${productId}] Wizard step ${step}: commission field = "${commValue}"`);
      commissionSet = true;
      await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
      continue;
    }

    if (s.hasInput && commissionSet) {
      // Subsequent input step (e.g., max affiliates, other setting): accept default
      log.info(`[${productId}] Wizard step ${step}: extra input — clicking Continuar (default)`);
      await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
      continue;
    }

    if (s.hasContinuar) {
      // No input, no radio, just Continuar: informational step
      log.info(`[${productId}] Wizard step ${step}: Continuar only — clicking`);
      await page.evaluate(new Function(`${SHADOW_HELPERS}; deepFindButton('Continuar')?.click();`));
      continue;
    }
  }

  if (!wizardDone) {
    log.warn(`[${productId}] Wizard loop ended without reaching Finalizar`);
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

  // Read current token from localStorage (may be expired)
  const rawToken = await page.evaluate(() => localStorage.getItem('token') || '').catch(() => '');

  // Extend JWT expiry to prevent OIDC re-auth on product pages.
  // Many SPAs decode JWT payload without verifying signature to check exp locally.
  // We also intercept the OIDC token endpoint to return this extended token so the
  // SPA's OIDC callback receives a "fresh" token and stops the auth loop.
  const extToken = extendJWTExpiry(rawToken || jwt || '');
  if (extToken && extToken !== (rawToken || jwt)) {
    log.info('JWT exp extended by 48h to prevent OIDC re-auth');
  }

  if (extToken) {
    // Inject extended token into the current page's localStorage
    await page.evaluate((t) => {
      localStorage.setItem('token', t);
      try {
        window.dispatchEvent(new StorageEvent('storage', { key: 'token', newValue: t, storageArea: localStorage }));
      } catch (_) {}
    }, extToken).catch(() => {});

    // Inject extended token into every future page navigation (before SPA scripts run)
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem('token', t); } catch (_) {}
    }, extToken).catch(() => {});
  }

  // Enable single master CDP intercept covering all SSO/OIDC endpoints.
  // Do this ONCE in launchHotmartBrowser; don't create additional sessions per-product.
  await enableMasterCDPIntercept(page, extToken || rawToken, 'browser');

  const token = extToken || rawToken;
  log.info(`Token present: ${!!token} (extended: ${extToken !== rawToken})`);

  return { browser, page, jwt, token, extToken };
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
