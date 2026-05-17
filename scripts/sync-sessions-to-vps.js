#!/usr/bin/env node
/**
 * sync-sessions-to-vps.js
 *
 * Envia os arquivos de sessão locais para o VPS e reinicia o container.
 *
 * Uso: node scripts/sync-sessions-to-vps.js [platform]
 *   node scripts/sync-sessions-to-vps.js           → todas
 *   node scripts/sync-sessions-to-vps.js hotmart
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SESS_DIR = path.join(__dirname, '../data/sessions');
const VPS_SESS = 'vps:/opt/platform/data/ebook-publisher/db/sessions/';
const targetPlatform = process.argv[2]?.toLowerCase() || null;

const platforms = targetPlatform ? [targetPlatform] : ['hotmart', 'cakto', 'amazon'];

console.log('\n📤 Sincronizando sessões para o VPS...\n');

for (const platform of platforms) {
  const file = path.join(SESS_DIR, `${platform}.json`);
  if (!fs.existsSync(file)) {
    console.log(`⚠️  ${platform}.json não encontrado — pulando`);
    continue;
  }

  const stat = fs.statSync(file);
  const ageMins = (Date.now() - stat.mtimeMs) / 60000;
  console.log(`📁 ${platform}.json (${Math.round(stat.size / 1024)}KB, ${Math.round(ageMins)}min atrás)`);

  try {
    execSync(`scp "${file}" "${VPS_SESS}"`, { stdio: 'inherit' });
    console.log(`✅ ${platform} enviado!\n`);
  } catch (e) {
    console.error(`❌ Erro ao enviar ${platform}: ${e.message}\n`);
  }
}

// Reiniciar container para recarregar sessões
console.log('🔄 Reiniciando ebook-publisher no VPS...');
try {
  execSync('ssh vps "cd /opt/platform && docker compose -f docker-compose.production.yml restart ebook-publisher"', {
    stdio: 'inherit',
  });
  console.log('\n✅ Container reiniciado!');
  console.log('📋 Logs: ssh vps "docker logs platform-ebook-publisher-1 --tail 50 -f"');
} catch (e) {
  console.error('❌ Erro ao reiniciar:', e.message);
}
