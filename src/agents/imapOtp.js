'use strict';
/**
 * imapOtp.js — Reads the most recent 2FA/OTP code from an email inbox via IMAP.
 *
 * Used to automate Cakto's email-based 2FA (a 6-digit code emailed on each
 * device-verification challenge). Same autonomous category as the stored-credential
 * Puppeteer logins: the system fetches the code programmatically, unattended.
 *
 * Config via env (with sensible Outlook/Hotmail defaults):
 *   OTP_IMAP_HOST      default "outlook.office365.com"
 *   OTP_IMAP_PORT      default 993
 *   OTP_IMAP_USER      default CAKTO_2FA_EMAIL || "mrovariz@hotmail.com"
 *   OTP_IMAP_PASSWORD  required (the mailbox password / app password)
 */

let ImapFlow;
try { ({ ImapFlow } = require('imapflow')); } catch { ImapFlow = null; }

const L = (() => {
  try { const m = require('../utils/logger'); return m.createLogger ? m.createLogger('imapOtp') : null; } catch { return null; }
})();
const log = L || {
  info: (...a) => console.log('[imapOtp]', ...a),
  warn: (...a) => console.warn('[imapOtp]', ...a),
  error: (...a) => console.error('[imapOtp]', ...a),
};

function cfg() {
  return {
    host: process.env.OTP_IMAP_HOST || 'outlook.office365.com',
    port: parseInt(process.env.OTP_IMAP_PORT || '993', 10),
    user: process.env.OTP_IMAP_USER || process.env.CAKTO_2FA_EMAIL || 'mrovariz@hotmail.com',
    pass: process.env.OTP_IMAP_PASSWORD || '',
  };
}

// Circuit breaker: after failures, stop trying for a while so we don't hammer
// Outlook (repeated failed logins can lock the account; repeated timeouts waste
// the whole publish loop). Trips on ANY error — auth failures block for 1h,
// other errors (e.g. ETIMEOUT, "Command failed") block for 15min after a couple
// of consecutive misses.
let _authBlockedUntil = 0;
let _consecutiveFailures = 0;
let _lastBlockLog = 0;

function isAvailable() {
  if (Date.now() < _authBlockedUntil) return false;
  return !!ImapFlow && !!cfg().pass;
}

/** Extract a 4-8 digit code from a text/subject blob. Prefers an isolated 6-digit run. */
function extractCode(text) {
  if (!text) return null;
  const six = text.match(/(?<!\d)(\d{6})(?!\d)/);
  if (six) return six[1];
  const any = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return any ? any[1] : null;
}

/**
 * Fetch the newest OTP code from emails matching `senderHint`/`subjectHint`
 * received within the last `maxAgeMs`. Returns the code string or null.
 */
async function fetchOtp({ senderHint = 'cakto', subjectHints = ['código', 'code', 'verifica', 'verify', 'acesso', 'login'], maxAgeMs = 600_000 } = {}) {
  if (!ImapFlow) { log.warn('imapflow não instalado — pulando IMAP OTP'); return null; }
  const c = cfg();
  if (!c.pass) { log.warn('OTP_IMAP_PASSWORD não configurado — pulando IMAP OTP'); return null; }
  // Circuit breaker open → don't hammer. Log at most once/minute.
  if (Date.now() < _authBlockedUntil) {
    if (Date.now() - _lastBlockLog > 60_000) {
      _lastBlockLog = Date.now();
      const mins = Math.ceil((_authBlockedUntil - Date.now()) / 60_000);
      log.warn('IMAP OTP desativado (circuit breaker) por ~' + mins + 'min');
    }
    return null;
  }

  const client = new ImapFlow({
    host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - maxAgeMs);
      // Search recent messages; filter client-side by sender/subject/body.
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) { log.info('IMAP: nenhuma mensagem recente'); return null; }
      const recent = uids.slice(-15); // newest tail
      let best = null; // { date, code }
      for await (const msg of client.fetch(recent, { envelope: true, source: true }, { uid: true })) {
        const env = msg.envelope || {};
        const from = (env.from || []).map(a => (a.address || '') + ' ' + (a.name || '')).join(' ').toLowerCase();
        const subject = (env.subject || '').toLowerCase();
        const body = msg.source ? msg.source.toString('utf8') : '';
        const matchesSender = senderHint ? from.includes(senderHint.toLowerCase()) : true;
        const matchesSubject = subjectHints.some(h => subject.includes(h.toLowerCase()));
        if (!matchesSender && !matchesSubject) continue;
        const code = extractCode(subject) || extractCode(body);
        if (!code) continue;
        const date = env.date ? new Date(env.date).getTime() : 0;
        if (!best || date > best.date) best = { date, code };
      }
      _consecutiveFailures = 0; // a clean run resets the breaker counter
      if (best) { log.info('IMAP OTP encontrado: ' + best.code + ' (de ' + new Date(best.date).toLocaleString('pt-BR') + ')'); return best.code; }
      log.info('IMAP: nenhuma mensagem com código correspondente');
      return null;
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err));
    const code = (err && err.code) ? err.code : '';
    _consecutiveFailures++;
    // Hard auth failure (e.g. Outlook needs an app password) → trip breaker for 1h immediately.
    if (/auth/i.test(msg) || /login/i.test(msg) || /credential/i.test(msg) || code === 'AUTHENTICATIONFAILED') {
      _authBlockedUntil = Date.now() + 3_600_000;
      log.warn('IMAP OTP auth falhou — desativando por 1h. Use uma APP PASSWORD em OTP_IMAP_PASSWORD. Detalhe: ' + msg.slice(0, 120));
    } else if (_consecutiveFailures >= 2) {
      // Any other repeated error (ETIMEOUT, "Command failed", network) → 15min cooldown
      // so a single publish loop doesn't fire 60 doomed IMAP calls.
      _authBlockedUntil = Date.now() + 900_000;
      log.warn('IMAP OTP falhou ' + _consecutiveFailures + 'x (' + (code || msg.slice(0, 60)) + ') — desativando por 15min');
    } else {
      log.warn('IMAP OTP erro: ' + (code ? code + ' ' : '') + msg.slice(0, 120));
    }
    return null;
  } finally {
    try { await client.logout(); } catch {}
  }
}

module.exports = { fetchOtp, isAvailable, extractCode };
