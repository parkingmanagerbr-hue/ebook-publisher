'use strict';
/**
 * webEbookAgents/index.js — Orquestrador de geração de ebooks via serviços web gratuitos
 *
 * ORDEM DE PRIORIDADE (todos os créditos de uma conta antes de passar pra próxima):
 *   1. Gamma.app       (8 gerações/mês por conta × 6 contas = 48/mês)
 *   2. Piktochart      (5 gerações/mês por conta × 6 contas = 30/mês)
 *   3. ebookmaker.ai   (10 gerações/mês por conta × 6 contas = 60/mês)
 *   4. Visme           (5 gerações/mês por conta × 6 contas = 30/mês)
 *   → Normal pipeline  (writerAgent + pdfAgent — sem limite)
 *
 * Total potencial: 168 ebooks/mês gratuitos antes de usar a pipeline normal.
 *
 * Uso:
 *   const { tryWebEbookGeneration } = require('./agents/webEbookAgents');
 *   const result = await tryWebEbookGeneration({ topic, language });
 *   if (result) { // usar result.pdfPath, result.title, etc. }
 *   else { // fallback para pipeline normal }
 *
 * Reseta automaticamente no dia 1 de cada mês via cron em autonomousAgent.
 */

const creditTracker = require('./creditTracker');
const { generateWithGamma }       = require('./gammaAgent');
const { generateWithPiktochart }  = require('./piktochartAgent');
const { generateWithEbookmaker }  = require('./ebookmakerAgent');
const { generateWithVisme }       = require('./vismeAgent');

const GENERATORS = {
  gamma:      generateWithGamma,
  piktochart: generateWithPiktochart,
  ebookmaker: generateWithEbookmaker,
  visme:      generateWithVisme,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Tenta gerar ebook usando serviços web gratuitos.
 * Percorre serviços e contas em ordem até conseguir ou esgotar todos.
 *
 * @param {{ topic: string, language: string }} opts
 * @returns {{ title, description, pdfPath, source, email } | null}
 */
async function tryWebEbookGeneration({ topic, language = 'en' }) {
  // Verificar se todos os créditos estão esgotados
  if (creditTracker.isAllExhausted()) {
    console.log('[webEbook] Todos os créditos mensais esgotados — usando pipeline normal');
    return null;
  }

  const summary = creditTracker.getSummary();
  console.log(`[webEbook] Créditos disponíveis este mês (${summary.month}):`);
  for (const [svc, info] of Object.entries(summary.services)) {
    if (!info.exhausted) {
      console.log(`  ${svc}: ${info.remaining}/${info.total} restantes`);
    }
  }

  // Tentar até 3 slots diferentes antes de desistir
  let attempts = 0;
  const maxAttempts = 6;

  while (attempts < maxAttempts) {
    const slot = creditTracker.getNextSlot();
    if (!slot) {
      console.log('[webEbook] Sem slots disponíveis — pipeline normal');
      return null;
    }

    const { service, email, googleSessionFile, serviceSessionFile, remaining } = slot;
    console.log(`[webEbook] Tentativa ${attempts+1}: ${service} com ${email} (${remaining} restantes)`);

    const generator = GENERATORS[service];
    if (!generator) {
      console.warn(`[webEbook] Generator não encontrado: ${service}`);
      creditTracker.recordFailure(service, email, 'generator-not-found');
      attempts++;
      continue;
    }

    try {
      const result = await Promise.race([
        generator({ topic, language, email, googleSessionFile, serviceSessionFile }),
        // Timeout de 10 min por tentativa
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 10min')), 600000)),
      ]);

      if (result && result.pdfPath) {
        creditTracker.recordSuccess(service, email);
        console.log(`[webEbook] ✅ ${service} | ${email} | ${result.pdfPath}`);

        // Salvar estado no genia para não perder
        saveGenieState(service, email, result);

        return {
          ...result,
          service,
          webGenerated: true,
        };
      }

      throw new Error('PDF não retornado pelo agente');

    } catch (err) {
      console.warn(`[webEbook] ❌ ${service}/${email}: ${err.message.slice(0, 100)}`);
      creditTracker.recordFailure(service, email, err.message.slice(0, 100));
      attempts++;
      await sleep(2000);
    }
  }

  console.log('[webEbook] Todas as tentativas esgotadas — pipeline normal');
  return null;
}

/**
 * Salva estado de sucesso no arquivo genia para memória persistente.
 * Próxima geração sabe quais contas funcionaram.
 */
function saveGenieState(service, email, result) {
  try {
    const fs   = require('fs');
    const path = require('path');
    const DATA_DIR  = process.env.DATA_DIR || '/app/data';
    const GENIA_DIR = path.join(DATA_DIR, 'genia');
    const LOG_FILE  = path.join(GENIA_DIR, 'successful_generations.json');

    fs.mkdirSync(GENIA_DIR, { recursive: true });

    let log = [];
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}

    log.unshift({
      timestamp: new Date().toISOString(),
      service,
      email,
      title: result.title,
      pdfPath: result.pdfPath,
      sourceUrl: result.sourceUrl,
    });

    // Manter só os últimos 200 registros
    if (log.length > 200) log = log.slice(0, 200);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch {}
}

/**
 * Reset mensal — chamado pelo cron no dia 1 de cada mês.
 * Reseta todos os contadores de crédito.
 */
function resetMonthlyCredits() {
  return creditTracker.resetMonthly();
}

/**
 * Retorna resumo de créditos para o dashboard.
 */
function getCreditsSummary() {
  return creditTracker.getSummary();
}

/**
 * Verifica se todos os créditos mensais estão esgotados.
 */
function isAllExhausted() {
  return creditTracker.isAllExhausted();
}

module.exports = {
  tryWebEbookGeneration,
  resetMonthlyCredits,
  getCreditsSummary,
  isAllExhausted,
};
