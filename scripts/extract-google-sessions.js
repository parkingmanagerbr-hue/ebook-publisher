#!/usr/bin/env node
/**
 * extract-google-sessions.js
 *
 * Extrai cookies do Google (accounts.google.com) de TODOS os perfis Chrome
 * que possuem contas Gmail. Salva sessões em data/sessions/google_EMAIL.json
 * e envia para o VPS automaticamente.
 *
 * Gmail accounts encontrados:
 *   mrovariz@gmail.com        (Profile 1)
 *   contosfolks@gmail.com     (Profile 2)
 *   estoriasdeamor90@gmail.com(Profile 4)
 *   parkingmanagerbr@gmail.com(Profile 10)
 *   whatsiahub@gmail.com      (Profile 17)
 *   cortes30vs@gmail.com      (Profile 27)
 */
'use strict';
const { execSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const SESS_DIR   = path.join(__dirname, '../data/sessions');
const CHROME_DIR = path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data');
const LOCAL_STATE = path.join(CHROME_DIR, 'Local State');
const VPS_SESS   = 'vps:/opt/platform/ebook-publisher/data/sessions/';

// Perfis Gmail conhecidos — mapeia profile dir → email
const GMAIL_PROFILES = {
  'Profile 1':  'mrovariz@gmail.com',
  'Profile 2':  'contosfolks@gmail.com',
  'Profile 4':  'estoriasdeamor90@gmail.com',
  'Profile 10': 'parkingmanagerbr@gmail.com',
  'Profile 17': 'whatsiahub@gmail.com',
  'Profile 27': 'cortes30vs@gmail.com',
};

// Domínios Google necessários para OAuth
const GOOGLE_DOMAINS = [
  'accounts.google.com',
  '.google.com',
  'google.com',
  '.googleapis.com',
  'oauth2.googleapis.com',
];

fs.mkdirSync(SESS_DIR, { recursive: true });

// ── DPAPI via PowerShell ──────────────────────────────────────────────────────
function dpapiDecrypt(encryptedBase64) {
  const ps = [
    `Add-Type -AssemblyName System.Security`,
    `$bytes = [Convert]::FromBase64String('${encryptedBase64}')`,
    `$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[Convert]::ToBase64String($decrypted)`,
  ].join('; ');
  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${ps}"`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();
  return Buffer.from(result, 'base64');
}

function getChromeAESKey() {
  const state = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
  const encKeyB64 = state.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error('encrypted_key não encontrada em Local State');
  const encKeyBuf = Buffer.from(encKeyB64, 'base64');
  const encKey = encKeyBuf.slice(5); // Remove prefixo "DPAPI"
  return dpapiDecrypt(encKey.toString('base64'));
}

function decryptCookieValue(encryptedValue, aesKey) {
  if (!encryptedValue || encryptedValue.length < 4) return '';
  const encrypted = Buffer.from(encryptedValue);
  const prefix = encrypted.slice(0, 3).toString('utf8');
  // ONLY decrypt AES-GCM cookies (v10/v11). Skip legacy DPAPI cookies — they
  // require one PowerShell call per cookie which is extremely slow and produces
  // noise. Modern Chrome (v80+) uses AES-GCM for all Google cookies.
  if (prefix !== 'v10' && prefix !== 'v11') return '';
  const nonce      = encrypted.slice(3, 15);
  const ciphertext = encrypted.slice(15, encrypted.length - 16);
  const tag        = encrypted.slice(encrypted.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function readCookiesFromProfile(profileDir, aesKey, domains) {
  const dbPath = path.join(profileDir, 'Network', 'Cookies');
  if (!fs.existsSync(dbPath)) return [];

  const tmpDb = path.join(os.tmpdir(), `chrome_google_${Date.now()}.db`);
  try {
    // Use robocopy /B (backup mode) to copy even locked files
    try {
      fs.copyFileSync(dbPath, tmpDb);
    } catch (lockErr) {
      if (lockErr.code === 'EBUSY' || lockErr.code === 'EACCES') {
        const srcDir  = path.dirname(dbPath);
        const srcName = path.basename(dbPath);
        const tmpDir  = path.dirname(tmpDb);
        const tmpName = path.basename(tmpDb);
        execSync(
          `robocopy "${srcDir}" "${tmpDir}" "${srcName}" /B /NP /NFL /NDL /NJH /NJS /R:1 /W:1`,
          { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
        );
        const roboCopied = path.join(tmpDir, srcName);
        if (fs.existsSync(roboCopied) && roboCopied !== tmpDb) fs.renameSync(roboCopied, tmpDb);
        if (!fs.existsSync(tmpDb)) throw lockErr;
      } else { throw lockErr; }
    }
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { throw new Error('better-sqlite3 não instalado: npm install better-sqlite3'); }

    const db = new Database(tmpDb, { readonly: true });
    const cookies = [];

    for (const domain of domains) {
      const rows = db.prepare(
        `SELECT name, value, encrypted_value, host_key, path,
                expires_utc, is_secure, is_httponly, samesite, priority
         FROM cookies
         WHERE host_key LIKE ? OR host_key = ?
         ORDER BY host_key`
      ).all(`%${domain}`, domain);

      for (const row of rows) {
        let val = row.value;
        if (!val && row.encrypted_value) val = decryptCookieValue(row.encrypted_value, aesKey);
        if (!val) continue;

        let expires;
        if (row.expires_utc && row.expires_utc > 0) {
          expires = (row.expires_utc / 1000 - 11644473600000) / 1000;
        }

        cookies.push({
          name:     row.name,
          value:    val,
          domain:   row.host_key,
          path:     row.path,
          expires,
          httpOnly: row.is_httponly === 1,
          secure:   row.is_secure === 1,
          session:  !row.expires_utc || row.expires_utc === 0,
          sameSite: ['Strict','Lax','None'][row.samesite] || 'Lax',
        });
      }
    }

    db.close();
    return cookies;
  } finally {
    try { fs.unlinkSync(tmpDb); } catch {}
  }
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  EXTRAÇÃO DE SESSÕES GOOGLE (TODOS OS PERFIS)');
  console.log('═'.repeat(60));

  if (!fs.existsSync(LOCAL_STATE)) throw new Error(`Local State não encontrado: ${LOCAL_STATE}`);

  console.log('\n🔑 Decifrando chave AES do Chrome...');
  const aesKey = getChromeAESKey();
  console.log(`✅ Chave AES: ${aesKey.length} bytes`);

  const results   = {};
  const savedFiles = [];

  for (const [profileName, email] of Object.entries(GMAIL_PROFILES)) {
    console.log(`\n── ${email} (${profileName}) ─────────────────────────`);
    const profileDir = path.join(CHROME_DIR, profileName);

    if (!fs.existsSync(profileDir)) {
      console.log(`  ⚠️  Perfil não encontrado: ${profileDir}`);
      results[email] = false;
      continue;
    }

    let cookies;
    try {
      cookies = readCookiesFromProfile(profileDir, aesKey, GOOGLE_DOMAINS);
    } catch (e) {
      console.log(`  ❌ Erro ao ler cookies: ${e.message}`);
      results[email] = false;
      continue;
    }

    console.log(`  🍪 ${cookies.length} cookies Google encontrados`);

    if (cookies.length === 0) {
      console.log(`  ⚠️  Nenhum cookie — verifique se está logado no Google neste perfil`);
      results[email] = false;
      continue;
    }

    // Verificar se tem cookies auth essenciais
    const authCookies = cookies.filter(c =>
      ['SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LSID', '__Secure-1PSID', '__Secure-3PSID'].includes(c.name)
    );
    console.log(`  🔑 Auth cookies: ${authCookies.map(c => c.name).join(', ')}`);

    const safeEmail = email.replace(/[@.]/g, '_');
    const sessFile  = path.join(SESS_DIR, `google_${safeEmail}.json`);
    const session   = {
      platform:   'google',
      email,
      profile:    profileName,
      cookies,
      savedAt:    Date.now(),
      savedAtHuman: new Date().toLocaleString('pt-BR'),
      cookieCount: cookies.length,
      authCount:  authCookies.length,
    };

    fs.writeFileSync(sessFile, JSON.stringify(session, null, 2));
    console.log(`  ✅ Salvo: ${sessFile} (${Math.round(JSON.stringify(session).length / 1024)}KB)`);
    savedFiles.push(sessFile);
    results[email] = true;
  }

  // Salvar também o manifest de contas disponíveis
  const manifestPath = path.join(SESS_DIR, 'google_accounts.json');
  const manifest = {
    updatedAt: new Date().toISOString(),
    accounts: Object.entries(results).map(([email, ok]) => ({
      email,
      profile: Object.keys(GMAIL_PROFILES).find(k => GMAIL_PROFILES[k] === email),
      hasSession: ok,
      sessionFile: ok ? `google_${email.replace(/[@.]/g, '_')}.json` : null,
    })),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n📋 Manifest salvo: ${manifestPath}`);

  // Resumo
  console.log('\n' + '═'.repeat(60));
  console.log('  RESUMO');
  for (const [email, ok] of Object.entries(results)) {
    console.log(`  ${ok ? '✅' : '❌'} ${email}`);
  }

  const toSend = [...savedFiles, manifestPath];
  if (toSend.length === 0) {
    console.log('\n❌ Nenhuma sessão capturada.');
    process.exit(1);
  }

  // Enviar para VPS
  console.log('\n📤 Enviando para VPS...');
  try {
    execSync(
      `scp ${toSend.map(f => `"${f}"`).join(' ')} ${VPS_SESS}`,
      { stdio: 'inherit', timeout: 30000 }
    );
    console.log('✅ Sessões Google enviadas para o VPS!');
  } catch (e) {
    console.error('❌ Erro ao enviar:', e.message);
    console.log('\n📋 Envio manual:');
    console.log(`  scp data/sessions/google_*.json ${VPS_SESS}`);
  }
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
