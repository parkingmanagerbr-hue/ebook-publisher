'use strict';
/**
 * complete-kdp-drafts.js
 *
 * Completes existing KDP draft e-books: uploads cover, sets DRM + AI flags,
 * configures pricing at $4.99 / 70% royalty, publishes, and updates the DB.
 *
 * Usage (inside Docker):
 *   docker exec platform-ebook-publisher-1 node /app/scripts/complete-kdp-drafts.js
 */

const puppeteer = require('/app/node_modules/puppeteer');
const fs        = require('fs');
const path      = require('path');
const Database  = require('better-sqlite3');

// ── Logger ───────────────────────────────────────────────────────────────────
let log;
try {
  const { createLogger } = require('/app/src/core/logger');
  log = createLogger('kdp-complete');
} catch (e) {
  const prefix = '[kdp-complete]';
  log = {
    info:  (...a) => console.log(prefix,  ...a),
    warn:  (...a) => console.warn(prefix, ...a),
    error: (...a) => console.error(prefix, ...a),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const SESSION_FILE  = '/app/data/sessions/amazon.json';
const OTP_FILE      = '/app/data/amazon_otp.txt';
const LOGS_DIR      = '/app/data/logs';
const DB_PATH       = '/app/data/metrics.db';
const KDP_EMAIL     = 'm_rovariz@hotmail.com';
const KDP_PASSWORD  = 'Nu4qreq15!';
const PRICE_USD     = '4.99';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// KDP só aceita JPEG/TIFF na capa de ebook Kindle (PNG é ignorado → livro sem capa).
// Converte PNG -> JPEG 1600x2560 (1.6:1, padding preto) via ffmpeg. Prefere o _kdp.jpg do job em lote.
function convertCoverToJpeg(pngPath) {
  try {
    if (!pngPath || !fs.existsSync(pngPath)) return pngPath;
    if (/\.(jpe?g)$/i.test(pngPath)) return pngPath;
    const jpgPath = pngPath.replace(/\.[^.]+$/, '') + '_kdp.jpg';
    if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0) return jpgPath;
    const { execFileSync } = require('child_process');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', pngPath,
      '-vf', 'scale=1600:2560:force_original_aspect_ratio=decrease,pad=1600:2560:(ow-iw)/2:(oh-ih)/2:black',
      '-q:v', '2', jpgPath], { timeout: 30000 });
    if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0) {
      log.info('Capa convertida PNG->JPEG (ffmpeg KDP): ' + path.basename(jpgPath));
      return jpgPath;
    }
    return pngPath;
  } catch (e) { log.warn('convertCoverToJpeg falhou: ' + e.message.slice(0, 50)); return pngPath; }
}

// ── Books to complete ─────────────────────────────────────────────────────────
const BOOKS = [
  {
    title:    'Cachos Poderosos: Guia Definitivo de Cuidados',
    subtitle: 'Transforme seus cachos e crespos com técnicas simples e resultados duradouros',
    language: 'pt-BR',
    asin:     'AE3MFMSQJPZCE',
    cover:    '/app/data/covers/cover_html_1780358373040.png',
    pdf:      '/app/data/pdfs/ebook_1780359037261.pdf',
    description: 'Descubra como cuidar dos seus cabelos cacheados e crespos de forma prática e eficaz, alcançando fios mais hidratados, definidos e sem frizz. Este e-book traz estratégias passo a passo que vão desde a escolha dos produtos ideais até a rotina de lavagem, hidratação, finalização e proteção noturna. Você vai aprender as técnicas mais eficazes para definir os cachos, eliminar o frizz e manter os fios saudáveis todos os dias, sem gastar fortunas. Ideal para quem está começando a cuidar dos cachos ou quer aperfeiçoar a rotina capilar.',
    db_id:    'c4814b80-b094-485e-aa02-d10b8234030d',
  },
  {
    title:       'Inteligência Emocional: Guia Prático para o Sucesso',
    subtitle:    'Desenvolva, aplique e transforme sua vida pessoal e profissional',
    language:    'pt-BR',
    asin:        'A3ZK9UDX8PEHU',
    asin_delete: 'A18R9RTOW6082V',
    cover:       '/app/data/covers/cover_1780337617738.png',
    pdf:         '/app/data/pdfs/ebook_1780338432369.pdf',
    description: 'Este e-book revela como a inteligência emocional pode ser a chave para alcançar resultados extraordinários em todas as áreas da sua vida. Você aprenderá, passo a passo, a reconhecer, compreender e gerenciar suas emoções, transformando situações de tensão em oportunidades de crescimento. Descubra técnicas práticas para melhorar relacionamentos, tomar decisões com clareza e liderar com empatia.',
    db_id:       '45e56adb-35e7-4fef-8e81-8a6342037166',
  },
  {
    title:       'Dieta Low Carb: Guía Completa y Práctica',
    subtitle:    'Pierde peso, aumenta tu energía y transforma tu salud con pasos claros',
    language:    'es',
    asin:        'A9QL4PCUIBBI7',
    asin_delete: 'A5OR5XR8OFARA',
    cover:       '/app/data/covers/cover_html_1780308926457.png',
    pdf:         '/app/data/pdfs/ebook_1780309613371.pdf',
    description: 'Descubre cómo la dieta low carb puede cambiar tu vida de forma sencilla y sostenible. En esta guía aprenderás a comprender los principios científicos detrás de la reducción de carbohidratos, a diseñar menús deliciosos y a adaptar la alimentación a tu estilo de vida sin sacrificar el placer de comer.',
    db_id:       '68f73446-d16a-4689-97fb-45536149d372',
  },
  {
    title:    'Finanças Pessoais Descomplicadas',
    subtitle: 'Como organizar, economizar e investir para alcançar seus objetivos',
    language: 'pt-BR',
    asin:     'A1UX80T244NM47',
    cover:    '/app/data/covers/cover_1780304607727.png',
    pdf:      '/app/data/pdfs/ebook_1780304670154.pdf',
    description: 'Este e-book foi criado para transformar a maneira como você lida com o dinheiro, trazendo clareza, disciplina e resultados reais. Ao longo das páginas, você descobrirá como mapear cada centavo que entra e sai, identificar gastos desnecessários e montar um orçamento que realmente funciona para o seu estilo de vida.',
    db_id:    'ea792067-9688-42e7-b618-c60f63f295e4',
  },
  {
    title:    'Como Sair das Dívidas de Forma Definitiva',
    subtitle: 'Passo a passo prático para retomar o controle financeiro',
    language: 'pt-BR',
    asin:     'A3EH1OV06BYMWD',
    cover:    '/app/data/covers/cover_html_1780303939440.png',
    pdf:      '/app/data/pdfs/ebook_1780304009828.pdf',
    description: 'Este e-book traz um método comprovado para quem quer eliminar as dívidas e reconquistar a tranquilidade financeira. Em linguagem simples e direta, você descobrirá como mapear sua situação atual, criar um plano de ação realista e negociar com credores de forma eficaz.',
    db_id:    'b55e5973-f453-4d32-9c66-fc79ebb9df09',
  },
  {
    title:    'Healthy Weight Loss Without Hunger',
    subtitle: 'A practical guide to losing weight sustainably, feeling full, and thriving',
    language: 'en',
    asin:     'A11XH9UTQK20V',
    cover:    '/app/data/covers/cover_html_1780304172867.png',
    pdf:      '/app/data/pdfs/ebook_1780304239638.pdf',
    description: 'Discover how to shed pounds without feeling deprived. This e-book reveals a science-backed, hunger-free approach that lets you lose weight while still enjoying satisfying meals. You\'ll learn how to reset your mindset, choose foods that keep you full, and design meal plans that fit a busy lifestyle.',
    db_id:    '105b1244-c6ed-41fd-b26e-e5010b7cbbe0',
  },
];

// ── Session helpers ───────────────────────────────────────────────────────────
function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      log.warn('Session file not found: ' + SESSION_FILE);
      return null;
    }
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    log.error('Failed to load session: ' + e.message);
    return null;
  }
}

async function injectSession(page, session) {
  if (!session) return;

  // Inject cookies
  if (session.cookies && session.cookies.length > 0) {
    const validCookies = session.cookies.map(c => {
      const cookie = { ...c };
      // Puppeteer requires sameSite to be one of Strict/Lax/None or undefined
      if (!['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
        delete cookie.sameSite;
      }
      return cookie;
    });
    await page.setCookie(...validCookies);
    log.info(`Injected ${validCookies.length} cookies`);
  }

  // Inject localStorage if available
  if (session.localStorage && Object.keys(session.localStorage).length > 0) {
    await page.evaluateOnNewDocument((ls) => {
      for (const [key, value] of Object.entries(ls)) {
        try { localStorage.setItem(key, value); } catch {}
      }
    }, session.localStorage);
    log.info(`Injected ${Object.keys(session.localStorage).length} localStorage keys`);
  }
}

async function saveSession(page) {
  try {
    const cookies = await page.cookies();
    const session = loadSession() || {};
    session.cookies  = cookies;
    session.savedAt  = Date.now();
    session.savedAtHuman = new Date().toLocaleString('pt-BR');
    session.lastRenewed  = new Date().toISOString();
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    log.info(`Session saved (${cookies.length} cookies)`);
  } catch (e) {
    log.warn('Failed to save session: ' + e.message);
  }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const f = path.join(LOGS_DIR, `kdp_complete_${label}_${Date.now()}.png`);
    await Promise.race([
      page.screenshot({ path: f, fullPage: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 12000)),
    ]);
    log.info(`Screenshot saved: ${f}`);
  } catch (e) {
    log.warn('Screenshot failed: ' + e.message);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function isAuthUrl(url) {
  return ['signin', 'ap/signin', '/ap/cvf', 'ap/mfa', 'ap/oa', 'forgotpassword',
    'reverification', 'ap/challenge', 'signin/identifier', 'account/login',
  ].some(p => url.includes(p));
}

async function waitForOtp(page, maxMs = 300_000) {
  // If on delivery-choice page, click the submit button first
  try {
    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      const btn = document.querySelector('input[type="submit"], button[type="submit"], .a-button-primary input');
      if (radios.length > 0 && btn) btn.click();
    });
    await sleep(3000);
  } catch {}

  // Write WAITING flag
  try {
    fs.mkdirSync(path.dirname(OTP_FILE), { recursive: true });
    fs.writeFileSync(OTP_FILE, 'WAITING');
  } catch {}

  log.info(`OTP required — waiting up to ${maxMs / 60000} min`);
  log.info(`Write code: echo XXXXXX > ${OTP_FILE}`);

  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const txt = fs.readFileSync(OTP_FILE, 'utf8').trim();
      if (/^\d{4,8}$/.test(txt)) {
        log.info('OTP received: ' + txt);
        fs.writeFileSync(OTP_FILE, 'USED:' + txt);

        const otpInput = await page.$(
          'input[name="otpCode"], input[id*="otp" i], input[id*="cvf" i], input[id*="code" i], input[name="code"], input[type="number"]'
        ).catch(() => null);

        if (otpInput) {
          await otpInput.click({ clickCount: 3 });
          await sleep(200);
          await otpInput.type(txt, { delay: 50 });
          await sleep(500);
          // Mark "remember device"
          await page.evaluate(() => {
            const cb = document.querySelector('input[name="rememberDevice"], input[id*="remember" i], input[type="checkbox"]');
            if (cb && !cb.checked) cb.click();
          }).catch(() => {});
          // Submit
          await page.evaluate(() => {
            const btn = document.querySelector('input[type="submit"], button[type="submit"], .a-button-primary input');
            if (btn) btn.click();
          });
          await sleep(6000);
          await screenshot(page, 'otp_submitted');
        }
        return txt;
      }
    } catch {}
  }

  log.warn('OTP timeout (5 min)');
  return null;
}

async function doSignin(page) {
  log.info(`Signing in as ${KDP_EMAIL}`);
  await screenshot(page, 'signin_before');

  // Fill email field
  try {
    await page.waitForSelector('#ap_email, input[name="email"], input[type="email"]', { timeout: 8000 });
    const emailInput = await page.$('#ap_email, input[name="email"], input[type="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(KDP_EMAIL, { delay: 40 });
      // Click "Continue" if password field isn't visible yet
      const continueBtn = await page.$('#continue, input[id="continue"], input[type="submit"]').catch(() => null);
      if (continueBtn) {
        await continueBtn.click();
        await sleep(2000);
      }
    }
  } catch (e) {
    log.warn('Email field: ' + e.message);
  }

  // Fill password field
  try {
    await page.waitForSelector('#ap_password, input[name="password"], input[type="password"]', { timeout: 8000 });
    const pwInput = await page.$('#ap_password, input[name="password"], input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(KDP_PASSWORD, { delay: 40 });
    }
  } catch (e) {
    log.warn('Password field: ' + e.message);
  }

  // Keep me signed in
  await page.evaluate(() => {
    const cb = document.querySelector('#rememberMe, input[name="rememberMe"]');
    if (cb && !cb.checked) cb.click();
  }).catch(() => {});

  // Submit sign-in
  await page.evaluate(() => {
    const btn = document.querySelector('#signInSubmit, input[type="submit"], button[type="submit"], .a-button-primary input');
    if (btn) btn.click();
  });

  await screenshot(page, 'signin_submitted');

  // Wait for navigation
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
  } catch {}

  await screenshot(page, 'signin_after');
  const afterUrl = page.url();
  log.info('After signin URL: ' + afterUrl.slice(0, 80));

  // OTP / MFA check
  if (isAuthUrl(afterUrl) || afterUrl.includes('ap/cvf') || afterUrl.includes('ap/mfa')) {
    log.info('OTP/MFA required');
    await waitForOtp(page);
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
    } catch {}
  }

  return !isAuthUrl(page.url());
}

async function ensureAuthenticated(page) {
  const url = page.url();
  if (isAuthUrl(url)) {
    log.info('Auth wall detected, signing in...');
    const ok = await doSignin(page);
    if (!ok) throw new Error('Sign-in failed — check credentials or OTP');
  }
}

// ── KDP page helpers ──────────────────────────────────────────────────────────

/**
 * Click a radio / button by searching visible text labels or input values.
 * Returns true if clicked.
 */
async function clickByText(page, texts, containerSelector = null) {
  return page.evaluate(({ texts, containerSelector }) => {
    const root = containerSelector ? document.querySelector(containerSelector) : document;
    if (!root) return false;
    const normalized = texts.map(t => t.toLowerCase().trim());

    // Try <label> elements
    const labels = Array.from(root.querySelectorAll('label'));
    for (const lbl of labels) {
      const txt = (lbl.textContent || '').toLowerCase().trim();
      if (normalized.some(n => txt.includes(n))) {
        // Click associated input if found
        const forId = lbl.getAttribute('for');
        const inp = forId ? document.getElementById(forId) : lbl.querySelector('input');
        if (inp) { inp.click(); return true; }
        lbl.click();
        return true;
      }
    }

    // Try buttons / spans / divs with role
    const candidates = Array.from(root.querySelectorAll('button, [role="radio"], [role="button"], input[type="radio"], input[type="submit"]'));
    for (const el of candidates) {
      const txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (normalized.some(n => txt.includes(n))) {
        el.click();
        return true;
      }
    }
    return false;
  }, { texts, containerSelector });
}

/**
 * Wait for and dismiss any modal / dialog that may appear after file upload.
 */
async function dismissModal(page) {
  try {
    await page.waitForSelector('.a-alert-container, .a-modal-scroller, [role="dialog"]', { timeout: 4000 });
    await page.evaluate(() => {
      const close = document.querySelector(
        '.a-modal-close button, [aria-label="Fechar"], [aria-label="Close"], .a-modal-close'
      );
      if (close) close.click();
    });
    await sleep(1000);
  } catch {}
}

// ── Content step: upload cover + DRM + AI + save ──────────────────────────────
async function doContentStep(page, book) {
  const contentUrl = `https://kdp.amazon.com/pt_BR/title-setup/kindle/${book.asin}/content`;
  log.info(`[${book.title}] Navigating to content step: ${contentUrl}`);
  await page.goto(contentUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  await ensureAuthenticated(page);
  await sleep(2000);
  await screenshot(page, `content_loaded_${book.asin}`);

  // ── 1. Upload manuscript (PDF) ──────────────────────────────────────────────
  // Check if manuscript already uploaded (look for existing file name / success icon)
  const manuscriptAlreadyUploaded = await page.evaluate(() => {
    const indicators = document.querySelectorAll(
      '.kdp-upload-success, .book-file-name, [data-testid="book-content-upload-success"], .a-color-success'
    );
    return indicators.length > 0;
  });

  if (!manuscriptAlreadyUploaded) {
    log.info(`[${book.title}] Uploading PDF: ${book.pdf}`);
    try {
      // Find manuscript file input — typically the first file input or one labeled for manuscript
      const fileInputs = await page.$$('input[type="file"]');
      let manuscriptInput = null;
      for (const input of fileInputs) {
        const accept = await page.evaluate(el => el.getAttribute('accept') || '', input);
        const id     = await page.evaluate(el => el.id || '', input);
        if (accept.includes('pdf') || accept.includes('epub') || id.includes('book') || id.includes('manuscript') || id.includes('content')) {
          manuscriptInput = input;
          break;
        }
      }
      // Fallback: first file input that accepts application/* or pdf
      if (!manuscriptInput && fileInputs.length > 0) {
        manuscriptInput = fileInputs[0];
      }

      if (manuscriptInput) {
        await manuscriptInput.uploadFile(book.pdf);
        log.info(`[${book.title}] PDF upload initiated`);
        // Wait up to 3 min for processing
        let uploaded = false;
        for (let i = 0; i < 60; i++) {
          await sleep(3000);
          const done = await page.evaluate(() => {
            const success = document.querySelector(
              '.kdp-upload-success, [class*="upload-success"], [class*="uploadSuccess"], .a-color-success, .book-upload-result'
            );
            const processing = document.querySelector('[class*="upload-processing"], [class*="uploading"], .a-spinner');
            if (success) return 'done';
            if (processing) return 'processing';
            // Check for error
            const err = document.querySelector('[class*="upload-error"], .a-color-error, [class*="uploadError"]');
            if (err) return 'error:' + (err.textContent || '').trim().slice(0, 80);
            return 'unknown';
          });
          log.info(`[${book.title}] PDF upload status: ${done}`);
          if (done === 'done') { uploaded = true; break; }
          if (done.startsWith('error:')) { log.warn(`[${book.title}] PDF upload error: ${done}`); break; }
        }
        if (!uploaded) log.warn(`[${book.title}] PDF upload may not have completed`);
      } else {
        log.warn(`[${book.title}] No manuscript file input found`);
      }
    } catch (e) {
      log.warn(`[${book.title}] PDF upload failed: ${e.message}`);
    }
    await screenshot(page, `after_pdf_upload_${book.asin}`);
  } else {
    log.info(`[${book.title}] Manuscript already uploaded, skipping`);
  }

  // ── 2. Upload cover ─────────────────────────────────────────────────────────
  log.info(`[${book.title}] Checking cover upload...`);
  const coverAlreadyUploaded = await page.evaluate(() => {
    // Look for cover preview image or success message
    const preview = document.querySelector(
      '.cover-image img, img[alt*="cover" i], img[src*="cover" i], [class*="coverPreview"] img, [data-testid*="cover"] img'
    );
    return !!preview;
  });

  if (!coverAlreadyUploaded) {
    const coverJpeg = convertCoverToJpeg(book.cover);
    log.info(`[${book.title}] Uploading cover: ${coverJpeg}`);
    try {
      // Find cover file input
      const fileInputs = await page.$$('input[type="file"]');
      let coverInput = null;
      for (const input of fileInputs) {
        const accept = await page.evaluate(el => el.getAttribute('accept') || '', input);
        const id     = await page.evaluate(el => (el.id || el.name || '').toLowerCase(), input);
        const isImage = accept.includes('image') || accept.includes('jpeg') || accept.includes('png');
        const hasCoverLabel = id.includes('cover') || id.includes('imagen') || id.includes('imagem');
        if (isImage || hasCoverLabel) {
          coverInput = input;
          break;
        }
      }
      // Fallback: last file input (cover is often the second one)
      if (!coverInput && fileInputs.length > 1) {
        coverInput = fileInputs[fileInputs.length - 1];
      }

      if (coverInput) {
        await coverInput.uploadFile(coverJpeg);
        log.info(`[${book.title}] Cover upload initiated`);

        // Wait for cover preview / success. Detecção robusta: a miniatura da capa
        // (img grande, ratio ~1.6, blob:/data:/media-amazon) aparece quando o upload conclui.
        let coverDone = false;
        for (let i = 0; i < 30; i++) {
          await sleep(3000);
          const status = await page.evaluate(() => {
            const imgs = [...document.querySelectorAll('img')];
            const cover = imgs.find(im => {
              const w = im.naturalWidth || 0, h = im.naturalHeight || 0;
              const src = im.src || '';
              const looksCover = /blob:|data:image|\/images\/[IP]\/|media-amazon/i.test(src) || /cover|capa/i.test((im.alt || '') + (im.className || ''));
              return looksCover && w > 120 && h > 150 && h >= w; // retrato, tamanho real
            });
            if (cover) return 'done';
            const success = document.querySelector('[class*="cover-success"], [class*="coverSuccess"], [class*="upload-success"]');
            if (success) return 'done';
            const txt = document.body.innerText || '';
            if (/capa.*(carregad|conclu|sucesso)|cover.*(uploaded|success)/i.test(txt)) return 'done';
            const spinner = document.querySelector('.a-spinner, [class*="uploading"], [class*="processing"], [class*="spinner"]');
            return spinner ? 'processing' : 'waiting';
          });
          if (i % 4 === 0 || status === 'done') log.info(`[${book.title}] Cover upload status: ${status}`);
          if (status === 'done') { coverDone = true; break; }
        }
        if (coverDone) log.info(`[${book.title}] ✅ Capa confirmada (preview visível)`);
        else log.warn(`[${book.title}] Cover upload may not have completed`);
        await dismissModal(page);
      } else {
        log.warn(`[${book.title}] No cover file input found`);
      }
    } catch (e) {
      log.warn(`[${book.title}] Cover upload failed: ${e.message}`);
    }
    await screenshot(page, `after_cover_upload_${book.asin}`);
  } else {
    log.info(`[${book.title}] Cover already uploaded, skipping`);
  }

  // ── 3. DRM — click "Sim" in the DRM section ─────────────────────────────────
  log.info(`[${book.title}] Setting DRM...`);
  try {
    // KDP DRM section: radio inputs where value is "true"/"false" inside a DRM-labeled section
    const drmSet = await page.evaluate(() => {
      // Try to find the DRM section by heading text
      const allSections = Array.from(document.querySelectorAll('.a-section, .kdp-section, fieldset, .book-setup-section'));
      for (const section of allSections) {
        const heading = (section.querySelector('h2, h3, legend, label, .a-form-label') || {}).textContent || '';
        if (heading.toLowerCase().includes('drm') || heading.toLowerCase().includes('proteção')) {
          // Find the "Sim" / "Yes" / "true" radio inside this section
          const radios = section.querySelectorAll('input[type="radio"]');
          for (const r of radios) {
            const val  = (r.value || '').toLowerCase();
            const lbl  = document.querySelector(`label[for="${r.id}"]`);
            const lblTxt = (lbl ? lbl.textContent : '').toLowerCase().trim();
            if (val === 'true' || val === 'yes' || lblTxt.includes('sim') || lblTxt.includes('yes')) {
              r.click();
              return true;
            }
          }
        }
      }
      // Fallback: any radio with value="true" near text "DRM"
      const allRadios = Array.from(document.querySelectorAll('input[type="radio"][value="true"], input[type="radio"][value="yes"]'));
      if (allRadios.length > 0) {
        allRadios[0].click();
        return true;
      }
      return false;
    });
    if (drmSet) {
      log.info(`[${book.title}] DRM set to Sim`);
    } else {
      // Try clicking by label text
      const clicked = await clickByText(page, ['sim', 'yes', 'enable drm', 'ativar drm']);
      log.info(`[${book.title}] DRM click by text: ${clicked}`);
    }
  } catch (e) {
    log.warn(`[${book.title}] DRM selection failed: ${e.message}`);
  }

  // ── 4. AI content — click "Não" (this is NOT AI-generated by humans; use Não) ─
  // KDP asks "Does this content contain AI-generated material?"
  // For a mostly human-reviewed book we mark "Não contém" or the relevant option.
  // Based on KDP's actual UI we need to handle multiple possible versions.
  log.info(`[${book.title}] Setting AI content declaration...`);
  try {
    const aiSet = await page.evaluate(() => {
      // Look for AI content section
      const sections = Array.from(document.querySelectorAll('.a-section, fieldset, .book-setup-section, .kdp-section'));
      for (const section of sections) {
        const text = (section.textContent || '').toLowerCase();
        if (text.includes('inteligência artificial') || text.includes('ai-generated') || text.includes('artificial intelligence') || text.includes('conteúdo gerado por ia')) {
          // Click the "Sim" radio (we are declaring AI was used)
          const radios = section.querySelectorAll('input[type="radio"]');
          for (const r of radios) {
            const lbl = document.querySelector(`label[for="${r.id}"]`);
            const lblTxt = (lbl ? lbl.textContent : (r.value || '')).toLowerCase().trim();
            if (lblTxt.includes('sim') || lblTxt.includes('yes') || r.value === 'true') {
              r.click();
              return 'clicked-yes';
            }
          }
          // Fallback: click first radio in section
          if (radios.length > 0) { radios[0].click(); return 'clicked-first'; }
        }
      }
      return 'not-found';
    });
    log.info(`[${book.title}] AI content section result: ${aiSet}`);
  } catch (e) {
    log.warn(`[${book.title}] AI content selection failed: ${e.message}`);
  }

  await screenshot(page, `before_save_content_${book.asin}`);

  // ── 5. Save and Continue ────────────────────────────────────────────────────
  log.info(`[${book.title}] Clicking Save and Continue...`);
  try {
    const saveClicked = await page.evaluate(() => {
      const texts = ['salvar e continuar', 'save and continue', 'guardar y continuar', 'save & continue'];
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.a-button-primary'));
      for (const btn of btns) {
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        if (texts.some(t => txt.includes(t))) {
          btn.click();
          return true;
        }
      }
      // Also try by id
      const byId = document.querySelector('#save-announce, [data-testid="save-continue-button"]');
      if (byId) { byId.click(); return true; }
      return false;
    });
    log.info(`[${book.title}] Save and Continue clicked: ${saveClicked}`);
    if (!saveClicked) {
      // Screenshot to debug
      await screenshot(page, `save_button_not_found_${book.asin}`);
    }
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    await ensureAuthenticated(page);
  } catch (e) {
    log.warn(`[${book.title}] Save and Continue failed: ${e.message}`);
  }

  await screenshot(page, `after_content_save_${book.asin}`);
  log.info(`[${book.title}] Content step done. URL: ${page.url().slice(0, 80)}`);
}

// ── Pricing step: set price + royalty + publish ───────────────────────────────
async function doPricingStep(page, book) {
  const pricingUrl = `https://kdp.amazon.com/pt_BR/title-setup/kindle/${book.asin}/pricing`;
  log.info(`[${book.title}] Navigating to pricing step: ${pricingUrl}`);
  await page.goto(pricingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  await ensureAuthenticated(page);
  await sleep(2000);
  await screenshot(page, `pricing_loaded_${book.asin}`);

  // ── 1. KDP Select enrollment ────────────────────────────────────────────────
  log.info(`[${book.title}] Checking KDP Select...`);
  try {
    await page.evaluate(() => {
      const cb = document.querySelector(
        'input[id*="kdp-select" i], input[name*="kdpSelect" i], input[id*="Select" ], input[name*="select" i][type="checkbox"]'
      );
      if (cb && !cb.checked) { cb.click(); }
    });
  } catch (e) {
    log.warn(`[${book.title}] KDP Select: ${e.message}`);
  }

  // ── 2. Set USD price ────────────────────────────────────────────────────────
  log.info(`[${book.title}] Setting price $${PRICE_USD}...`);
  try {
    const priceSet = await page.evaluate((price) => {
      // Try common KDP price field selectors
      const selectors = [
        'input[id*="list-price" i]',
        'input[id*="listPrice" i]',
        'input[name*="price" i]',
        'input[id*="price-usd" i]',
        'input[id*="usd" i]',
        'input[data-marketplace="USD"]',
        'input[id*="US"][type="text"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.focus();
          el.select();
          // Use native input value setter to trigger React events
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(el, price);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return sel;
        }
      }
      return null;
    }, PRICE_USD);
    log.info(`[${book.title}] Price set via selector: ${priceSet}`);

    if (!priceSet) {
      // Fallback: find by placeholder or nearby label
      const inputs = await page.$$('input[type="text"], input[type="number"]');
      for (const input of inputs) {
        const placeholder = await page.evaluate(el => el.placeholder || '', input);
        const nearLabel   = await page.evaluate(el => {
          const lbl = el.closest('.a-row, .a-section')?.querySelector('label, .a-form-label');
          return (lbl ? lbl.textContent : '').toLowerCase();
        }, input);
        if (placeholder.includes('$') || placeholder.includes('USD') || nearLabel.includes('usd') || nearLabel.includes('preço')) {
          await input.click({ clickCount: 3 });
          await input.type(PRICE_USD, { delay: 50 });
          await input.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
          log.info(`[${book.title}] Price typed via placeholder: ${placeholder}`);
          break;
        }
      }
    }
    await sleep(1500);
  } catch (e) {
    log.warn(`[${book.title}] Price set failed: ${e.message}`);
  }

  // ── 3. Select 70% royalty ────────────────────────────────────────────────────
  log.info(`[${book.title}] Setting 70% royalty...`);
  try {
    const royaltySet = await page.evaluate(() => {
      // Try radio with value 70 or 0.70
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        const val = (r.value || '').trim();
        const lbl = document.querySelector(`label[for="${r.id}"]`);
        const lblTxt = (lbl ? lbl.textContent : '').trim();
        if (val === '70' || val === '0.70' || val === '0.7' || lblTxt.includes('70%')) {
          r.click();
          return '70%-radio:' + val;
        }
      }
      // Try select element
      const sel = document.querySelector('select[id*="royalty" i], select[name*="royalty" i]');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value === '70' || opt.text.includes('70%')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return '70%-select:' + opt.value;
          }
        }
      }
      // Try button / tab labeled 70%
      const btns = Array.from(document.querySelectorAll('button, .a-button, [role="tab"]'));
      for (const btn of btns) {
        if ((btn.textContent || '').includes('70%')) {
          btn.click();
          return '70%-button';
        }
      }
      return null;
    });
    log.info(`[${book.title}] Royalty set: ${royaltySet}`);
  } catch (e) {
    log.warn(`[${book.title}] Royalty set failed: ${e.message}`);
  }

  await sleep(2000);
  await screenshot(page, `before_publish_${book.asin}`);

  // ── 4. Publish ───────────────────────────────────────────────────────────────
  log.info(`[${book.title}] Clicking Publish...`);
  try {
    const publishClicked = await page.evaluate(() => {
      const texts = [
        'publicar seu livro kindle',
        'publicar livro kindle',
        'publish your kindle ebook',
        'publish kindle ebook',
        'publicar',
        'publish',
      ];
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.a-button-primary, .a-button-primary input'));
      for (const btn of btns) {
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        if (texts.some(t => txt.includes(t))) {
          btn.click();
          return txt.slice(0, 40);
        }
      }
      // Also try data-testid
      const pub = document.querySelector('[data-testid*="publish" i], [id*="publish" i]');
      if (pub) { pub.click(); return 'testid-publish'; }
      return null;
    });

    if (!publishClicked) {
      log.warn(`[${book.title}] Publish button not found — taking screenshot`);
      await screenshot(page, `publish_not_found_${book.asin}`);
      return false;
    }

    log.info(`[${book.title}] Publish clicked: "${publishClicked}"`);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    await ensureAuthenticated(page);
    await sleep(2000);
    await screenshot(page, `after_publish_${book.asin}`);

    // Check if publish was successful
    const published = await page.evaluate(() => {
      const url = window.location.href;
      const body = document.body.textContent || '';
      return url.includes('bookshelf') ||
             body.toLowerCase().includes('publicado') ||
             body.toLowerCase().includes('published') ||
             body.toLowerCase().includes('em revisão') ||
             body.toLowerCase().includes('under review') ||
             body.toLowerCase().includes('live') ||
             document.querySelector('.a-color-success, [class*="success"]') !== null;
    });

    log.info(`[${book.title}] Publish success check: ${published} (URL: ${page.url().slice(0, 80)})`);
    return published;
  } catch (e) {
    log.warn(`[${book.title}] Publish step failed: ${e.message}`);
    return false;
  }
}

// ── Delete duplicate draft ────────────────────────────────────────────────────
async function deleteDuplicateDraft(page, book) {
  if (!book.asin_delete) return;
  log.info(`[${book.title}] Deleting duplicate draft ASIN: ${book.asin_delete}`);

  try {
    // Navigate to bookshelf to find the draft
    await page.goto('https://kdp.amazon.com/pt_BR/bookshelf', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2000);
    await ensureAuthenticated(page);
    await sleep(2000);

    // Find the book card with the asin_delete
    const deleteAttempted = await page.evaluate((asinToDelete) => {
      // Look for a link or element referencing this ASIN
      const links = Array.from(document.querySelectorAll('a[href*="' + asinToDelete + '"], [data-asin="' + asinToDelete + '"]'));
      if (links.length === 0) return false;

      // Find the card container
      const card = links[0].closest('.book-container, .a-section, .bookshelf-card, tr, [class*="book-row"]');
      if (!card) return false;

      // Find the "..." or actions button
      const actionsBtn = card.querySelector(
        '.ellipsis-button, button[aria-label*="Ações"], button[aria-label*="Actions"], button[aria-label*="More"], .a-ellipsis-button'
      );
      if (actionsBtn) { actionsBtn.click(); return 'clicked-actions'; }

      return false;
    }, book.asin_delete);

    if (!deleteAttempted) {
      // Try navigating directly to the title's delete endpoint
      log.warn(`[${book.title}] Draft ${book.asin_delete} not found on bookshelf via DOM — trying direct approach`);
      // Try opening actions menu via the ASIN link
      await page.evaluate((asinToDelete) => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        // Look for buttons near any ASIN reference
        const asinEl = document.querySelector(`[data-asin="${asinToDelete}"], a[href*="${asinToDelete}"]`);
        if (!asinEl) return;
        const container = asinEl.closest('tr, .book-container, section, article') || asinEl.parentElement;
        if (!container) return;
        const btn = container.querySelector('button');
        if (btn) btn.click();
      }, book.asin_delete);
    }

    await sleep(1500);
    await screenshot(page, `delete_menu_${book.asin_delete}`);

    // Click "Excluir" / "Delete" in the dropdown
    const deleteClicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(
        '.a-dropdown-item a, .a-popover li a, li a, [role="menuitem"], .a-list-item a'
      ));
      for (const item of items) {
        const txt = (item.textContent || '').toLowerCase().trim();
        if (txt.includes('excluir') || txt.includes('delete') || txt.includes('eliminar')) {
          item.click();
          return txt;
        }
      }
      return null;
    });

    log.info(`[${book.title}] Delete menu item clicked: ${deleteClicked}`);
    await sleep(1500);

    // Confirm deletion in modal
    const confirmClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
      for (const btn of btns) {
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        if (txt.includes('excluir') || txt.includes('delete') || txt.includes('confirmar') || txt.includes('confirm')) {
          btn.click();
          return txt;
        }
      }
      return null;
    });

    log.info(`[${book.title}] Delete confirmation clicked: ${confirmClicked}`);
    await sleep(3000);
    await screenshot(page, `after_delete_${book.asin_delete}`);
    log.info(`[${book.title}] Duplicate draft ${book.asin_delete} deletion attempted`);
  } catch (e) {
    log.warn(`[${book.title}] Delete duplicate failed: ${e.message}`);
  }
}

// ── Database update ───────────────────────────────────────────────────────────
function updateDb(book) {
  try {
    const db = new Database(DB_PATH);
    const amazonUrl = `https://kdp.amazon.com/pt_BR/title-setup/kindle/${book.asin}`;
    const stmt = db.prepare(`
      UPDATE ebooks
         SET status            = 'published',
             amazon_url        = ?,
             amazon_product_id = ?,
             published_at      = datetime('now')
       WHERE id = ?
    `);
    const result = stmt.run(amazonUrl, book.asin, book.db_id);
    db.close();

    if (result.changes > 0) {
      log.info(`[${book.title}] DB updated: status=published, asin=${book.asin}`);
    } else {
      // Row might not exist or columns may differ — try without amazon columns
      log.warn(`[${book.title}] DB update changed 0 rows. Attempting fallback update...`);
      const db2 = new Database(DB_PATH);
      // Check what columns exist
      const cols = db2.prepare("PRAGMA table_info(ebooks)").all().map(c => c.name);
      log.info(`[${book.title}] ebooks columns: ${cols.join(', ')}`);

      let sql = `UPDATE ebooks SET status = 'published', published_at = datetime('now')`;
      const params = [];
      if (cols.includes('amazon_url'))        { sql += `, amazon_url = ?`; params.push(`https://kdp.amazon.com/pt_BR/title-setup/kindle/${book.asin}`); }
      if (cols.includes('amazon_product_id')) { sql += `, amazon_product_id = ?`; params.push(book.asin); }
      sql += ` WHERE id = ?`;
      params.push(book.db_id);

      const r2 = db2.prepare(sql).run(...params);
      db2.close();
      log.info(`[${book.title}] Fallback DB update: ${r2.changes} rows changed`);
    }
  } catch (e) {
    log.error(`[${book.title}] DB update failed: ${e.message}`);
  }
}

// ── Complete one book ─────────────────────────────────────────────────────────
async function completeBook(page, book) {
  log.info(`\n${'─'.repeat(60)}`);
  log.info(`[kdp-complete] Processing: ${book.title}`);
  log.info(`[kdp-complete] ASIN: ${book.asin}`);
  log.info(`${'─'.repeat(60)}`);

  // Verify files exist
  if (!fs.existsSync(book.cover)) log.warn(`Cover not found: ${book.cover}`);
  if (!fs.existsSync(book.pdf))   log.warn(`PDF not found: ${book.pdf}`);

  // Content step
  await doContentStep(page, book);
  await saveSession(page);

  // Pricing + publish
  const published = await doPricingStep(page, book);

  if (published) {
    log.info(`[${book.title}] Successfully published!`);
    updateDb(book);
  } else {
    log.warn(`[${book.title}] Publish may not have completed — check screenshots`);
    // Still update DB with what we have
    updateDb(book);
  }

  // Delete duplicate if needed
  if (book.asin_delete) {
    await deleteDuplicateDraft(page, book);
  }

  await saveSession(page);
  log.info(`[${book.title}] Done.\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log.info('=== KDP Draft Completion Script ===');
  log.info(`Processing ${BOOKS.length} books`);

  // Load session
  const session = loadSession();
  if (!session) {
    log.warn('No session file found — will attempt login for each book');
  }

  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,900',
      '--lang=pt-BR',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Inject session cookies (must be done before navigation — navigate to domain first)
  if (session) {
    await page.goto('https://kdp.amazon.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await injectSession(page, session);
  }

  // Process each book
  const results = [];
  for (const book of BOOKS) {
    try {
      await completeBook(page, book);
      results.push({ asin: book.asin, title: book.title, status: 'completed' });
    } catch (e) {
      log.error(`[${book.title}] Fatal error: ${e.message}`);
      log.error(e.stack);
      results.push({ asin: book.asin, title: book.title, status: 'error', error: e.message });
      await screenshot(page, `error_${book.asin}`);
      // Save session even on error
      await saveSession(page).catch(() => {});
    }
  }

  // Final summary
  log.info('\n=== SUMMARY ===');
  for (const r of results) {
    const icon = r.status === 'completed' ? 'OK' : 'FAIL';
    log.info(`[${icon}] ${r.title} (${r.asin}) — ${r.status}${r.error ? ': ' + r.error : ''}`);
  }

  await browser.close();
  log.info('=== Script finished ===');
}

main().catch(e => {
  console.error('[kdp-complete] Uncaught error:', e);
  process.exit(1);
});
