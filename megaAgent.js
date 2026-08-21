'use strict';
// Desabilitar verificação TLS (necessário em ambientes com proxy/VPN que interceptam SSL)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
/**
 * megaAgent.js — Loop infinito GENIA: trending search → ebook + audiobook → multi-store publish
 *
 * Funcionalidades:
 *   1. Busca assuntos mais procurados (Google Trends BR + lista viral)
 *   2. Gera ebooks usando TODOS os pipelines disponíveis:
 *      - Gamma, Piktochart, ebookmaker.ai, Visme (serviços web)
 *      - Pipeline normal (writerAgent + pdfAgent) — ilimitado
 *   3. Gera audiobook para cada ebook (Edge TTS gratuito, sem limite)
 *   4. Publica em Hotmart + Cakto + Amazon KDP
 *   5. Usa TODAS as chaves GENIA com fallback automático
 *   6. Nunca para, nunca pede permissão
 *
 * Uso:
 *   node megaAgent.js
 */
const path = require('path');
// Carregar .env do diretório do próprio script (independente do cwd)
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs   = require('fs');

// ── Logger ──────────────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'logs', 'megaAgent.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

log('');
log('╔══════════════════════════════════════════════════════════════╗');
log('║  GENIA MegaAgent — Loop Infinito de Geração e Publicação    ║');
log('╚══════════════════════════════════════════════════════════════╝');
log(`  Chrome: ${process.env.CHROME_EXECUTABLE}`);
log(`  Preço:  R$ ${process.env.EBOOK_PRICE}`);
log(`  Idiomas: ${process.env.EBOOK_LANGUAGES}`);
log(`  Hotmart: ${process.env.AUTO_PUBLISH_HOTMART} | Cakto: ${process.env.AUTO_PUBLISH_CAKTO} | Amazon: ${process.env.AUTO_PUBLISH_AMAZON}`);
log('');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Estado ────────────────────────────────────────────────────────────────────
let cycleCount = 0;
let lastTrendFetch = 0;
let hotmartFailStreak = 0;
let lastHotmartRenew = 0;
const TREND_REFRESH_INTERVAL    = 6 * 60 * 60 * 1000; // 6h
const HOTMART_RENEW_COOLDOWN_MS = 30 * 60 * 1000;     // 30min entre renovações

// ── Hotmart session auto-renewal ──────────────────────────────────────────────
async function renewHotmartIfNeeded(forceRenew = false) {
  const now = Date.now();
  if (!forceRenew && (now - lastHotmartRenew) < HOTMART_RENEW_COOLDOWN_MS) return;
  if (!forceRenew && hotmartFailStreak < 2) return;

  log('[Hotmart] 🔄 Renovando sessão automaticamente...');
  lastHotmartRenew = now;
  hotmartFailStreak = 0;

  try {
    const { execFile } = require('child_process');
    await new Promise((resolve) => {
      const proc = execFile(process.execPath,
        [path.join(__dirname, 'scripts', 'renewHotmartSession.js')],
        { timeout: 5 * 60 * 1000 },
        (err, stdout) => {
          if (err) log('[Hotmart] Renovação error: ' + err.message.slice(0, 100));
          else log('[Hotmart] Renovação concluída');
          resolve();
        }
      );
      // Stream stdout to log
      proc.stdout?.on('data', d => log('[Hotmart:renew] ' + d.toString().trim()));
    });
  } catch(e) {
    log('[Hotmart] Renovação falhou: ' + e.message);
  }
}

// ── Audiobook generation ──────────────────────────────────────────────────────
async function generateAudiobookForEbook(ebookId, title, content) {
  if (process.env.GENERATE_AUDIOBOOK !== 'true') return null;
  try {
    const { generateAudiobook } = require('./src/agents/audiobookAgent');
    log(`[Audio] Gerando audiobook para: "${title.slice(0, 50)}"`);
    const result = await generateAudiobook({ ebookId, title, content });
    if (result?.audioPath) {
      log(`[Audio] ✅ Audiobook salvo: ${result.audioPath}`);
      return result.audioPath;
    }
  } catch (e) {
    log(`[Audio] ⚠️  Audiobook error: ${e.message.slice(0, 100)}`);
  }
  return null;
}

// ── Sales sync ────────────────────────────────────────────────────────────────
let _lastSalesSync = 0;
const SALES_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

async function syncSalesIfNeeded() {
  if (Date.now() - _lastSalesSync < SALES_SYNC_INTERVAL_MS) return;
  _lastSalesSync = Date.now();
  try {
    log('[Sales] Sincronizando métricas de vendas (Cakto + Hotmart)...');
    const { syncSalesFromPlatforms } = require('./src/agents/learningAgent');
    const result = await syncSalesFromPlatforms();
    log(`[Sales] Sync concluído: Cakto=${result.syncedCakto} Hotmart=${result.syncedHotmart}`);
  } catch (e) {
    log(`[Sales] ⚠️ Sync erro: ${e.message.slice(0, 80)}`);
  }
}

// ── Afiliados: discovery → landing pages → backlinks ──────────────────────────
let _lastAffiliateRun = 0;
const AFFILIATE_INTERVAL_MS = (parseInt(process.env.AFFILIATE_RUN_INTERVAL_HOURS || '24')) * 60 * 60 * 1000;

async function runAffiliatesIfNeeded() {
  if (process.env.AFFILIATE_AGENT_ENABLED === 'false') return;
  if (Date.now() - _lastAffiliateRun < AFFILIATE_INTERVAL_MS) return;
  _lastAffiliateRun = Date.now();

  try {
    log('[Afiliados] 🔗 Descobrindo produtos (Hotmart + Cakto + Amazon)...');
    const { runAffiliateAgent } = require('./src/agents/affiliateAgent');
    const produtos = await runAffiliateAgent();
    log(`[Afiliados] ✅ ${(produtos || []).length} produtos processados`);

    // Landing pages: TODAS num único site Netlify (/slug/ + hub). Produtos c/ affiliate_link
    // (Amazon instantâneo; Hotmart/Cakto entram conforme aprovação). Sem explosão de sites.
    try {
      const { deployAllOneSite } = require('./src/agents/landingPageAgent');
      const lp = await deployAllOneSite({ lang: 'pt' });
      log(`[Afiliados] 🌐 ${lp.count} páginas de venda no ar → ${lp.siteUrl || '(sem links ainda)'}`);
    } catch (e) { log(`[Afiliados] ⚠️ Landing pages erro: ${e.message.slice(0, 80)}`); }

    // Hub de backlinks
    try {
      const { buildBacklinks } = require('./src/agents/backlinkAgent');
      await buildBacklinks();
      log('[Afiliados] 🔗 Backlinks atualizados');
    } catch (e) { log(`[Afiliados] ⚠️ Backlinks erro: ${e.message.slice(0, 80)}`); }
  } catch (e) {
    log(`[Afiliados] ⚠️ Erro: ${e.message.slice(0, 100)}`);
  }
}

// ── Topic injection ───────────────────────────────────────────────────────────
async function refreshTrending() {
  const now = Date.now();
  if (now - lastTrendFetch < TREND_REFRESH_INTERVAL) return;
  lastTrendFetch = now;
  try {
    log('[Trending] Buscando assuntos mais procurados...');
    const { runInjection } = require('./scripts/trendingInjector');
    await runInjection();
    log('[Trending] ✅ Tópicos atualizados');
  } catch (e) {
    log(`[Trending] ⚠️  Error: ${e.message}`);
  }
}

// ── Web ebook agents ──────────────────────────────────────────────────────────
async function tryWebEbookService(topic, language) {
  try {
    const { tryWebEbookGeneration } = require('./src/agents/webEbookAgents/index');
    log(`[WebEbook] Tentando serviços web para: "${topic.slice(0, 50)}"`);
    const result = await tryWebEbookGeneration({ topic, language });
    if (result?.success && result?.pdfPath) {
      log(`[WebEbook] ✅ Ebook gerado via ${result.service}: ${result.pdfPath}`);
      return result;
    }
  } catch (e) {
    log(`[WebEbook] ⚠️  Web services error: ${e.message.slice(0, 100)}`);
  }
  return null;
}

// ── Main pipeline per cycle ───────────────────────────────────────────────────
async function runCycle() {
  cycleCount++;
  log(`\n${'═'.repeat(65)}`);
  log(`🚀 CICLO ${cycleCount} — ${new Date().toLocaleString('pt-BR')}`);
  log(`${'═'.repeat(65)}`);

  // Garantir que variáveis críticas estejam definidas (caso o processo tenha iniciado sem elas)
  process.env.SKIP_ILLUSTRATIONS = process.env.SKIP_ILLUSTRATIONS || 'true';

  // 1. Refresh trending topics periodically
  await refreshTrending();

  // 2. Run the main pipeline (handles topic selection, generation, publication)
  try {
    // Clear module caches for hot-reload (especially aiClient so key changes are picked up)
    ['./src/core/autonomousAgent', './src/index', './src/agents/writerAgent',
     './src/agents/pdfAgent', './src/agents/coverAgent',
     './src/agents/coverAgentHTML', './src/agents/geminiImageAgent',
     './src/agents/publisherHotmart', './src/agents/publisherCakto',
     './src/core/aiClient', './src/agents/audiobookAgent',
     './src/agents/edgeTtsAgent'].forEach(m => {
      try { delete require.cache[require.resolve(m)]; } catch {}
    });

    const { runPipeline } = require('./src/index');
    const db = require('./src/core/database');

    // Get next topic
    let topic = null;
    const t = db.getNextTopic();
    if (t) {
      topic = t.topic;
      // Topico reciclado = acabaram os inditos. Reabastece para os proximos
      // ciclos (a expansao por IA cuida disso quando a lista estatica esgota).
      if (t.reciclado) {
        log('[Topics] pool de ineditos esgotado — reabastecendo em segundo plano...');
        const { expandTopics } = require('./src/agents/topicExpander');
        expandTopics()
          .then(r => log(`[Topics] reabastecimento: +${r.added} (total ${r.total})`))
          .catch(e => log(`[Topics] reabastecimento falhou (nao critico): ${e.message.slice(0, 90)}`));
      }
    } else {
      // Expand topics if DB is empty
      log('[Topics] DB vazio — expandindo tópicos...');
      const { expandTopics } = require('./src/agents/topicExpander');
      await expandTopics();
      const t2 = db.getNextTopic();
      if (t2) topic = t2.topic;
    }

    if (!topic) {
      log('[Topics] ⚠️  Nenhum tópico disponível, usando fallback...');
      topic = 'Como ganhar dinheiro com inteligência artificial em 2026';
    }

    // Rotate language: mostly pt-BR, occasional en/es
    const langs = ['pt-BR', 'pt-BR', 'pt-BR', 'en', 'pt-BR', 'es'];
    const language = langs[cycleCount % langs.length];

    log(`[Pipeline] Tópico: "${topic.slice(0, 60)}" [${language}]`);

    // Try web ebook services first (higher quality, limited credits)
    // Disabled for now if webEbookAgents not fully configured
    // const webResult = await tryWebEbookService(topic, language);

    // Main pipeline
    const result = await runPipeline(topic, language);

    if (result?.success) {
      log(`[Pipeline] ✅ "${result.title}" gerado em ${result.pdfPath}`);

      // Track Hotmart publish success/failure for auto-renewal
      const hotmartOk = result.publishResults?.hotmart?.success === true;
      const hotmartFailed = result.publishResults?.hotmart && !hotmartOk;
      if (hotmartFailed) {
        hotmartFailStreak++;
        log(`[Hotmart] ⚠️ Falha na publicação (streak: ${hotmartFailStreak}) — ${result.publishResults.hotmart.error || 'unknown'}`);
        await renewHotmartIfNeeded();
      } else if (hotmartOk) {
        hotmartFailStreak = 0;
        log(`[Hotmart] ✅ Publicado com sucesso: ${result.publishResults.hotmart.url}`);
      }

      // Audiobook generation (async, doesn't block next cycle)
      if (result.content || result.text) {
        generateAudiobookForEbook(result.ebookId, result.title, result.content || result.text)
          .catch(e => log(`[Audio] Erro ignorado: ${e.message}`));
      }

      return result;
    } else {
      log(`[Pipeline] ❌ Falha: ${result?.error || 'unknown'}`);
    }
  } catch (e) {
    log(`[Cycle] ❌ Erro no ciclo: ${e.message}`);
    log(`[Cycle] Stack: ${e.stack?.split('\n')[1] || ''}`);
  }
  return null;
}

// ── Infinite loop ─────────────────────────────────────────────────────────────
async function startLoop() {
  // First: inject trending topics
  log('[Start] Injetando tópicos trending iniciais...');
  try {
    const { runInjection } = require('./scripts/trendingInjector');
    await runInjection();
    lastTrendFetch = Date.now();
  } catch (e) {
    log(`[Start] Trending injection error: ${e.message}`);
  }

  log('[Start] Iniciando loop infinito...');
  log('[Start] Pressione Ctrl+C para parar\n');

  let errorStreak = 0;

  while (true) {
    try {
      // Sync sales periodicamente (a cada 6h)
      await syncSalesIfNeeded();

      // Afiliados: discovery + landing pages + backlinks (intervalo próprio)
      await runAffiliatesIfNeeded();

      const result = await runCycle();
      if (result) {
        errorStreak = 0;
        // Continuous mode: minimal cooldown between cycles
        log('[Loop] Ciclo completo — próximo em 5s...');
        await sleep(5000);
      } else {
        errorStreak++;
        const backoff = Math.min(errorStreak * 30000, 5 * 60 * 1000); // max 5min
        log(`[Loop] Falha ${errorStreak} — aguardando ${backoff/1000}s...`);
        await sleep(backoff);
      }
    } catch (e) {
      errorStreak++;
      log(`[Loop] ❌ ERRO FATAL NO CICLO: ${e.message}`);
      log(`[Loop] Aguardando 60s antes de tentar novamente...`);
      await sleep(60000);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
startLoop().catch(e => {
  log(`[FATAL] ${e.message}\n${e.stack}`);
  process.exit(1);
});
