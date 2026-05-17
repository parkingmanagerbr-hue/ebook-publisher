#!/usr/bin/env node
/**
 * setup-sessions.js — Captura sessões do Chrome (Hotmart + Cakto + Amazon KDP)
 *
 * Uso: node scripts/setup-sessions.js [platform]
 *   node scripts/setup-sessions.js           → captura todas
 *   node scripts/setup-sessions.js hotmart   → só Hotmart
 *   node scripts/setup-sessions.js amazon    → só Amazon KDP
 *
 * Abre servidor HTTP local na porta 9111.
 * Cole o snippet no DevTools Console de cada plataforma → cookies salvos automaticamente.
 */
const http = require('http');
const path = require('path');
const fs   = require('fs');

const PORT   = 9111;
const SESS   = path.join(__dirname, '../data/sessions');
fs.mkdirSync(SESS, { recursive: true });

// Filtrar plataformas por argumento opcional
const targetPlatform = process.argv[2]?.toLowerCase() || null;

const ALL_PLATFORMS = {
  hotmart: { url: 'https://app-vlc.hotmart.com/products',       label: 'HOTMART'    },
  cakto:   { url: 'https://app.cakto.com.br/dashboard',         label: 'CAKTO'      },
  amazon:  { url: 'https://kdp.amazon.com/pt_BR/bookshelf',      label: 'AMAZON KDP' },
};

const PLATFORMS = targetPlatform
  ? (ALL_PLATFORMS[targetPlatform] ? { [targetPlatform]: ALL_PLATFORMS[targetPlatform] } : ALL_PLATFORMS)
  : ALL_PLATFORMS;

function snippet(platform) {
  return `fetch('http://localhost:${PORT}/save', {
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
}).then(r=>r.text()).then(t=>console.log('✅', t)).catch(e=>console.error('❌',e.message));`;
}

const saved = new Set();
const total = Object.keys(PLATFORMS).length;

const server = http.createServer((req, res) => {
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
        const platform = session.platform?.toLowerCase();
        if (!platform) { res.writeHead(400); res.end('missing platform'); return; }

        session.savedAtHuman = new Date().toLocaleString('pt-BR');
        session.cookieCount  = (session.cookies || []).length;

        const file = path.join(SESS, `${platform}.json`);
        fs.writeFileSync(file, JSON.stringify(session, null, 2));
        saved.add(platform);

        const label = ALL_PLATFORMS[platform]?.label || platform.toUpperCase();
        console.log(`\n✅ ${label} salvo! (${session.cookieCount} cookies, ${Object.keys(session.localStorage||{}).length} localStorage keys)`);

        res.writeHead(200);
        res.end(`Sessão ${platform} salva!`);

        if (saved.size >= total) {
          console.log('\n' + '═'.repeat(60));
          console.log('🎉 Todas as sessões capturadas!');
          console.log('\nEnv vars para ativar publicação (VPS):');
          console.log('   AUTO_PUBLISH_HOTMART=true');
          console.log('   AUTO_PUBLISH_CAKTO=true');
          console.log('   AUTO_PUBLISH_AMAZON=true');
          console.log('═'.repeat(60));
          setTimeout(() => { server.close(); process.exit(0); }, 800);
        }
      } catch (e) {
        res.writeHead(400); res.end('JSON invalido: ' + e.message);
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n' + '═'.repeat(65));
  console.log(`  SETUP DE SESSOES — ${Object.values(PLATFORMS).map(p=>p.label).join(' + ')}`);
  console.log('═'.repeat(65));
  console.log(`\nServidor: http://localhost:${PORT}\n`);

  for (const [platform, { url, label }] of Object.entries(PLATFORMS)) {
    console.log(`━━━ ${label} ━━━`);
    console.log(`Abra: ${url}`);
    console.log('F12 → Console → cole:\n');
    console.log(snippet(platform));
    console.log();
  }

  console.log('─'.repeat(65));
  console.log('Aguardando... (Ctrl+C para cancelar)\n');
});
