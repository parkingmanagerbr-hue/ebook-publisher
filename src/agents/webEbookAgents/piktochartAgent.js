'use strict';
/**
 * piktochartAgent.js — Gera ebooks via Piktochart com Google OAuth
 *
 * Piktochart tem "AI Ebook" e "AI Report" que geram documentos completos.
 * URL: https://create.piktochart.com/
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
  try { await page.screenshot({ path: path.join(LOGS_DIR, `piktochart_${name}.png`), fullPage: false }); } catch {}
}

async function generateWithPiktochart({ topic, language, email, googleSessionFile, serviceSessionFile }) {
  console.log(`[piktochart] Gerando ebook: "${topic}" [${language}] com ${email}`);

  const langInstructions = {
    'pt-BR': 'em português do Brasil', 'en': 'in English', 'es': 'en español',
    'fr': 'en français', 'de': 'auf Deutsch', 'it': 'in italiano',
  };
  const langStr = langInstructions[language] || 'in English';

  const prompt = `Create a professional ebook ${langStr} about "${topic}". Include introduction, key concepts, practical tips, and conclusion.`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,900'],
  });

  try {
    await injectGoogleSession(browser, googleSessionFile);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Carregar sessão existente
    const hasSession = await loadServiceSession(page, serviceSessionFile);

    // Navegar ao Piktochart
    await page.goto('https://create.piktochart.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    await screenshot(page, 'start');

    // Verificar se precisa de login
    const url0 = page.url();
    const needsLogin = url0.includes('/login') || url0.includes('/signup') || await page.evaluate(() => {
      const t = document.body?.innerText?.toLowerCase() || '';
      return t.includes('sign in') || t.includes('log in') || t.includes('entrar');
    });

    if (needsLogin) {
      console.log('[piktochart] Login necessário');
      await screenshot(page, 'login');

      // Clicar em "Sign in with Google"
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && (t.includes('google') || t.includes('sign in') || t.includes('log in'))) {
            btn.click(); return t.slice(0, 40);
          }
        }
        return null;
      });
      console.log('[piktochart] Login click: ' + (clicked || 'not found'));
      await sleep(1500);
      await screenshot(page, 'login2');

      // Procurar botão Google específico
      const googleClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        for (const btn of btns) {
          const t = (btn.textContent || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && t.includes('google')) {
            btn.click(); return 'google: ' + t.slice(0, 40);
          }
        }
        return null;
      });
      if (googleClicked) {
        console.log('[piktochart] ' + googleClicked);
        const oauthOk = await resolveGoogleOAuth(page, email, 25000);
        console.log('[piktochart] OAuth: ' + oauthOk);
        await sleep(4000);
      }

      try {
        await page.waitForFunction(
          () => !window.location.href.includes('/login') && !window.location.href.includes('/signup'),
          { timeout: 20000 }
        );
      } catch {}

      await saveServiceSession(page, serviceSessionFile, { email, service: 'piktochart' });
    }

    await screenshot(page, 'dashboard');
    console.log('[piktochart] Dashboard: ' + page.url().slice(0, 80));

    // ── Criar novo ebook/report AI ────────────────────────────────────────────
    // Navegar para criação de ebook
    await page.goto('https://create.piktochart.com/ai-ebook-generator', { waitUntil: 'networkidle2', timeout: 20000 }).catch(async () => {
      // Fallback: usar dashboard
      await page.goto('https://create.piktochart.com/', { waitUntil: 'networkidle2', timeout: 20000 });
    });
    await sleep(2000);
    await screenshot(page, 'create');

    // Procurar input de prompt/tópico
    const promptFilled = await page.evaluate((promptText) => {
      const inputs = Array.from(document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"]'
      )).filter(el => el.getBoundingClientRect().width > 0);
      if (inputs.length === 0) return false;
      const inp = inputs[0];
      inp.focus();
      if (inp.tagName !== 'INPUT' && inp.tagName !== 'TEXTAREA') {
        inp.textContent = promptText;
      } else {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, promptText);
        else inp.value = promptText;
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.tagName + ': ' + promptText.slice(0, 30);
    }, prompt);
    console.log('[piktochart] Prompt: ' + (promptFilled || 'not filled'));

    if (!promptFilled) await page.keyboard.type(prompt, { delay: 15 });
    await sleep(500);
    await screenshot(page, 'prompt');

    // Clicar em Generate/Create
    const generateClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('generate') || t.includes('create') || t.includes('gerar') ||
            t.includes('continue') || t.includes('start') || t.includes('next'))) {
          btn.click(); return t.slice(0, 40);
        }
      }
      return null;
    });
    console.log('[piktochart] Generate: ' + (generateClicked || 'not found, pressing Enter'));
    if (!generateClicked) await page.keyboard.press('Enter');

    // Aguardar geração
    console.log('[piktochart] Aguardando geração AI (até 3 min)...');
    await sleep(5000);
    await screenshot(page, 'generating');

    await page.waitForFunction(
      () => {
        const url = window.location.href;
        if (url.includes('/edit/') || url.includes('/view/') || url.includes('/template/')) return true;
        const el = document.querySelectorAll('[class*="slide"], [class*="page"], [class*="chart"], canvas');
        return el.length > 1;
      },
      { timeout: 180000, polling: 3000 }
    ).catch(() => console.warn('[piktochart] Timeout na geração'));

    await sleep(3000);
    await screenshot(page, 'generated');
    const docUrl = page.url();
    const title = await page.evaluate(() => document.title?.replace(' - Piktochart','').trim() || topic);
    console.log('[piktochart] Gerado: ' + title + ' | ' + docUrl.slice(0, 60));

    // ── Exportar PDF ──────────────────────────────────────────────────────────
    const ts = Date.now();
    const pdfPath = path.join(OUTPUT_DIR, `piktochart_${ts}.pdf`);

    // Configurar download
    const client = await page.target().createCDPSession().catch(() => null);
    if (client) {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTPUT_DIR }).catch(() => {});
    }

    // Clicar em Export/Download
    const exportClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('download') || t.includes('export') || t.includes('pdf'))) {
          btn.click(); return t.slice(0, 30);
        }
      }
      return null;
    });
    console.log('[piktochart] Export: ' + (exportClicked || 'not found'));
    await sleep(2000);
    await screenshot(page, 'export');

    // Clicar PDF no menu
    const pdfOptionClicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="menuitem"], li, a'));
      for (const el of els) {
        const t = (el.textContent || '').toLowerCase();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && t.trim() === 'pdf') { el.click(); return 'pdf'; }
      }
      // Fallback: qualquer coisa com PDF
      for (const el of els) {
        const t = (el.textContent || '').toLowerCase();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && t.includes('pdf')) { el.click(); return 'pdf-fallback: ' + t.slice(0,20); }
      }
      return null;
    });
    console.log('[piktochart] PDF option: ' + (pdfOptionClicked || 'not found'));
    await sleep(3000);

    // Aguardar download
    let pdfSaved = false;
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.pdf') && fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs > ts - 1000);
      if (files.length > 0) {
        const src = path.join(OUTPUT_DIR, files[0]);
        if (src !== pdfPath) fs.renameSync(src, pdfPath);
        pdfSaved = true;
        console.log('[piktochart] ✅ PDF: ' + pdfPath);
        break;
      }
      await sleep(2000);
    }

    if (!pdfSaved) {
      console.log('[piktochart] Tentando page.pdf()...');
      try {
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        pdfSaved = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000;
      } catch (e) { console.warn('[piktochart] page.pdf() falhou: ' + e.message); }
    }

    if (!pdfSaved) throw new Error('PDF não gerado pelo Piktochart');

    await saveServiceSession(page, serviceSessionFile, { email, service: 'piktochart' });

    return { title, description: `Ebook sobre ${topic}`, pdfPath, source: 'piktochart', sourceUrl: docUrl, email };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateWithPiktochart };
