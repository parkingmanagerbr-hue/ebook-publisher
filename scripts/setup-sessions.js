#!/usr/bin/env node
/**
 * setup-sessions.js — Captura sessões do Chrome (Hotmart + Cakto) via servidor local
 *
 * Uso: node scripts/setup-sessions.js
 *
 * Abre um servidor HTTP local na porta 9111.
 * O usuário cola um snippet no DevTools do Chrome → o snippet envia
 * os cookies/localStorage para o servidor → salvo automaticamente.
 */
const http = require('http');
const path = require('path');
const fs   = require('fs');

const PORT    = 9111;
const SESS    = path.join(__dirname, '../data/sessions');
fs.mkdirSync(SESS, { recursive: true });

const PLATFORMS = {
  hotmart: 'https://app-vlc.hotmart.com/products',
  cakto:   'https://app.cakto.com.br/dashboard',
};

// Snippet a ser colado no DevTools
function snippet(platform) {
  return `
fetch('http://localhost:${PORT}/save', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    platform: '${platform}',
    url: location.href,
    cookies: document.cookie.split(';').map(c => {
      const [n,...v] = c.trim().split('=');
      return {name: n, value: v.join('='), domain: location.hostname, path: '/'};
    }),
    localStorage: Object.fromEntries(
      Array.from({length: localStorage.length}, (_,i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])
    ),
    sessionStorage: Object.fromEntries(
      Array.from({length: sessionStorage.length}, (_,i) => [sessionStorage.key(i), sessionStorage.getItem(sessionStorage.key(i))])
    ),
    savedAt: Date.now()
  })
}).then(r=>r.text()).then(t=>console.log('✅', t)).catch(e=>console.error('❌',e.message));
`.trim();
}

const saved = new Set();

const server = http.createServer((req, res) => {
  // CORS para aceitar requests do browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const session = JSON.parse(body);
        const platform = session.platform;
        if (!platform) { res.writeHead(400); res.end('missing platform'); return; }

        session.savedAtHuman  = new Date().toLocaleString('pt-BR');
        session.cookieCount   = (session.cookies || []).length;

        const file = path.join(SESS, `${platform}.json`);
        fs.writeFileSync(file, JSON.stringify(session, null, 2));
        saved.add(platform);

        console.log(`\n✅ Sessão ${platform.toUpperCase()} salva! (${session.cookieCount} cookies, ${Object.keys(session.localStorage||{}).length} localStorage keys)`);

        res.writeHead(200);
        res.end(`Sessão ${platform} salva com sucesso!`);

        // Verificar se já capturou tudo
        if (saved.has('hotmart') && saved.has('cakto')) {
          console.log('\n' + '═'.repeat(60));
          console.log('🎉 Todas as sessões capturadas! Encerrando servidor...');
          console.log('\nPara ativar publicação automática, adicione ao .env da VPS:');
          console.log('   AUTO_PUBLISH_HOTMART=true');
          console.log('   AUTO_PUBLISH_CAKTO=true');
          console.log('═'.repeat(60));
          setTimeout(() => { server.close(); process.exit(0); }, 1000);
        }
      } catch (e) {
        res.writeHead(400);
        res.end('JSON inválido: ' + e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n' + '═'.repeat(65));
  console.log('  SETUP DE SESSÕES — Hotmart + Cakto');
  console.log('═'.repeat(65));
  console.log(`\n🖥️  Servidor rodando em http://localhost:${PORT}`);
  console.log('\nCole cada snippet no DevTools Console da página correspondente:\n');

  for (const [platform, url] of Object.entries(PLATFORMS)) {
    console.log(`━━━ ${platform.toUpperCase()} ━━━`);
    console.log(`1. Abra no Chrome: ${url}`);
    console.log('2. F12 → Console → cole e execute:\n');
    console.log(snippet(platform));
    console.log();
  }

  console.log('─'.repeat(65));
  console.log('Aguardando capturas... (Ctrl+C para cancelar)\n');
});
