/**
 * publisherAmazon.js — Publica e-book no Amazon KDP via Puppeteer
 *
 * Features:
 *  - Auto step-up signin (KDP requires fresh auth for new-title creation)
 *  - Amazon a-button UI kit selectors
 *  - Screenshots at each step for debugging
 *  - Session refresh after successful signin
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let log;
try {
  const L = require('../core/Logger');
  log = L.createLogger ? L.createLogger('amazon') : { info: console.log, warn: console.warn, error: console.error };
} catch(e) {
  log = { info: (...a) => console.log('[amazon]', ...a), warn: (...a) => console.warn('[amazon]', ...a), error: (...a) => console.error('[amazon]', ...a) };
}

const BASE_URL        = 'https://kdp.amazon.com';
const BOOKSHELF_URL   = 'https://kdp.amazon.com/pt_BR/bookshelf';
const NEW_TITLE_URL   = 'https://kdp.amazon.com/pt_BR/title-setup/kindle/new';
const SESSION_FILE    = process.env.AMAZON_SESSION_FILE || '/app/data/sessions/amazon.json';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR   || '/app/data/landing_screenshots';
const LOGS_DIR        = '/app/data/logs';
const AUTHOR_NAME     = process.env.KDP_AUTHOR_NAME || process.env.AUTHOR_NAME || 'GENIA Publishing';
const KDP_EMAIL       = process.env.KDP_EMAIL    || '';
const KDP_PASSWORD    = process.env.KDP_PASSWORD || '';
const DEFAULT_PRICE   = parseFloat(process.env.EBOOK_PRICE || '4.99');

// ── Session ──────────────────────────────────────────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch(e) { log.warn('Erro sessão Amazon: '+e.message); return null; }
}

async function saveSession(page) {
  try {
    const cookies = await page.cookies();
    const session = loadSession() || {};
    session.cookies = cookies;
    session.savedAt = Date.now();
    session.savedAtHuman = new Date().toLocaleString('pt-BR');
    session.lastRenewed = new Date().toISOString();
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    log.info('Sessão Amazon atualizada (' + cookies.length + ' cookies)');
  } catch(e) { log.warn('Erro ao salvar sessão: ' + e.message); }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const f = path.join(LOGS_DIR, 'amazon_' + label + '.png');
    await page.screenshot({ path: f, fullPage: false });
    log.info('Screenshot: ' + f);
  } catch {}
}

// ── Signin helper ─────────────────────────────────────────────────────────────
async function doSignin(page) {
  if (!KDP_EMAIL || !KDP_PASSWORD) {
    log.warn('Sem credenciais KDP (KDP_EMAIL/KDP_PASSWORD não configurados)');
    return false;
  }
  log.info('Fazendo login no KDP com ' + KDP_EMAIL);

  // Check if we're on a signin page
  const url = page.url();
  if (!url.includes('signin') && !url.includes('ap/signin') && !url.includes('/auth')) {
    log.info('Não está na página de signin, pulando');
    return true;
  }

  await screenshot(page, 'signin_before');

  // Detect if page shows a different account and click "Trocar contas" to switch
  try {
    const pageInfo = await page.evaluate((kdpEmail) => {
      // Check what account/email is shown on the page
      const shownEmail = (document.querySelector('.ap_customer_name + *, .displayEmail, [class*="email" i]') || {}).textContent || '';
      // Look for "Trocar contas" or "Change account" link
      const allLinks = Array.from(document.querySelectorAll('a, button, span[role="link"]'));
      const switchEl = allLinks.find(el => {
        const t = (el.textContent || '').toLowerCase().trim();
        return t.includes('trocar conta') || t.includes('change account') || t.includes('mudar conta');
      });
      const switchPos = switchEl ? (() => {
        const r = switchEl.getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width/2, y: r.top + r.height/2 } : null;
      })() : null;
      return { shownEmail: shownEmail.trim().slice(0, 80), switchPos };
    }, KDP_EMAIL);

    if (pageInfo.shownEmail) log.info('Conta na página: "' + pageInfo.shownEmail + '" (KDP_EMAIL: ' + KDP_EMAIL + ')');

    if (pageInfo.switchPos && pageInfo.shownEmail && !pageInfo.shownEmail.includes(KDP_EMAIL)) {
      log.info('Email diferente detectado — clicando "Trocar contas"...');
      await page.mouse.click(pageInfo.switchPos.x, pageInfo.switchPos.y);
      await sleep(3000);
      await screenshot(page, 'signin_after_switch');
    }
  } catch(e) { log.warn('Switch account check: ' + e.message); }

  // Email step
  try {
    // Use coordinates-based click to avoid "not clickable" element handle issues
    const emailPos = await page.evaluate(() => {
      const sel = ['input[type="email"]', 'input[name="email"]', '#ap_email', 'input[id*="email"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
      }
      return null;
    });
    if (emailPos) {
      await page.mouse.click(emailPos.x, emailPos.y, { clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(KDP_EMAIL, { delay: 30 });
      await sleep(400);
      // Click "Continuar" / "Continue" button
      const contPos = await page.evaluate(() => {
        const sel = ['#continue', 'input[id="continue"]', 'input[type="submit"]', 'button[type="submit"]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
          }
        }
        return null;
      });
      if (contPos) { await page.mouse.click(contPos.x, contPos.y); await sleep(3000); }
      else { log.warn('Email continue button not found'); }
    } else { log.warn('Email input not found on signin page — skipping email step (password-only page)'); }
  } catch(e) { log.warn('Email step error: ' + e.message); }

  await screenshot(page, 'signin_after_email');

  // Password step
  try {
    const passPos = await page.evaluate(() => {
      const sel = ['input[type="password"]', 'input[name="password"]', '#ap_password', 'input[id*="password"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
      }
      return null;
    });
    if (passPos) {
      await page.mouse.click(passPos.x, passPos.y, { clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(KDP_PASSWORD, { delay: 30 });
      await sleep(400);
      const signInPos = await page.evaluate(() => {
        const sel = ['#signInSubmit', 'input[id="signInSubmit"]', 'input[type="submit"]', 'button[type="submit"]'];
        for (const s of sel) {
          const el = document.querySelector(s);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2 };
          }
        }
        return null;
      });
      if (signInPos) { await page.mouse.click(signInPos.x, signInPos.y); await sleep(6000); }
      else { log.warn('Password submit button not found'); }
    } else { log.warn('Password input not found'); }
  } catch(e) { log.warn('Password step error: ' + e.message); }

  await screenshot(page, 'signin_after_password');

  // Check for OTP / MFA
  const otp = await page.$('input[name="otpCode"],input[id*="otp" i],input[id*="mfa" i]').catch(() => null);
  if (otp) {
    log.warn('Amazon pedindo OTP/MFA — não é possível continuar automaticamente');
    return false;
  }

  // Check if we're now logged in
  const finalUrl = page.url();
  const isSignedIn = !finalUrl.includes('signin') && !finalUrl.includes('ap/signin');
  log.info('Signin resultado: ' + (isSignedIn ? 'OK' : 'FALHOU') + ' url=' + finalUrl.slice(0, 80));

  if (isSignedIn) {
    await saveSession(page);
  }
  return isSignedIn;
}

// ── Click Amazon-style button by text ─────────────────────────────────────────
async function clickKdpButton(page, texts, timeout = 20000) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page.evaluate((arr) => {
      // Strategy 1: .a-button-primary input (Amazon UI kit)
      const primaryContainer = document.querySelector('.a-button-primary, .a-button-submit');
      if (primaryContainer) {
        const input = primaryContainer.querySelector('input.a-button-input, button, input[type="submit"]');
        if (input) {
          const r = input.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            input.click();
            return 'primary-btn';
          }
        }
      }

      // Strategy 2: search all button-like elements by text
      const candidates = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], input.a-button-input, a.a-button-anchor'
      ));
      for (const text of arr) {
        const tl = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        // check textContent and value
        for (const el of candidates) {
          const elText = (el.textContent || el.value || '').trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (elText === tl || elText.includes(tl))) {
            el.click();
            return (el.textContent || el.value || '').trim().slice(0, 40);
          }
        }
        // Also check span.a-button-text or any span text
        const allEls = Array.from(document.querySelectorAll('span, div, a'));
        for (const el of allEls) {
          const children = el.children;
          if (children.length > 0) continue; // only leaf nodes
          const elText = (el.textContent || '').trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '');
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.height < 80 && (elText === tl || elText.includes(tl))) {
            el.click();
            return elText.slice(0, 40);
          }
        }
      }
      return null;
    }, arr);

    if (result) {
      log.info('KDP button clicked: "' + result + '"');
      return true;
    }
    await sleep(600);
  }

  // Debug: dump visible buttons
  const visible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input[type="submit"], .a-button-text'))
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent || e.value || '').trim().slice(0, 40))
      .filter(Boolean)
  ).catch(() => []);
  log.warn('KDP button not found. Texts: ' + arr.join(', ') + '. Visible: ' + visible.join(' | '));
  return false;
}

// ── Fill field helper ─────────────────────────────────────────────────────────
async function fillField(page, selectors, value) {
  const arr = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of arr) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await sleep(100);
        await el.type(String(value), { delay: 20 });
        return true;
      }
    } catch {}
  }
  return false;
}

// ── Fill description (CKEditor / contenteditable / textarea) ─────────────────
async function fillDescription(page, text) {
  const desc = String(text).slice(0, 4000);

  // Try CKEditor iframe body
  try {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const body = await frame.$('body[contenteditable="true"]');
        if (body) {
          await body.click({ clickCount: 3 });
          await sleep(200);
          await body.type(desc, { delay: 10 });
          log.info('Description via CKEditor iframe');
          return true;
        }
      } catch {}
    }
  } catch {}

  // Try contenteditable div
  try {
    const ce = await page.$('[contenteditable="true"]');
    if (ce) {
      await ce.click({ clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(desc, { delay: 10 });
      log.info('Description via contenteditable');
      return true;
    }
  } catch {}

  // Fallback: textarea
  const filled = await fillField(page, [
    'textarea[id*="description" i]',
    'textarea[name*="description" i]',
    'textarea[placeholder*="descrição" i]',
    'textarea[placeholder*="description" i]',
    'textarea',
  ], desc);
  if (filled) { log.info('Description via textarea'); return true; }

  log.warn('Description field not found');
  return false;
}

// ── Wait for URL change ───────────────────────────────────────────────────────
async function waitForUrlChange(page, fromUrl, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(1000);
    if (page.url() !== fromUrl) return true;
  }
  return false;
}

// ── Main publisher ────────────────────────────────────────────────────────────
async function publishToAmazon(ebook) {
  log.info('Amazon KDP: publicando "' + ebook.title + '"');

  const session = loadSession();
  if (!session) {
    log.warn('Sessão Amazon não encontrada');
    return { success: false, error: 'Sessão não configurada', platform: 'amazon' };
  }
  if (!KDP_EMAIL || !KDP_PASSWORD) {
    log.warn('KDP_EMAIL/KDP_PASSWORD não configurados');
    return { success: false, error: 'Credenciais KDP não configuradas', platform: 'amazon' };
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--lang=pt-BR', '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });

  try {
    // ── Inject session ────────────────────────────────────────────────────────
    log.info('Injetando sessão Amazon...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(1000);

    for (const cookie of (session.cookies || [])) {
      try {
        const c = { ...cookie };
        // Ensure correct domain for amazon.com
        if (!c.domain) c.domain = '.amazon.com';
        if (c.domain === '.amazon.com.br') c.domain = '.amazon.com';
        await page.setCookie(c);
      } catch {}
    }

    // ── Verify session ────────────────────────────────────────────────────────
    await page.goto(BOOKSHELF_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    let currentUrl = page.url();

    if (currentUrl.includes('signin') || currentUrl.includes('ap/signin')) {
      log.warn('Sessão expirada no bookshelf — tentando login...');
      const ok = await doSignin(page);
      if (!ok) {
        await browser.close();
        return { success: false, error: 'Sessão expirada e login falhou', platform: 'amazon' };
      }
      await page.goto(BOOKSHELF_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(2000);
    }
    log.info('Sessão Amazon válida: ' + page.url().slice(0, 60));

    // ── Navigate to new title ────────────────────────────────────────────────
    await page.goto(NEW_TITLE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(4000);
    currentUrl = page.url();

    // Handle step-up auth if redirected to signin
    if (currentUrl.includes('signin') || currentUrl.includes('ap/signin')) {
      log.info('Step-up auth necessário para criar título — fazendo login...');
      const ok = await doSignin(page);
      if (!ok) {
        await screenshot(page, 'signin_failed');
        await browser.close();
        return { success: false, error: 'Step-up auth falhou (OTP ou credenciais inválidas)', platform: 'amazon' };
      }
      // Navigate back to new title after signin
      await page.goto(NEW_TITLE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(4000);
      currentUrl = page.url();
      if (currentUrl.includes('signin')) {
        log.warn('Ainda redirecionando após login');
        await screenshot(page, 'still_signin');
        await browser.close();
        return { success: false, error: 'Não foi possível acessar new-title após login', platform: 'amazon' };
      }
    }
    log.info('Etapa 1 URL: ' + currentUrl.slice(0, 80));
    await screenshot(page, 'step1_start');

    // ── STEP 1: Book details ─────────────────────────────────────────────────
    log.info('Etapa 1: Detalhes do livro');
    await sleep(2000); // let form render

    // Language
    try {
      await page.select('select[name*="language" i], select[id*="language" i]', 'pt').catch(() => {});
    } catch {}

    // Title
    const titleFilled = await fillField(page, [
      'input[id*="title" i]:not([id*="sub" i]):not([id*="series" i])',
      'input[name*="title" i]:not([name*="sub" i])',
      'input[placeholder*="título" i]',
      'input[placeholder*="title" i]',
    ], ebook.title);
    log.info('Title filled: ' + titleFilled);
    await sleep(300);

    // Subtitle (optional)
    if (ebook.subtitle) {
      await fillField(page, [
        'input[id*="subtitle" i]',
        'input[name*="subtitle" i]',
        'input[placeholder*="subtítulo" i]',
      ], ebook.subtitle).catch(() => {});
      await sleep(300);
    }

    // Author — KDP has first/last name fields
    const authorFilled = await fillField(page, [
      'input[id*="author-first" i], input[id*="firstname" i], input[id*="first_name" i]',
    ], 'GENIA').catch(() => false);

    if (!authorFilled) {
      // Try single author field
      await fillField(page, [
        'input[id*="author" i]',
        'input[name*="author" i]',
        'input[placeholder*="autor" i]',
      ], AUTHOR_NAME).catch(() => {});
    } else {
      await fillField(page, [
        'input[id*="author-last" i], input[id*="lastname" i], input[id*="last_name" i]',
      ], 'Publishing').catch(() => {});
    }
    await sleep(300);

    // Description
    const desc = (ebook.description || ('Guia completo sobre ' + ebook.title)).slice(0, 4000);
    await fillDescription(page, desc);
    await sleep(400);

    // Keywords (up to 7)
    const kw = (ebook.keywords || ebook.topic || ebook.title);
    const kwArr = typeof kw === 'string' ? kw.split(',').map(k => k.trim()).slice(0, 7) : [String(kw)];
    for (let i = 0; i < kwArr.length; i++) {
      await fillField(page, [
        `input[id*="keyword-${i}" i]`,
        `input[name*="keyword${i}" i]`,
        `input[id*="keywords-${i}" i]`,
        `#search-keywords-${i}`,
      ], kwArr[i]).catch(() => {});
    }
    // Also try the first keyword field generically
    if (kwArr.length === 1) {
      await fillField(page, ['input[id*="keyword" i]', 'input[name*="keyword" i]'], kwArr[0]).catch(() => {});
    }
    await sleep(300);

    await screenshot(page, 'step1_filled');

    // Save and continue (Step 1 → Step 2)
    const step1Url = page.url();
    const step1ok = await clickKdpButton(page, [
      'Salvar e continuar', 'Save and continue', 'Salvar e Continuar',
      'Continuar', 'Continue', 'Próximo', 'Next', 'Salvar',
    ]);
    if (step1ok) await waitForUrlChange(page, step1Url, 15000);
    await sleep(4000);
    await screenshot(page, 'step2_start');
    log.info('Etapa 2 URL: ' + page.url().slice(0, 80));

    // ── STEP 2: Content upload ───────────────────────────────────────────────
    log.info('Etapa 2: Upload de conteúdo');

    // DRM — select "no DRM"
    try {
      await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const v = (r.value || r.id || '').toLowerCase();
          if (v.includes('no_drm') || v.includes('none') || v.includes('false') || v === '0') {
            r.click();
            break;
          }
        }
      });
      await sleep(300);
    } catch {}

    // Upload manuscript (PDF)
    if (ebook.pdfPath && fs.existsSync(ebook.pdfPath)) {
      log.info('Upload manuscrito: ' + ebook.pdfPath);

      // First try to trigger the upload dialog if needed
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = btns.find(e => {
          const t = (e.textContent || '').toLowerCase();
          return t.includes('manuscrito') || t.includes('manuscript') ||
                 t.includes('upload') || t.includes('enviar arquivo') || t.includes('arquivo');
        });
        if (btn && btn.getBoundingClientRect().width > 0) btn.click();
      });
      await sleep(1500);

      // Find file input
      const msInput = await page.$([
        'input[type="file"][id*="manuscript" i]',
        'input[type="file"][id*="book_file" i]',
        'input[type="file"][id*="contentFile" i]',
        'input[type="file"][accept*="pdf" i]',
        'input[type="file"]:not([id*="cover" i]):not([id*="thumbnail" i])',
      ].join(','))
        .catch(() => null)
        ?? await page.$('input[type="file"]').catch(() => null);

      if (msInput) {
        await msInput.uploadFile(ebook.pdfPath);
        log.info('Aguardando processamento KDP (~40s)...');
        await sleep(40000);
        await screenshot(page, 'step2_after_manuscript');
      } else {
        log.warn('Manuscript file input not found');
      }
    }

    // Upload cover
    if (ebook.coverPath && fs.existsSync(ebook.coverPath)) {
      log.info('Upload capa KDP...');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const btn = btns.find(e => {
          const t = (e.textContent || '').toLowerCase();
          return t.includes('capa') || t.includes('cover') || t.includes('imagem') || t.includes('image');
        });
        if (btn && btn.getBoundingClientRect().width > 0) btn.click();
      });
      await sleep(1500);

      const coverInput = await page.$([
        'input[type="file"][id*="cover" i]',
        'input[type="file"][accept*="image" i]',
        'input[type="file"][id*="thumbnail" i]',
      ].join(','))
        .catch(() => null);

      if (coverInput) {
        await coverInput.uploadFile(ebook.coverPath);
        await sleep(8000);
        await screenshot(page, 'step2_after_cover');
      } else {
        log.warn('Cover file input not found');
      }
    }

    const step2Url = page.url();
    const step2ok = await clickKdpButton(page, [
      'Salvar e continuar', 'Save and continue', 'Salvar e Continuar',
      'Continuar', 'Continue', 'Próximo', 'Next', 'Salvar',
    ]);
    if (step2ok) await waitForUrlChange(page, step2Url, 20000);
    await sleep(5000);
    await screenshot(page, 'step3_start');
    log.info('Etapa 3 URL: ' + page.url().slice(0, 80));

    // ── STEP 3: Pricing ──────────────────────────────────────────────────────
    log.info('Etapa 3: Precificação');

    // Publishing rights: worldwide
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        const v = (r.value || '').toUpperCase();
        if (v === 'WORLD' || v === 'WORLDWIDE' || r.id?.toLowerCase().includes('worldwide')) {
          r.click(); break;
        }
      }
    }).catch(() => {});
    await sleep(300);

    // Royalty: 35% (compatible with all prices)
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        const v = (r.value || '').toLowerCase();
        if (v.includes('35') || r.id?.toLowerCase().includes('35')) { r.click(); break; }
      }
    }).catch(() => {});
    await sleep(300);

    // Price in USD (KDP's primary marketplace for global)
    const priceUsd = Math.max(0.99, DEFAULT_PRICE * 0.18).toFixed(2);
    const priceFilled = await fillField(page, [
      'input[id*="us-price" i]', 'input[id*="us_price" i]',
      'input[id*="USD" i]', 'input[id*="usd" i]',
      'input[id*="price-USD" i]',
    ], priceUsd);
    log.info('USD price: $' + priceUsd + ' filled=' + priceFilled);
    await sleep(500);

    await screenshot(page, 'step3_pricing');

    // Publish!
    log.info('Publicando no KDP...');
    const step3Url = page.url();
    const published = await clickKdpButton(page, [
      'Publicar e-book Kindle', 'Publish Your Kindle eBook',
      'Salvar e publicar', 'Save and publish',
      'Publicar', 'Publish',
      'Salvar e continuar', 'Save and continue',
    ], 25000);
    if (published) await waitForUrlChange(page, step3Url, 15000);
    await sleep(6000);

    const finalUrl = page.url();
    log.info('Amazon KDP done! published=' + published + ' URL: ' + finalUrl.slice(0, 80));
    await screenshot(page, 'step3_done');

    // Save updated session
    await saveSession(page);

    await browser.close();
    return { success: published, url: finalUrl, platform: 'amazon' };

  } catch (err) {
    log.error('Amazon error: ' + err.message);
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(LOGS_DIR, 'amazon_error.png') }).catch(() => {});
    } catch {}
    await browser.close().catch(() => {});
    return { success: false, error: err.message, platform: 'amazon' };
  }
}

module.exports = { publishToAmazon };
