'use strict';
/**
 * ebookmakerAgent.js — Gera ebooks via ebookmaker.ai
 *
 * URL: https://ebookmaker.ai/pt-BR/ebook/new
 * O site permite criar ebooks com AI diretamente — pode ou não ter Google OAuth.
 * Tem login via email também como fallback.
 *
 * Créditos gratuitos: ~10 ebooks/mês por conta
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
  try { await page.screenshot({ path: path.join(LOGS_DIR, `ebookmaker_${name}.png`), fullPage: false }); } catch {}
}

async function generateWithEbookmaker({ topic, language, email, googleSessionFile, serviceSessionFile }) {
  console.log(`[ebookmaker] Gerando ebook: "${topic}" [${language}] com ${email}`);

  const langMap = {
    'pt-BR': 'pt', 'en': 'en', 'es': 'es', 'fr': 'fr', 'de': 'de', 'it': 'it',
    'pl': 'pl', 'nl': 'nl', 'ja': 'ja', 'zh': 'zh',
  };
  const langCode = langMap[language] || 'en';

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

    // Navegar para a página de criação
    const createUrl = `https://ebookmaker.ai/${langCode}/ebook/new`;
    await page.goto(createUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    await screenshot(page, 'start');

    const startUrl = page.url();
    console.log('[ebookmaker] URL: ' + startUrl.slice(0, 80));

    // Verificar se precisa de login
    const needsLogin = startUrl.includes('/login') || startUrl.includes('/register') || await page.evaluate(() => {
      const t = document.body?.innerText?.toLowerCase() || '';
      return t.includes('sign in') || t.includes('log in') || t.includes('entrar') || t.includes('cadastre');
    });

    if (needsLogin) {
      console.log('[ebookmaker] Login necessário');

      // Tentar Google OAuth primeiro
      const googleClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        for (const btn of btns) {
          const t = (btn.textContent || btn.getAttribute('href') || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && t.includes('google')) { btn.click(); return 'google: ' + t.slice(0,30); }
        }
        return null;
      });
      if (googleClicked) {
        console.log('[ebookmaker] ' + googleClicked);
        await sleep(1500);
        const oauthOk = await resolveGoogleOAuth(page, email, 20000);
        console.log('[ebookmaker] OAuth: ' + oauthOk);
        await sleep(3000);
      }

      // Verificar se chegou à página de criação
      if (!page.url().includes('/ebook/new') && !page.url().includes('/dashboard')) {
        await page.goto(createUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await sleep(1500);
      }

      await saveServiceSession(page, serviceSessionFile, { email, service: 'ebookmaker' });
    }

    await screenshot(page, 'create_page');

    // ── Preencher o formulário de criação ─────────────────────────────────────
    // ebookmaker.ai normalmente tem campos: Título, Tópico, Idioma

    // Campo de título/tópico
    const titleFilled = await page.evaluate((topicText) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], textarea'));
      // Primeiro input visível provavelmente é o título/tópico
      const visible = inputs.filter(el => el.getBoundingClientRect().width > 0);
      if (visible.length === 0) return false;
      const inp = visible[0];
      inp.focus();
      inp.value = topicText;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.id || inp.name || inp.placeholder || 'input';
    }, topic);
    console.log('[ebookmaker] Título: ' + (titleFilled || 'not filled'));

    await sleep(300);

    // Selecionar idioma se houver dropdown
    await page.evaluate((lang) => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const options = Array.from(sel.options);
        const match = options.find(o =>
          o.value.toLowerCase().includes(lang) || o.text.toLowerCase().includes(lang)
        );
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, langCode).catch(() => {});

    await screenshot(page, 'form_filled');

    // Clicar em "Gerar" / "Create" / "Generate"
    const genClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.value || '').toLowerCase();
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && (t.includes('gerar') || t.includes('generate') || t.includes('create') ||
            t.includes('criar') || t.includes('start') || t.includes('next') || t.includes('continue'))) {
          btn.click(); return t.slice(0, 40);
        }
      }
      return null;
    });
    console.log('[ebookmaker] Gerar: ' + (genClicked || 'not found'));
    if (!genClicked) await page.keyboard.press('Enter');

    // Aguardar geração
    console.log('[ebookmaker] Aguardando geração (até 5 min)...');
    await sleep(5000);
    await screenshot(page, 'generating');

    await page.waitForFunction(
      () => {
        const url = window.location.href;
        if (url.includes('/ebook/') && !url.includes('/new')) return true;
        const downloadBtn = document.querySelector('a[download], button[class*="download"], a[href*=".pdf"]');
        if (downloadBtn) return true;
        const progress = document.querySelector('[class*="progress"], [class*="loading"]');
        return !progress || progress.style.display === 'none';
      },
      { timeout: 300000, polling: 5000 }
    ).catch(() => console.warn('[ebookmaker] Timeout na geração'));

    await sleep(3000);
    await screenshot(page, 'generated');
    const docUrl = page.url();
    const title = await page.evaluate(() =>
      document.title?.replace(/ebookmaker\.ai.*/i, '').trim() ||
      document.querySelector('h1')?.textContent?.trim() || topic
    );
    console.log('[ebookmaker] Gerado: ' + title);

    // ── Download PDF ──────────────────────────────────────────────────────────
    const ts = Date.now();
    const pdfPath = path.join(OUTPUT_DIR, `ebookmaker_${ts}.pdf`);
    let pdfSaved = false;

    const client = await page.target().createCDPSession().catch(() => null);
    if (client) {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTPUT_DIR }).catch(() => {});
    }

    // Interceptar link de download
    const downloadUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        const href = a.href || '';
        const t = (a.textContent || a.getAttribute('download') || '').toLowerCase();
        if (href.includes('.pdf') || t.includes('pdf') || t.includes('download') || a.download) {
          return href;
        }
      }
      return null;
    });

    if (downloadUrl) {
      console.log('[ebookmaker] Download URL: ' + downloadUrl.slice(0, 80));
      // Baixar via fetch / navegação direta
      const resp = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url);
          if (!r.ok) return null;
          const blob = await r.blob();
          const arr  = await blob.arrayBuffer();
          return Array.from(new Uint8Array(arr));
        } catch (e) { return null; }
      }, downloadUrl);

      if (resp && resp.length > 5000) {
        fs.writeFileSync(pdfPath, Buffer.from(resp));
        pdfSaved = true;
        console.log('[ebookmaker] ✅ PDF via fetch: ' + pdfPath + ' (' + resp.length + ' bytes)');
      }
    }

    if (!pdfSaved) {
      // Clicar botão de download
      const dlClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('a, button'));
        for (const btn of btns) {
          const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && (t.includes('download') || t.includes('baixar') || t.includes('pdf'))) {
            btn.click(); return t.slice(0,30);
          }
        }
        return null;
      });
      console.log('[ebookmaker] Download click: ' + (dlClicked || 'not found'));
      await sleep(5000);

      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.pdf') && fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs > ts - 1000);
      if (files.length > 0) {
        const src = path.join(OUTPUT_DIR, files[0]);
        if (src !== pdfPath) fs.renameSync(src, pdfPath);
        pdfSaved = true;
        console.log('[ebookmaker] ✅ PDF: ' + pdfPath);
      }
    }

    if (!pdfSaved) {
      try {
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        pdfSaved = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 5000;
      } catch {}
    }

    if (!pdfSaved) throw new Error('PDF não gerado pelo ebookmaker.ai');

    await saveServiceSession(page, serviceSessionFile, { email, service: 'ebookmaker' });
    return { title, description: `Ebook sobre ${topic}`, pdfPath, source: 'ebookmaker', sourceUrl: docUrl, email };

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateWithEbookmaker };
