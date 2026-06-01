'use strict';
/**
 * gammaAgent.js — Gera ebooks via Gamma.app com Google OAuth
 *
 * Fluxo:
 * 1. Login via Google (injeta cookies + resolve OAuth popup)
 * 2. Cria novo documento AI: "Gerar → Documento → [prompt do tópico]"
 * 3. Aguarda geração (pode levar 30-60s)
 * 4. Exporta como PDF
 * 5. Retorna caminho do PDF + metadados do ebook
 *
 * Créditos gratuitos: ~8 gerações/mês por conta
 */
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const { injectGoogleSession, resolveGoogleOAuth, saveServiceSession, loadServiceSession } = require('./googleAuth');

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const DATA_DIR    = process.env.DATA_DIR || '/app/data';
const OUTPUT_DIR  = path.join(DATA_DIR, 'web_ebooks');
const LOGS_DIR    = path.join(DATA_DIR, 'logs');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(LOGS_DIR, `gamma_${name}.png`), fullPage: false });
  } catch {}
}

/**
 * Gera ebook via Gamma.app
 *
 * @param {object} opts
 * @param {string} opts.topic - Tópico do ebook
 * @param {string} opts.language - Idioma (pt-BR, en, es, etc.)
 * @param {string} opts.email - Email da conta Google
 * @param {string} opts.googleSessionFile - Arquivo de sessão Google
 * @param {string} opts.serviceSessionFile - Arquivo de sessão Gamma
 * @returns {{ title, description, pdfPath, pages } | null}
 */
async function generateWithGamma({ topic, language, email, googleSessionFile, serviceSessionFile }) {
  console.log(`[gamma] Gerando ebook: "${topic}" [${language}] com ${email}`);

  const langInstructions = {
    'pt-BR': 'em português do Brasil',
    'en':    'in English',
    'es':    'en español',
    'fr':    'en français',
    'de':    'auf Deutsch',
    'it':    'in italiano',
    'pl':    'po polsku',
    'nl':    'in het Nederlands',
    'ja':    '日本語で',
    'zh':    '用中文',
  };
  const langStr = langInstructions[language] || 'in English';

  const prompt = `Create a comprehensive ebook ${langStr} about: "${topic}".
Include an introduction, 5-7 detailed chapters with practical tips and actionable advice,
and a conclusion. Make it professional, visually appealing, and valuable for readers.`;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1280,900',
    ],
  });

  try {
    // Injetar cookies Google no contexto do browser
    await injectGoogleSession(browser, googleSessionFile);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ── 1. Tentar carregar sessão existente do Gamma ──────────────────────────
    const hasSession = await loadServiceSession(page, serviceSessionFile);
    if (hasSession) {
      console.log('[gamma] Sessão existente carregada — verificando validade...');
    }

    // ── 2. Navegar ao Gamma ────────────────────────────────────────────────────
    await page.goto('https://gamma.app', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    await screenshot(page, 'start');

    const currentUrl = page.url();
    console.log('[gamma] URL inicial: ' + currentUrl.slice(0, 80));

    // ── 3. Login se necessário ─────────────────────────────────────────────────
    const needsLogin = await page.evaluate(() => {
      const t = document.body?.innerText?.toLowerCase() || '';
      return t.includes('sign in') || t.includes('login') || t.includes('entrar') ||
             document.querySelector('button[data-testid="signin"]') !== null ||
             document.querySelector('a[href*="/login"]') !== null ||
             document.querySelector('a[href*="/signin"]') !== null;
    });

    if (needsLogin || !currentUrl.includes('gamma.app/home') && !currentUrl.includes('gamma.app/dashboard')) {
      console.log('[gamma] Login necessário — iniciando OAuth Google');
      await screenshot(page, 'login_needed');

      // Clicar em "Sign in with Google"
      const googleBtnClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          if (t.includes('google') || t.includes('sign in') || t.includes('entrar')) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0) { btn.click(); return 'clicked: ' + t.slice(0, 40); }
          }
        }
        // Procurar link de login
        const loginLink = document.querySelector('a[href*="/login"], a[href*="/signin"]');
        if (loginLink) { loginLink.click(); return 'login-link'; }
        return null;
      });

      if (googleBtnClicked) {
        console.log('[gamma] ' + googleBtnClicked);
        await sleep(2000);
      }

      // Agora procurar botão "Continue with Google"
      await sleep(1500);
      await screenshot(page, 'login_page');

      const googleOAuthClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && (t.includes('continue with google') || t.includes('google') ||
              t.includes('sign in with google') || t.includes('entrar com google'))) {
            btn.click();
            return 'google-oauth: ' + t.slice(0, 40);
          }
        }
        return null;
      });

      if (googleOAuthClicked) {
        console.log('[gamma] ' + googleOAuthClicked);
        // Resolver popup OAuth
        const oauthOk = await resolveGoogleOAuth(page, email, 25000);
        if (!oauthOk) {
          console.warn('[gamma] OAuth não resolvido — tentando continuar mesmo assim');
        }
        await sleep(3000);
        await screenshot(page, 'after_oauth');
      }

      // Aguardar dashboard
      try {
        await page.waitForFunction(
          () => window.location.href.includes('/home') || window.location.href.includes('/dashboard') ||
                document.querySelector('[data-testid="new-button"], button[aria-label*="New"], .new-workspace') !== null,
          { timeout: 20000 }
        );
      } catch {
        console.warn('[gamma] Dashboard não detectado após login');
      }

      await saveServiceSession(page, serviceSessionFile, { email, service: 'gamma' });
    }

    await screenshot(page, 'dashboard');
    console.log('[gamma] Dashboard: ' + page.url().slice(0, 80));

    // ── 4. Criar novo documento AI ─────────────────────────────────────────────
    // Clicar em botão "New" ou "Create"
    const newClicked = await page.evaluate(() => {
      const selectors = [
        'button[aria-label*="New"]', 'button[data-testid="new-button"]',
        '[class*="new-workspace"]', '[class*="create-btn"]',
        'button', 'a',
      ];
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (t === 'new' || t === 'create' || t.includes('new workspace') ||
              t.includes('criar') || t.includes('novo'))) {
            el.click();
            return 'new: ' + t.slice(0, 30);
          }
        }
      }
      return null;
    });
    console.log('[gamma] New button: ' + (newClicked || 'not found'));
    await sleep(2000);
    await screenshot(page, 'new_modal');

    // Procurar opção "Generate with AI" / "AI" no modal
    const aiClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a'));
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('generate') || t.includes('ai') || t.includes('gerar') ||
            t.includes('doc') || t.includes('document'))) {
          btn.click();
          return 'ai-option: ' + t.slice(0, 40);
        }
      }
      return null;
    });
    console.log('[gamma] AI option: ' + (aiClicked || 'not found'));
    await sleep(1500);
    await screenshot(page, 'ai_modal');

    // ── 5. Inserir prompt ──────────────────────────────────────────────────────
    const promptFilled = await page.evaluate((promptText) => {
      const inputs = Array.from(document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"], [placeholder*="topic"], [placeholder*="tópico"]'
      ));
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 0) {
          inp.focus();
          if (inp.tagName === 'INPUT' || inp.tagName === 'TEXTAREA') {
            inp.value = promptText;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            // contenteditable
            inp.textContent = promptText;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return 'filled: ' + inp.tagName;
        }
      }
      return null;
    }, prompt);
    console.log('[gamma] Prompt: ' + (promptFilled || 'not filled'));

    if (!promptFilled) {
      // Tentar digitar via keyboard
      await page.keyboard.type(prompt, { delay: 20 });
      await sleep(500);
    }

    await screenshot(page, 'prompt_filled');
    await sleep(500);

    // ── 6. Gerar ──────────────────────────────────────────────────────────────
    const generateClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('generate') || t.includes('gerar') ||
            t.includes('create') || t.includes('continue') || t.includes('next'))) {
          btn.click();
          return 'generate: ' + t.slice(0, 40);
        }
      }
      return null;
    });
    console.log('[gamma] Generate: ' + (generateClicked || 'not found'));

    if (!generateClicked) await page.keyboard.press('Enter');
    await sleep(2000);
    await screenshot(page, 'generating');

    // ── 7. Aguardar geração (até 3 min) ───────────────────────────────────────
    console.log('[gamma] Aguardando geração AI...');
    const generated = await page.waitForFunction(
      () => {
        // Verificar se o documento foi gerado
        const url = window.location.href;
        if (url.includes('/p/') || url.includes('/doc/') || url.includes('/presentation/')) return true;
        // Ou verificar se há conteúdo gerado na página
        const slides = document.querySelectorAll('[class*="slide"], [class*="card"], [class*="page"]');
        if (slides.length > 2) return true;
        return false;
      },
      { timeout: 180000, polling: 3000 }
    ).catch(() => null);

    await sleep(3000);
    await screenshot(page, 'generated');

    const docUrl = page.url();
    console.log('[gamma] Documento gerado: ' + docUrl.slice(0, 80));

    // Extrair título da página gerada
    const title = await page.evaluate(() => {
      return document.title?.replace(' | Gamma', '').replace(' - Gamma', '').trim() ||
             document.querySelector('h1')?.textContent?.trim() ||
             'Ebook Gerado';
    });
    console.log('[gamma] Título: ' + title);

    // ── 8. Exportar como PDF ──────────────────────────────────────────────────
    // Procurar menu de exportação
    const exportClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('export') || t.includes('exportar') || t.includes('download') ||
            t.includes('pdf') || t.includes('share') || t.includes('compartilhar'))) {
          btn.click();
          return 'export: ' + t.slice(0, 40);
        }
      }
      // Tentar menu "..."
      const moreBtn = document.querySelector('[aria-label="More options"], [aria-label="Mais opções"], button[aria-haspopup="menu"]');
      if (moreBtn) { moreBtn.click(); return 'more-menu'; }
      return null;
    });
    console.log('[gamma] Export: ' + (exportClicked || 'not found'));
    await sleep(1500);
    await screenshot(page, 'export_menu');

    // Clicar em "PDF"
    const pdfClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="menuitem"], a, li'));
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && t.includes('pdf')) {
          btn.click();
          return 'pdf: ' + t.slice(0, 30);
        }
      }
      return null;
    });
    console.log('[gamma] PDF option: ' + (pdfClicked || 'not found'));
    await sleep(2000);
    await screenshot(page, 'pdf_dialog');

    // ── 9. Fazer download do PDF ──────────────────────────────────────────────
    const ts = Date.now();
    const pdfPath = path.join(OUTPUT_DIR, `gamma_${ts}.pdf`);
    let pdfSaved = false;

    // Configurar download
    const client = await page.target().createCDPSession().catch(() => null);
    if (client) {
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: OUTPUT_DIR,
      }).catch(() => {});
    }

    // Clicar botão de download final
    const downloadClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('download') || t.includes('baixar') || t.includes('export pdf'))) {
          btn.click();
          return 'download: ' + t.slice(0, 30);
        }
      }
      return null;
    });
    console.log('[gamma] Download: ' + (downloadClicked || 'not found'));

    // Aguardar arquivo aparecer no diretório
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.pdf') && !f.startsWith('gamma_'))
        .map(f => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      // Também procurar arquivos gamma_ recentes
      const recentGamma = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.pdf') && f.startsWith('gamma_') &&
                     fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs > ts - 1000);

      const newest = [...files, ...recentGamma.map(f => ({ name: f }))][0];
      if (newest) {
        const src = path.join(OUTPUT_DIR, newest.name);
        if (src !== pdfPath) {
          fs.renameSync(src, pdfPath);
        }
        pdfSaved = true;
        console.log('[gamma] ✅ PDF salvo: ' + pdfPath);
        break;
      }
      await sleep(2000);
    }

    if (!pdfSaved) {
      // Tentar capturar via print
      console.log('[gamma] Tentando salvar via page.pdf()...');
      try {
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        pdfSaved = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 10000;
        if (pdfSaved) console.log('[gamma] ✅ PDF via page.pdf(): ' + pdfPath);
      } catch (e) {
        console.warn('[gamma] page.pdf() falhou: ' + e.message);
      }
    }

    if (!pdfSaved) {
      throw new Error('PDF não foi gerado pelo Gamma');
    }

    // Salvar sessão atualizada
    await saveServiceSession(page, serviceSessionFile, { email, service: 'gamma' });

    return {
      title,
      description: `Ebook gerado pelo Gamma.app sobre: ${topic}`,
      pdfPath,
      source: 'gamma',
      sourceUrl: docUrl,
      email,
    };

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateWithGamma };
