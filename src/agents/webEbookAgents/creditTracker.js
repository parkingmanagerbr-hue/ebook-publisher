'use strict';
/**
 * creditTracker.js — Controle de créditos mensais dos serviços web de geração de ebooks
 *
 * Cada conta Gmail tem uma cota gratuita mensal por serviço.
 * Quando esgotada, passa para a próxima conta. Quando todas as contas de um
 * serviço esgotam, passa para o próximo serviço. Quando todos os serviços
 * esgotam, volta ao pipeline normal (writerAgent + pdfAgent).
 *
 * Estado persistido em /app/data/web_ebook_credits.json
 * Cópia espelho em /app/data/genia/web_ebook_state.json (conforme solicitado)
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || '/app/data';
const STATE_FILE  = path.join(DATA_DIR, 'web_ebook_credits.json');
const GENIA_DIR   = path.join(DATA_DIR, 'genia');
const GENIA_FILE  = path.join(GENIA_DIR, 'web_ebook_state.json');
const SESS_DIR    = path.join(DATA_DIR, 'sessions');

// Limites mensais por conta (conservadores — ajuste via env)
const LIMITS = {
  gamma:       parseInt(process.env.GAMMA_MONTHLY_LIMIT       || '8'),
  piktochart:  parseInt(process.env.PIKTOCHART_MONTHLY_LIMIT  || '5'),
  ebookmaker:  parseInt(process.env.EBOOKMAKER_MONTHLY_LIMIT  || '10'),
  visme:       parseInt(process.env.VISME_MONTHLY_LIMIT       || '5'),
};

// Contas Gmail em ordem de prioridade (mais recursos primeiro)
const GMAIL_ACCOUNTS = [
  'mrovariz@gmail.com',
  'parkingmanagerbr@gmail.com',
  'whatsiahub@gmail.com',
  'contosfolks@gmail.com',
  'cortes30vs@gmail.com',
  'estoriasdeamor90@gmail.com',
];

// Serviços em ordem de prioridade
const SERVICE_PRIORITY = ['gamma', 'piktochart', 'ebookmaker', 'visme'];

// ── Carrega ou inicializa o estado ────────────────────────────────────────────
function loadState() {
  const month = new Date().toISOString().slice(0, 7); // "2026-06"
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Reset automático se mudou o mês
    if (raw.month !== month) {
      console.log(`[creditTracker] Novo mês detectado (${raw.month} → ${month}) — resetando créditos`);
      return buildFreshState(month);
    }
    return raw;
  } catch {
    return buildFreshState(month);
  }
}

function buildFreshState(month) {
  const state = { month, services: {} };
  for (const svc of SERVICE_PRIORITY) {
    state.services[svc] = { accounts: {} };
    for (const email of GMAIL_ACCOUNTS) {
      state.services[svc].accounts[email] = {
        used:         0,
        limit:        LIMITS[svc],
        sessionFile:  sessionFileFor(email, svc),
        lastUsed:     null,
        lastSuccess:  null,
        failures:     0,
      };
    }
  }
  return state;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // Espelha em /genia para persistência de conhecimento
  try {
    fs.mkdirSync(GENIA_DIR, { recursive: true });
    fs.writeFileSync(GENIA_FILE, JSON.stringify({
      ...state,
      _description: 'Estado dos créditos web ebook agents — gerado automaticamente',
      _updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function sessionFileFor(email, service) {
  const safeEmail = email.replace(/[@.]/g, '_');
  return path.join(SESS_DIR, `${service}_${safeEmail}.json`);
}

function googleSessionFor(email) {
  const safeEmail = email.replace(/[@.]/g, '_');
  return path.join(SESS_DIR, `google_${safeEmail}.json`);
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Retorna { service, email, googleSessionFile, serviceSessionFile } para o próximo
 * slot disponível, percorrendo serviços e contas em ordem de prioridade.
 * Retorna null se TODOS os créditos estão esgotados este mês.
 */
function getNextSlot() {
  const state = loadState();

  for (const svc of SERVICE_PRIORITY) {
    for (const email of GMAIL_ACCOUNTS) {
      const acc = state.services[svc]?.accounts?.[email];
      if (!acc) continue;
      if (acc.used >= acc.limit) continue;
      if (acc.failures >= 5) continue; // Muitas falhas — pular esta conta neste serviço

      // Verificar se a sessão Google existe (necessária para OAuth)
      const googleSess = googleSessionFor(email);
      if (!fs.existsSync(googleSess)) {
        console.log(`[creditTracker] Sem sessão Google para ${email} — pulando`);
        continue;
      }

      return {
        service:            svc,
        email,
        googleSessionFile:  googleSess,
        serviceSessionFile: acc.sessionFile,
        used:               acc.used,
        limit:              acc.limit,
        remaining:          acc.limit - acc.used,
      };
    }
  }
  return null; // Todos esgotados
}

/**
 * Marca uso bem-sucedido de um slot.
 */
function recordSuccess(service, email) {
  const state = loadState();
  if (state.services[service]?.accounts?.[email]) {
    state.services[service].accounts[email].used++;
    state.services[service].accounts[email].lastUsed    = new Date().toISOString();
    state.services[service].accounts[email].lastSuccess = new Date().toISOString();
    state.services[service].accounts[email].failures    = 0;
  }
  saveState(state);
}

/**
 * Marca falha — incrementa counter de falhas. Após 5 falhas, a conta é ignorada.
 */
function recordFailure(service, email, reason) {
  const state = loadState();
  if (state.services[service]?.accounts?.[email]) {
    state.services[service].accounts[email].failures =
      (state.services[service].accounts[email].failures || 0) + 1;
    state.services[service].accounts[email].lastFailure = reason;
    state.services[service].accounts[email].lastUsed    = new Date().toISOString();
  }
  saveState(state);
}

/**
 * Força o uso de uma conta específica num serviço (para testes).
 */
function forceSlot(service, email) {
  const googleSess  = googleSessionFor(email);
  const state       = loadState();
  const acc         = state.services[service]?.accounts?.[email] || {};
  return {
    service,
    email,
    googleSessionFile:  googleSess,
    serviceSessionFile: sessionFileFor(email, service),
    used:               acc.used || 0,
    limit:              acc.limit || LIMITS[service],
    remaining:          (acc.limit || LIMITS[service]) - (acc.used || 0),
  };
}

/**
 * Reset mensal — chamado pelo cron no dia 1 de cada mês.
 */
function resetMonthly() {
  const month    = new Date().toISOString().slice(0, 7);
  const newState = buildFreshState(month);
  saveState(newState);
  console.log(`[creditTracker] ✅ Créditos mensais resetados para ${month}`);
  return newState;
}

/**
 * Retorna resumo do estado atual para logging/dashboard.
 */
function getSummary() {
  const state = loadState();
  const summary = { month: state.month, services: {} };
  for (const svc of SERVICE_PRIORITY) {
    const accounts = state.services[svc]?.accounts || {};
    const total    = GMAIL_ACCOUNTS.length * LIMITS[svc];
    const used     = Object.values(accounts).reduce((s, a) => s + (a.used || 0), 0);
    summary.services[svc] = {
      used,
      total,
      remaining: total - used,
      exhausted: used >= total,
      accounts:  Object.entries(accounts).map(([e, a]) => ({
        email: e,
        used: a.used,
        limit: a.limit,
        failures: a.failures || 0,
      })),
    };
  }
  return summary;
}

/**
 * Verifica se todos os serviços estão esgotados (deve usar pipeline normal).
 */
function isAllExhausted() {
  return getNextSlot() === null;
}

module.exports = {
  getNextSlot,
  recordSuccess,
  recordFailure,
  forceSlot,
  resetMonthly,
  getSummary,
  isAllExhausted,
  SERVICE_PRIORITY,
  GMAIL_ACCOUNTS,
  LIMITS,
};
