'use strict';
/**
 * renovar_token_local.js — pega um access_token novo do navegador logado e
 * instala no VPS.
 *
 * POR QUE PRECISA SER AQUI: a renovacao automatica do finalizeAgent resgata um
 * Service Ticket do TGT guardado no VPS, e o CAS passou a responder 404 — a
 * Hotmart amarra a sessao a origem, entao aquele TGT e recusado. O token novo so
 * existe onde a sessao e legitima: no localStorage do navegador que fez o login.
 *
 * O token vale ~2 dias. Sem isto os produtos ficam em RASCUNHO: criados,
 * visiveis no painel do produtor e sem vender.
 *
 * NAO navega: le o token de uma aba ja aberta. Com os pipelines rodando, o
 * Chrome fica ocupado e um page.goto estoura o timeout — ja aconteceu.
 *
 * Uso:  node scripts/renovar_token_local.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const DESTINO = '/app/data/hotmart_access_token.txt';

/** Um JWT utilizavel: tres partes e `exp` no futuro. */
function jwtUtilizavel(t) {
  if (!t || t.length < 100) return false;
  const p = t.split('.');
  if (p.length !== 3) return false;
  try {
    const c = JSON.parse(Buffer.from(p[1], 'base64').toString());
    return !c.exp || c.exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

function validade(t) {
  try {
    const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());
    return c.exp ? new Date(c.exp * 1000).toISOString() : '(sem exp)';
  } catch { return '(ilegivel)'; }
}

async function main() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: CDP });
  let token = null;
  try {
    for (const p of await browser.pages()) {
      if (!/hotmart\.com/.test(p.url())) continue;
      const achado = await p.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          const v = localStorage.getItem(k) || '';
          if (/^ey[A-Za-z0-9_-]{20,}\./.test(v)) return v;
        }
        return null;
      }).catch(() => null);
      if (achado && achado.length > 100) { token = achado; break; }
    }
  } finally { browser.disconnect(); }

  if (!token) { console.error('nenhum token nas abas abertas — o Chrome esta logado?'); process.exit(1); }
  if (!jwtUtilizavel(token)) { console.error('o token do navegador tambem esta vencido — refaca o login'); process.exit(1); }

  const tmp = path.join(os.tmpdir(), 'hm_token.txt');
  fs.writeFileSync(tmp, token);
  execFileSync('scp', [tmp, `${VPS}:/tmp/hm_token.txt`], { timeout: 120000 });
  execFileSync('ssh', [VPS, `docker cp /tmp/hm_token.txt ${CONTAINER}:${DESTINO} && rm -f /tmp/hm_token.txt`],
    { timeout: 120000, encoding: 'utf8' });
  fs.unlinkSync(tmp);

  console.log('token instalado no VPS (' + token.length + ' chars), valido ate ' + validade(token));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
