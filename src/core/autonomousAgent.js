/**
 * autonomousAgent.js — Motor autônomo 24/7 do E-book Caster
 *
 * Roda em loop infinito:
 *   1. Seleciona o tópico mais lucrativo (ML score)
 *   2. Gera o e-book completo (texto + capa + PDF)
 *   3. Publica automaticamente em Cakto, Hotmart e Amazon KDP
 *   4. Dorme pelo intervalo configurado
 *   5. Repete para sempre
 *
 * Env vars:
 *   GENERATE_INTERVAL_MINUTES  — intervalo entre gerações (default: 180 = 3h)
 *   AUTO_PUBLISH_CAKTO         — 'true'/'false' (default: true se credenciais presentes)
 *   AUTO_PUBLISH_HOTMART       — idem
 *   AUTO_PUBLISH_AMAZON        — idem
 *   AGENT_PAUSED               — 'true' para iniciar em modo pausado
 */
const path = require('path');
const { createLogger } = require('./logger');
const logger = createLogger('autonomousAgent');

// ─── Estado global do agente (acessível via /api/agent/status) ───────────────
const state = {
  enabled:       true,
  paused:        process.env.AGENT_PAUSED === 'true',
  currentStep:   null,     // 'selecting' | 'writing' | 'cover' | 'pdf' | 'publishing' | 'sleeping'
  currentTopic:  null,
  currentTitle:  null,
  lastRunAt:     null,
  nextRunAt:     null,
  lastError:     null,
  totalGenerated: 0,
  totalPublished: 0,
  sessionStart:  new Date().toISOString(),
  history:       [],       // últimas 20 gerações
};

let _loopTimer = null;
let _running   = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getIntervalMs() {
  const mins = parseInt(process.env.GENERATE_INTERVAL_MINUTES ?? '0');
  if (mins === 0) return 0; // modo contínuo: sem pausa entre ciclos
  return Math.max(5, mins) * 60 * 1000; // mínimo 5 minutos
}

function shouldPublishTo(platform) {
  const envKey = `AUTO_PUBLISH_${platform.toUpperCase()}`;
  // Se explicitamente desativado, não publica
  if (process.env[envKey] === 'false') return false;
  // Verificar se sessão está degradada (sessionAgent detectou problema)
  try {
    const { isPlatformDegraded } = require('../agents/sessionAgent');
    if (isPlatformDegraded(platform.toLowerCase())) return false;
  } catch {}
  // Se explicitamente ativado, publica (usa sessão salva ou credenciais)
  if (process.env[envKey] === 'true') return true;
  // Fallback: publica se tiver credenciais de email/senha
  const creds = {
    CAKTO:   process.env.CAKTO_EMAIL   && process.env.CAKTO_PASSWORD,
    HOTMART: process.env.HOTMART_EMAIL && process.env.HOTMART_PASSWORD,
    AMAZON:  process.env.KDP_EMAIL     && process.env.KDP_PASSWORD,
  };
  return !!creds[platform.toUpperCase()];
}

function setState(patch) {
  Object.assign(state, patch);
}

function addHistory(entry) {
  state.history.unshift({ ...entry, at: new Date().toISOString() });
  if (state.history.length > 50) state.history.pop();
}

function sleep(ms) {
  return new Promise(resolve => {
    _loopTimer = setTimeout(resolve, ms);
  });
}

// ─── Um ciclo completo de geração + publicação ───────────────────────────────
async function runOneCycle(topicOverride = null) {
  const { runPipeline } = require('../index');
  const db = require('./database');

  // ── Selecionar tópico ──
  setState({ currentStep: 'selecting', currentTopic: topicOverride || null, currentTitle: null });

  let topic = topicOverride;
  if (!topic) {
    const t = db.getNextTopic();
    if (!t) {
      logger.warn('Nenhum tópico disponível — expandindo banco de tópicos...');
      const { expandTopics } = require('../agents/topicExpander');
      await expandTopics();
      const t2 = db.getNextTopic();
      if (!t2) throw new Error('Nenhum tópico disponível mesmo após expansão');
      topic = t2.topic;
    } else {
      topic = t.topic;
    }
  }

  setState({ currentTopic: topic, currentStep: 'writing' });
  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`🚀 NOVO CICLO — Tópico: "${topic}"`);
  logger.info(`${'═'.repeat(60)}`);

  // ── Pipeline de geração ──
  const result = await runPipeline(topic);

  if (!result.success) {
    setState({ lastError: result.error, currentStep: null });
    addHistory({ topic, status: 'error', error: result.error });
    throw new Error(`Pipeline falhou: ${result.error}`);
  }

  setState({ currentTitle: result.title, currentStep: 'publishing', totalGenerated: state.totalGenerated + 1 });
  addHistory({ topic, title: result.title, pdfPath: result.pdfPath, status: 'generated' });

  // ── Publicação automática ──
  const publishResults = {};
  const PDFS_DIR   = path.join(__dirname, '../../data/pdfs');
  const COVERS_DIR = path.join(__dirname, '../../data/covers');

  const ebookData = {
    id:        result.ebookId,
    title:     result.title,
    topic,
    pdfPath:   result.pdfPath,
    coverPath: result.coverPath,
    price:     parseFloat(process.env.EBOOK_PRICE || '4.99'),
    pdfFile:   path.basename(result.pdfPath),
    coverUrl:  result.coverPath ? `/covers/${path.basename(result.coverPath)}` : null,
  };

  if (shouldPublishTo('CAKTO')) {
    setState({ currentStep: 'publishing:cakto' });
    try {
      const { publishToCakto } = require('../agents/publisherCakto');
      publishResults.cakto = await publishToCakto(ebookData);
      if (publishResults.cakto?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Cakto: ${publishResults.cakto.url}`);
      }
    } catch (e) { logger.warn(`⚠️  Cakto: ${e.message}`); }
  }

  if (shouldPublishTo('HOTMART')) {
    setState({ currentStep: 'publishing:hotmart' });
    try {
      const { publishToHotmart } = require('../agents/publisherHotmart');
      publishResults.hotmart = await publishToHotmart(ebookData);
      if (publishResults.hotmart?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Hotmart: ${publishResults.hotmart.url}`);
      }
    } catch (e) { logger.warn(`⚠️  Hotmart: ${e.message}`); }
  }

  if (shouldPublishTo('AMAZON')) {
    setState({ currentStep: 'publishing:amazon' });
    try {
      const { publishToAmazon } = require('../agents/publisherAmazon');
      publishResults.amazon = await publishToAmazon(ebookData);
      if (publishResults.amazon?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Amazon KDP: ${publishResults.amazon.url}`);
      }
    } catch (e) { logger.warn(`⚠️  Amazon KDP: ${e.message}`); }
  }

  // Atualizar status no DB
  const anyPublished = Object.values(publishResults).some(r => r?.success);
  try {
    db.updateEbookStatus(result.ebookId, anyPublished ? 'published' : 'ready', {
      caktoUrl:   publishResults.cakto?.url,
      hotmartUrl: publishResults.hotmart?.url,
      amazonUrl:  publishResults.amazon?.url,
    });
  } catch (_) {}

  setState({ lastError: null, currentStep: null });
  addHistory({
    topic, title: result.title, pdfPath: result.pdfPath, status: 'published',
    platforms: Object.keys(publishResults).filter(k => publishResults[k]?.success),
  });

  logger.info(`✅ CICLO COMPLETO: "${result.title}" — gerados: ${state.totalGenerated}`);
  return result;
}

// ─── Loop infinito ───────────────────────────────────────────────────────────
async function loop() {
  if (_running) return;
  _running = true;

  logger.info('🤖 Agente autônomo iniciado — modo 24/7');
  logger.info(`   Intervalo: ${getIntervalMs() / 60000} minutos entre gerações`);
  logger.info(`   Publicação automática: Cakto=${shouldPublishTo('CAKTO')} | Hotmart=${shouldPublishTo('HOTMART')} | Amazon=${shouldPublishTo('AMAZON')}`);

  // Aguardar 15s antes do primeiro ciclo (servidor terminar de inicializar)
  await sleep(15_000);

  while (state.enabled) {
    if (state.paused) {
      setState({ currentStep: 'paused', nextRunAt: null });
      logger.info('⏸️  Agente pausado — aguardando retomada...');
      await sleep(30_000);
      continue;
    }

    try {
      setState({ lastRunAt: new Date().toISOString(), nextRunAt: null });
      await runOneCycle();
    } catch (err) {
      logger.error(`❌ Ciclo falhou: ${err.message}`);
      setState({ lastError: err.message, currentStep: 'error' });
      // Backoff de 15 minutos em caso de erro
      await sleep(15 * 60 * 1000);
    }

    // Pausa mínima entre ciclos (cooldown de 5s para logs drenarem)
    const intervalMs = getIntervalMs();
    if (intervalMs > 0) {
      const nextRun = new Date(Date.now() + intervalMs).toISOString();
      setState({ currentStep: 'sleeping', nextRunAt: nextRun });
      logger.info(`💤 Próximo e-book: ${new Date(nextRun).toLocaleTimeString('pt-BR')} (em ${intervalMs / 60000} min)`);
      await sleep(intervalMs);
    } else {
      // Modo contínuo: cooldown mínimo de 5s e gera imediatamente
      setState({ currentStep: 'selecting', nextRunAt: null });
      logger.info('⚡ Modo contínuo — iniciando próximo ciclo em 5s...');
      await sleep(5_000);
    }
  }

  _running = false;
}

// ─── API pública ─────────────────────────────────────────────────────────────
function getStatus() {
  return {
    ...state,
    intervalMinutes:    getIntervalMs() / 60000,
    publishTo: {
      cakto:   shouldPublishTo('CAKTO'),
      hotmart: shouldPublishTo('HOTMART'),
      amazon:  shouldPublishTo('AMAZON'),
    },
  };
}

function pause()  { setState({ paused: true  }); logger.info('⏸️  Agente pausado pelo usuário'); }
function resume() { setState({ paused: false }); logger.info('▶️  Agente retomado pelo usuário'); }

function stop() {
  state.enabled = false;
  if (_loopTimer) clearTimeout(_loopTimer);
  logger.info('🛑 Agente parado');
}

function triggerNow(topic = null) {
  // Dispara um ciclo imediatamente sem esperar o timer
  if (_loopTimer) { clearTimeout(_loopTimer); _loopTimer = null; }
  logger.info(`⚡ Ciclo forçado pelo usuário${topic ? `: "${topic}"` : ''}`);
  runOneCycle(topic).catch(e => logger.error('Ciclo forçado falhou:', e.message));
}

module.exports = { loop, getStatus, pause, resume, stop, triggerNow };
