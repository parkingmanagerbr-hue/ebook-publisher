#!/usr/bin/env node
/**
 * extract-chrome-cookies-v2.js
 *
 * Extrai cookies do Chrome no Windows usando PowerShell para DPAPI
 * e better-sqlite3 para ler o banco de cookies.
 * Funciona mesmo com Chrome aberto (copia o DB primeiro).
 */
const { execSync, execFileSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');

// ── Configuração ──────────────────────────────────────────────────────────────
const SESS_DIR  = path.join(__dirname, '../data/sessions');
const VPS_SESS  = 'vps:/opt/platform/data/ebook-publisher/db/sessions/';
const CHROME_DIR = path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data');
const LOCAL_STATE = path.join(CHROME_DIR, 'Local State');

// Detecta o perfil com mais cookies de hotmart/cakto
function detectBestProfile() {
  const profileDirs = fs.readdirSync(CHROME_DIR).filter(d => d === 'Default' || d.startsWith('Profile '));
  let best = 'Default';
  let bestCount = 0;
  for (const pd of profileDirs) {
    const dbPath = path.join(CHROME_DIR, pd, 'Network', 'Cookies');
    if (!fs.existsSync(dbPath)) continue;
    const tmpDb = path.join(os.tmpdir(), `chrome_probe_${pd.replace(' ','_')}_${Date.now()}.db`);
    try {
      fs.copyFileSync(dbPath, tmpDb);
      let Database;
      try { Database = require('better-sqlite3'); } catch { continue; }
      const db = new Database(tmpDb, { readonly: true });
      const row = db.prepare(
        `SELECT COUNT(*) as c FROM cookies WHERE host_key LIKE '%hotmart%' OR host_key LIKE '%cakto%'`
      ).get();
      db.close();
      const count = row?.c || 0;
      console.log(`  Perfil ${pd}: ${count} cookies hotmart/cakto`);
      if (count > bestCount) { bestCount = count; best = pd; }
    } catch (_) {}
    finally { try { fs.unlinkSync(tmpDb); } catch (_) {} }
  }
  console.log(`  → Usando perfil: ${best} (${bestCount} cookies relevantes)`);
  return path.join(CHROME_DIR, best, 'Network', 'Cookies');
}

const COOKIES_DB  = detectBestProfile();

fs.mkdirSync(SESS_DIR, { recursive: true });

// Plataformas e domínios de interesse
const PLATFORMS = {
  hotmart: {
    label: 'HOTMART',
    domains: ['hotmart.com', 'sso.hotmart.com', 'app-vlc.hotmart.com'],
    testUrl: 'https://app-vlc.hotmart.com/products',
  },
  cakto: {
    label: 'CAKTO',
    domains: ['cakto.com.br', 'app.cakto.com.br'],
    testUrl: 'https://app.cakto.com.br/dashboard',
  },
  amazon: {
    label: 'AMAZON KDP',
    domains: ['amazon.com', 'amazon.com.br', 'kdp.amazon.com'],
    testUrl: 'https://kdp.amazon.com/pt_BR/bookshelf',
  },
};

// ── DPAPI via PowerShell ──────────────────────────────────────────────────────
function dpapiDecrypt(encryptedBase64) {
  // Use semicolons so the single-line command is valid PowerShell
  const ps = [
    `Add-Type -AssemblyName System.Security`,
    `$bytes = [Convert]::FromBase64String('${encryptedBase64}')`,
    `$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[Convert]::ToBase64String($decrypted)`,
  ].join('; ');
  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${ps}"`,
    { encoding: 'utf8', timeout: 10000 }
  ).trim();
  return Buffer.from(result, 'base64');
}

// ── Obter chave AES do Chrome ─────────────────────────────────────────────────
function getChromeAESKey() {
  const state = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
  const encKeyB64 = state.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error('encrypted_key não encontrada em Local State');

  const encKeyBuf = Buffer.from(encKeyB64, 'base64');
  // Remove prefixo "DPAPI" (5 bytes)
  const encKey = encKeyBuf.slice(5);
  const encKeyB64Clean = encKey.toString('base64');

  return dpapiDecrypt(encKeyB64Clean);
}

// ── Descriptografar valor de cookie Chrome v80+ ───────────────────────────────
function decryptCookieValue(encryptedValue, aesKey) {
  if (!encryptedValue || encryptedValue.length < 4) return '';

  const encrypted = Buffer.from(encryptedValue);

  // Verificar prefixo v10 ou v11
  const prefix = encrypted.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Dados legados (sem criptografia AES, possivelmente DPAPI direto)
    try {
      const b64 = encrypted.toString('base64');
      return dpapiDecrypt(b64).toString('utf8');
    } catch {
      return '';
    }
  }

  // AES-256-GCM: nonce=12bytes, ciphertext, tag=16bytes (embutido no final)
  const nonce = encrypted.slice(3, 15);
  const ciphertext = encrypted.slice(15, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return '';
  }
}

// ── Ler cookies do SQLite ─────────────────────────────────────────────────────
function readChromeCookies(aesKey, domains) {
  // Copiar DB para temp (Chrome pode ter o arquivo bloqueado)
  const tmpDb = path.join(os.tmpdir(), `chrome_cookies_${Date.now()}.db`);
  fs.copyFileSync(COOKIES_DB, tmpDb);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error('better-sqlite3 não instalado: npm install better-sqlite3');
  }

  const db = new Database(tmpDb, { readonly: true });

  const cookies = [];

  for (const domain of domains) {
    // Buscar por domínio exato e subdomínios (com e sem ponto)
    const rows = db.prepare(
      `SELECT name, value, encrypted_value, host_key, path,
              expires_utc, is_secure, is_httponly, samesite, priority
       FROM cookies
       WHERE host_key LIKE ? OR host_key LIKE ? OR host_key = ?
       ORDER BY host_key`
    ).all(`%.${domain}`, `%${domain}`, domain);

    for (const row of rows) {
      let cookieValue = row.value;
      if (!cookieValue && row.encrypted_value) {
        cookieValue = decryptCookieValue(row.encrypted_value, aesKey);
      }

      if (!cookieValue) continue;

      // Converter expires_utc (WebKit epoch: microseconds since 1601-01-01)
      let expires = undefined;
      if (row.expires_utc && row.expires_utc > 0) {
        // WebKit epoch to Unix: subtract 11644473600 seconds (in microseconds)
        const unixMs = (row.expires_utc / 1000) - 11644473600000;
        expires = unixMs / 1000; // segundos
      }

      cookies.push({
        name:       row.name,
        value:      cookieValue,
        domain:     row.host_key,
        path:       row.path,
        expires,
        size:       row.name.length + cookieValue.length,
        httpOnly:   row.is_httponly === 1,
        secure:     row.is_secure === 1,
        session:    !row.expires_utc || row.expires_utc === 0,
        sameSite:   ['Strict','Lax','None'][row.samesite] || 'Lax',
        priority:   ['Low','Medium','High'][row.priority] || 'Medium',
      });
    }
  }

  db.close();
  fs.unlinkSync(tmpDb);
  return cookies;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  EXTRAÇÃO DE COOKIES DO CHROME (DPAPI + AES-GCM)');
  console.log('═'.repeat(60));

  // Verificar que os arquivos existem
  if (!fs.existsSync(LOCAL_STATE)) throw new Error(`Local State não encontrado: ${LOCAL_STATE}`);
  if (!fs.existsSync(COOKIES_DB))  throw new Error(`Cookie DB não encontrado: ${COOKIES_DB}`);

  console.log('\n🔑 Decifrando chave AES do Chrome...');
  const aesKey = getChromeAESKey();
  console.log(`✅ Chave AES: ${aesKey.length} bytes`);

  const results = {};

  for (const [key, config] of Object.entries(PLATFORMS)) {
    console.log(`\n── ${config.label} ──────────────────────────────────────`);

    const cookies = readChromeCookies(aesKey, config.domains);
    const httpOnlyCount = cookies.filter(c => c.httpOnly).length;
    console.log(`  🍪 ${cookies.length} cookies (${httpOnlyCount} HttpOnly)`);

    if (cookies.length === 0) {
      console.log(`  ⚠️  Nenhum cookie — verifique se está logado no Chrome em ${config.domains[0]}`);
      results[key] = false;
      continue;
    }

    // Mostrar cookies auth importantes
    const authNames = ['session','auth','token','sid','tgt','castgc','sso','access','refresh','jwt'];
    const authCookies = cookies.filter(c => authNames.some(n => c.name.toLowerCase().includes(n)));
    if (authCookies.length > 0) {
      console.log(`  🔑 Auth: ${authCookies.map(c => c.name).join(', ')}`);
    }

    // Carregar sessão anterior para preservar localStorage
    const sessionFile = path.join(SESS_DIR, `${key}.json`);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch {}

    const session = {
      platform: key,
      url: config.testUrl,
      cookies,
      localStorage:   prev.localStorage   || {},
      sessionStorage: prev.sessionStorage  || {},
      savedAt:        Date.now(),
      savedAtHuman:   new Date().toLocaleString('pt-BR'),
      cookieCount:    cookies.length,
      capturedVia:    'extract-chrome-cookies-v2 (AES-GCM + DPAPI)',
    };

    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    console.log(`  ✅ Salvo: ${sessionFile} (${Math.round(JSON.stringify(session).length/1024)}KB)`);
    results[key] = true;
  }

  // Resumo
  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  for (const [key, ok] of Object.entries(results)) {
    console.log(`  ${ok ? '✅' : '❌'} ${PLATFORMS[key].label}`);
  }

  const anyOk = Object.values(results).some(Boolean);
  if (!anyOk) {
    console.log('\n❌ Nenhuma sessão capturada.');
    process.exit(1);
  }

  // Enviar para VPS
  console.log('\n📤 Enviando para VPS...');
  const filesToSend = Object.entries(results)
    .filter(([, ok]) => ok)
    .map(([key]) => `"${path.join(SESS_DIR, `${key}.json`)}"`);

  try {
    execSync(
      `scp ${filesToSend.join(' ')} ${VPS_SESS}`,
      { stdio: 'inherit', timeout: 30000 }
    );
    console.log('✅ Sessões enviadas para o VPS!');

    console.log('\n🔄 Reiniciando ebook-publisher...');
    execSync(
      'ssh vps "cd /opt/platform && docker compose -f docker-compose.production.yml restart ebook-publisher"',
      { stdio: 'inherit', timeout: 60000 }
    );
    console.log('✅ Container reiniciado!\n');
  } catch (e) {
    console.error('❌ Erro ao enviar:', e.message);
    console.log('\n📋 Envio manual:');
    console.log(`  scp data/sessions/*.json ${VPS_SESS}`);
  }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
