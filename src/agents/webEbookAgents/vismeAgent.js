'use strict';
/**
 * vismeAgent.js — Gera ebooks via Visme AI Designer
 *
 * URL: https://dashboard.visme.co/v2/ai-designer-wizard
 * Visme tem um wizard de design AI que cria apresentações/documentos.
 * Suporta Google OAuth e exportação em PDF.
 *
 * Créditos gratuitos: ~5 gerações/mês por conta
 */
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const { injectGoogleSession, resolveGoogleOAuth, saveServiceSession, loadServiceSession } = require('./googleAuth');

const sleep     = ms => new Promise(r => setTimeout(r, ms));
const DATA_DIR  = process.env.DATA_DIR || '/app/data';
const OUTPUT_DIR = path.join(DATA_DIR, 'web_ebooks');
const LOGS_DIR  = path.join(DATA_DIR, 'logs');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

async function screenshot(page, name) {
  try { await page.screenshot({ path: path.join(LOGS_DIR, `visme_${name}.png`), fullPage: false }); } catch {}
}

async function generateWithVisme({ topic, language, email, googleSessionFile, serviceSessionFile }) {
  console.log(`[visme] Gerando ebook: "${topic}" [${language}] com ${email}`);

  const langInstructions = {
    'pt-BR': 'in Portuguese (Brazil)', 'en': 'in English', 'es': 'in Spanish',
    'fr': 'in French', 'de': 'in German', 'it': 'in Italian',
  };
  const langStr = langInstructions[language] || 'in English';

  const prompt = `Create a professional ebook ${langStr} about "${topic}" with introduction, 5 chapters, and conclusion.`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,900'],
  });

  try {
    await injectGoogleSession(browser, googleSessionFile);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await loadServiceSession(page, serviceSessionFile);

    // Navegar ao Visme
    await page.goto('https://www.visme.co/', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    await screenshot(page, 'start');

    const currentUrl = page.url();
    const needsLogin = currentUrl.includes('/login') || currentUrl.includes('/signup') ||
                       !currentUrl.includes('visme.co') || await page.evaluate(() => {
      const t = document.body?.innerText?.toLowerCase() || '';
      return (t.includes('sign in') || t.includes('log in')) && !t.includes('dashboard');
    });

    if (needsLogin || !currentUrl.includes('/dashboard')) {
      console.log('[visme] Login necessário');

      // Ir para login
      if (!currentUrl.includes('/login')) {
        await page.goto('https://www.visme.co/login/', { waitUntil: 'networkidle2', timeout: 20000 });
        await sleep(1500);
      }
      await screenshot(page, 'login');

      // Clicar em "Continue with Google"
      const googleClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && t.includes('google')) { btn.click(); return 'google: ' + t.slice(0,40); }
        }
        return null;
      });
      console.log('[visme] Google login: ' + (googleClicked || 'not found'));

      if (googleClicked) {
        const oauthOk = await resolveGoogleOAuth(page, email, 25000);
        console.log('[visme] OAuth: ' + oauthOk);
        await sleep(4000);
      }

      // Aguardar dashboard
      try {
        await page.waitForFunction(
          () => window.location.href.includes('/dashboard') || window.location.href.includes('/v2/'),
          { timeout: 20000 }
        );
      } catch {}

      await saveServiceSession(page, serviceSessionFile, { email, service: 'visme' });
    }

    await screenshot(page, 'dashboard');
    console.log('[visme] Dashboard: ' + page.url().slice(0, 80));

    // ── Navegar ao AI Designer Wizard ─────────────────────────────────────────
    await page.goto('https://dashboard.visme.co/v2/ai-designer-wizard', {
      waitUntil: 'networkidle2', timeout: 30000
    }).catch(async () => {
      // Fallback: dashboard principal
      await page.goto('https://dashboard.visme.co/v2/', { waitUntil: 'networkidle2', timeout: 20000 });
    });
    await sleep(2000);
    await screenshot(page, 'ai_wizard');
    console.log('[visme] AI Wizard: ' + page.url().slice(0, 80));

    // Selecionar tipo de documento (Ebook/Report/Document)
    const typeClicked = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="type"], [role="button"], button'));
      const docTypes = ['ebook', 'document', 'report', 'infographic', 'presentation'];
      for (const type of docTypes) {
        for (const card of cards) {
          const t = (card.textContent || card.getAttribute('data-type') || '').toLowerCase();
          const r = card.getBoundingClientRect();
          if (r.width > 0 && t.includes(type)) { card.click(); return type; }
        }
      }
      return null;
    });
    console.log('[visme] Tipo: ' + (typeClicked || 'não selecionado'));
    await sleep(1000);
    await screenshot(page, 'type_selected');

    // Inserir prompt/tópico
    const promptFilled = await page.evaluate((promptText) => {
      const inputs = Array.from(document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"], [placeholder]'
      )).filter(el => {
        const r = el.getBoundingClientRect();
        const p = (el.placeholder || '').toLowerCase();
        return r.width > 0 && (p.includes('topic') || p.includes('tópico') || p.includes('describe') ||
               p.includes('what') || p.includes('enter') || p === '' || inputs.indexOf(el) < 3);
      });
      if (inputs.length === 0) return false;
      const inp = inputs[0];
      inp.focus();
      if (inp.tagName === 'INPUT' || inp.tagName === 'TEXTAREA') {
        inp.value = promptText;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        inp.textContent = promptText;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return inp.tagName + ':' + (inp.placeholder || '');
    }, prompt);
    console.log('[visme] Prompt: ' + (promptFilled || 'not filled'));
    if (!promptFilled) await page.keyboard.type(prompt, { delay: 15 });
    await sleep(500);
    await screenshot(page, 'prompt_filled');

    // Clicar em Gerar/Continue
    const genClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t === 'generate' || t === 'create' || t === 'continue' ||
            t.includes('generate') || t.includes('create my') || t.includes('design'))) {
          btn.click(); return t.slice(0, 40);
        }
      }
      return null;
    });
    console.log('[visme] Generate: ' + (genClicked || 'not found'));
    if (!genClicked) await page.keyboard.press('Enter');

    // Aguardar geração
    console.log('[visme] Aguardando geração AI (até 5 min)...');
    await sleep(5000);
    await screenshot(page, 'generating');

    await page.waitForFunction(
      () => {
        const url = window.location.href;
        if (url.includes('/edit/') || url.includes('/view/') || url.includes('/project/')) return true;
        const editor = document.querySelector('[class*="editor"], [class*="canvas"], [class*="slide"]');
        if (editor && editor.children.length > 0) return true;
        return false;
      },
      { timeout: 300000, polling: 5000 }
    ).catch(() => console.warn('[visme] Timeout na geração'));

    await sleep(3000);
    await screenshot(page, 'generated');
    const docUrl = page.url();
    const title = await page.evaluate(() =>
      document.title?.replace(/\s*[|\-–]\s*Visme.*/i, '').trim() ||
      document.querySelector('h1')?.textContent?.trim() || 'Visme Ebook'
    );
    console.log('[visme] Gerado: ' + title + ' | ' + docUrl.slice(0, 60));

    // ── Exportar como PDF ─────────────────────────────────────────────────────
    const ts = Date.now();
    const pdfPath = path.join(OUTPUT_DIR, `visme_${ts}.pdf`);
    let pdfSaved = false;

    const client = await page.target().createCDPSession().catch(() => null);
    if (client) {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTPUT_DIR }).catch(() => {});
    }

    // Clicar no botão de share/download/export
    const shareClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('share') || t.includes('download') || t.includes('export') ||
            t.includes('publish') || t.includes('pdf'))) {
          btn.click(); return t.slice(0, 30);
        }
      }
      return null;
    });
    console.log('[visme] Share/Export: ' + (shareClicked || 'not found'));
    await sleep(2000);
    await screenshot(page, 'export_menu');

    // Selecionar PDF
    const pdfClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="menuitem"], a, li, [role="option"]'));
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && t.includes('pdf')) { btn.click(); return t.slice(0, 30); }
      }
      return null;
    });
    console.log('[visme] PDF: ' + (pdfClicked || 'not found'));
    await sleep(3000);
    await screenshot(page, 'pdf_dialog');

    // Aguardar botão de download final
    const dlClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('download') || t.includes('baixar'))) {
          btn.click(); return t.slice(0, 30);
        }
      }
      return null;
    });
    console.log('[visme] Download: ' + (dlClicked || 'not found'));

    // Aguardar arquivo
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.pdf') && fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs > ts - 1000);
      if (files.length > 0) {
        const src = path.join(OUTPUT_DIR, files[0]);
        if (src !== pdfPath) fs.renameSync(src, pdfPath);
        pdfSaved = true;
        console.log('[visme] ✅ PDF: ' + pdfPath);
        break;
      }
      await sleep(2000);
    }

    if (!pdfSaved) {
      try {
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        pdfSaved = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000;
      } catch {}
    }

    if (!pdfSaved) throw new Error('PDF não gerado pelo Visme');

    await saveServiceSession(page, serviceSessionFile, { email, service: 'visme' });
    return { title, description: `Ebook sobre ${topic}`, pdfPath, source: 'visme', sourceUrl: docUrl, email };

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateWithVisme };
