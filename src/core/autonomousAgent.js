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
  if (mins === 0) return 0; // modo continuo: sem pausa entre ciclos
  return Math.max(5, mins) * 60 * 1000; // mínimo 5 minutos
}

function shouldPublishTo(platform) {
  const envKey = `AUTO_PUBLISH_${platform.toUpperCase()}`;
  // Se explicitamente desativado, não publica
  if (process.env[envKey] === 'false') return false;
  // Se explicitamente ativado, publica (ensureSession cuida da renovação)
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

// --- Publica ebooks que ja estao prontos (status=ready) antes de gerar novos ---
async function publishReadyEbooks() {
  const db = require('./database');
  const { getDb } = db;
  const rawDb = getDb();
  const readyEbooks = rawDb.prepare("SELECT * FROM ebooks WHERE status='ready' ORDER BY rowid ASC LIMIT 5").all();
  if (readyEbooks.length === 0) return 0;

  logger.info('[publish-ready] ' + readyEbooks.length + ' ebooks prontos — publicando antes de gerar novos');
  const { ensureSession } = require('../agents/sessionAgent');
  const { updateEbookStatus } = db;

  let published = 0;
  for (const ebook of readyEbooks) {
    logger.info('[publish-ready] => ' + ebook.title.slice(0, 50));
    // Mark in_progress immediately to prevent duplicate runs from race conditions
    updateEbookStatus(ebook.id, 'in_progress', {});
    // Hot-reload publishers per ebook so injected files take effect immediately
    ['../agents/publisherHotmart','../agents/publisherCakto','../agents/publisherAmazon'].forEach(m => {
      try { delete require.cache[require.resolve(m)]; } catch {}
    });
    const { publishToHotmart } = require('../agents/publisherHotmart');
    const { publishToCakto } = require('../agents/publisherCakto');
    const { publishToAmazon } = require('../agents/publisherAmazon');
    const ebookData = {
      id: ebook.id, title: ebook.title, subtitle: ebook.subtitle || '',
      description: ebook.description || '', price: ebook.price || 4.99,
      pdfPath: ebook.pdf_path, coverPath: ebook.cover_path,
      // Include existing platform URLs so publishers can cross-reference
      hotmartUrl: ebook.hotmart_url || null,
      hotmartProductId: ebook.hotmart_product_id || null,
      caktoUrl: ebook.cakto_url || null,
      caktoProductId: ebook.cakto_product_id || null,
      amazonUrl: ebook.amazon_url || null,
      amazonAsin: ebook.amazon_asin || null,
    };
    const results = {};
    // Skip platforms where a valid product URL already exists (avoid duplicates)
    const alreadyOnHotmart = ebook.hotmart_url && ebook.hotmart_url.includes('hotmart.com/product/');
    const alreadyOnCakto   = ebook.cakto_url   && ebook.cakto_url.includes('pay.cakto.com.br/');
    const alreadyOnAmazon  = ebook.amazon_url   && ebook.amazon_url.includes('amazon.com.br/');
    try {
      if (alreadyOnHotmart) {
        results.hotmart = { success: true, url: ebook.hotmart_url, skipped: true };
        logger.info('[publish-ready] Hotmart já publicado: ' + ebook.hotmart_url);
      } else if (shouldPublishTo('HOTMART') && await ensureSession('hotmart')) {
        setState({ currentStep: 'publishing:hotmart' });
        results.hotmart = await publishToHotmart(ebookData);
        if (results.hotmart?.success) logger.info('[publish-ready] Hotmart OK: ' + (results.hotmart.url || results.hotmart.productId));
        else logger.warn('[publish-ready] Hotmart falhou: ' + (results.hotmart?.error || 'desconhecido'));
      }
      await new Promise(r => setTimeout(r, 3000));
      if (alreadyOnCakto) {
        results.cakto = { success: true, url: ebook.cakto_url, skipped: true };
        logger.info('[publish-ready] Cakto já publicado: ' + ebook.cakto_url);
      } else if (shouldPublishTo('CAKTO') && await ensureSession('cakto')) {
        setState({ currentStep: 'publishing:cakto' });
        results.cakto = await publishToCakto(ebookData);
        if (results.cakto?.success) logger.info('[publish-ready] Cakto OK: ' + (results.cakto.url || ''));
        else logger.warn('[publish-ready] Cakto falhou: ' + (results.cakto?.error || 'desconhecido'));
      }
      await new Promise(r => setTimeout(r, 3000));
      if (alreadyOnAmazon) {
        results.amazon = { success: true, url: ebook.amazon_url, skipped: true };
        logger.info('[publish-ready] Amazon já publicado: ' + ebook.amazon_url);
      } else if (shouldPublishTo('AMAZON') && await ensureSession('amazon')) {
        setState({ currentStep: 'publishing:amazon' });
        results.amazon = await publishToAmazon(ebookData);
        if (results.amazon?.success) logger.info('[publish-ready] Amazon OK: ' + (results.amazon.url || ''));
        else logger.warn('[publish-ready] Amazon falhou: ' + (results.amazon?.error || 'desconhecido'));
      }
    } catch (e) {
      logger.error('[publish-ready] Erro: ' + e.message.slice(0, 100));
    }
    const anyOk = Object.values(results).some(r => r?.success);
    // Preserve existing URLs — only pass non-null values to avoid overwriting valid data
    const statusUpdate = {};
    if (results.hotmart?.url) statusUpdate.hotmartUrl = results.hotmart.url;
    if (results.hotmart?.hotmartProductId || results.hotmart?.productId)
      statusUpdate.hotmartProductId = results.hotmart.hotmartProductId || results.hotmart.productId;
    if (results.cakto?.url) statusUpdate.caktoUrl = results.cakto.url;
    if (results.cakto?.caktoProductId || results.cakto?.productId)
      statusUpdate.caktoProductId = results.cakto.caktoProductId || results.cakto.productId;
    if (results.amazon?.asin) statusUpdate.amazonAsin = results.amazon.asin;
    if (results.amazon?.url) statusUpdate.amazonUrl = results.amazon.url;
    updateEbookStatus(ebook.id, anyOk ? 'published' : 'ready', statusUpdate);
    if (anyOk) published++;
    await new Promise(r => setTimeout(r, 5000));
  }
  logger.info('[publish-ready] Concluido: ' + published + '/' + readyEbooks.length + ' publicados');
  return published;
}

// ─── Um ciclo completo de geração + publicação ───────────────────────────────
async function runOneCycle(topicOverride = null) {
  // Hot-reload generation agents so patched files take effect immediately
  ['../index','../agents/pdfAgent','../agents/coverAgent','../agents/imageGenAgent',
   '../agents/writerAgent','../agents/claudeDesignAgent'].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch {}
  });
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

  const { ensureSession } = require('../agents/sessionAgent');
  // Hot-reload publishers (always use latest file on disk)
  ['../agents/publisherHotmart','../agents/publisherCakto','../agents/publisherAmazon'].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch {}
  });

  // HOTMART first so we have the real product URL for Cakto's salesPage
  if (shouldPublishTo('HOTMART')) {
    setState({ currentStep: 'publishing:hotmart' });
    try {
      await ensureSession('hotmart'); // renova cookies se necessário
      const { publishToHotmart } = require('../agents/publisherHotmart');
      publishResults.hotmart = await publishToHotmart(ebookData);
      if (publishResults.hotmart?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Hotmart: ${publishResults.hotmart.url}`);
        // Pass the real Hotmart URL to ebookData so Cakto can use it as salesPage
        if (publishResults.hotmart.url) ebookData.hotmartUrl = publishResults.hotmart.url;
      }
    } catch (e) { logger.warn(`⚠️  Hotmart: ${e.message}`); }
  }

  if (shouldPublishTo('CAKTO')) {
    setState({ currentStep: 'publishing:cakto' });
    try {
      await ensureSession('cakto');   // renova cookies se necessário
      const { publishToCakto } = require('../agents/publisherCakto');
      publishResults.cakto = await publishToCakto(ebookData);
      if (publishResults.cakto?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Cakto: ${publishResults.cakto.url}`);
      }
    } catch (e) { logger.warn(`⚠️  Cakto: ${e.message}`); }
  }

  if (shouldPublishTo('AMAZON')) {
    setState({ currentStep: 'publishing:amazon' });
    try {
      await ensureSession('amazon');  // renova cookies se necessário
      const { publishToAmazon } = require('../agents/publisherAmazon');
      publishResults.amazon = await publishToAmazon(ebookData);
      if (publishResults.amazon?.success) {
        setState({ totalPublished: state.totalPublished + 1 });
        logger.info(`✅ Publicado no Amazon KDP: ${publishResults.amazon.url}`);
      }
    } catch (e) { logger.warn(`⚠️  Amazon KDP: ${e.message}`); }
  }

  // Atualizar status no DB — usar os campos corretos de cada publisher
  const anyPublished = Object.values(publishResults).some(r => r?.success);
  try {
    db.updateEbookStatus(result.ebookId, anyPublished ? 'published' : 'ready', {
      caktoUrl:        publishResults.cakto?.url,
      caktoProductId:  publishResults.cakto?.caktoProductId || publishResults.cakto?.productId || null,
      hotmartUrl:      publishResults.hotmart?.url,
      hotmartProductId: publishResults.hotmart?.hotmartProductId || publishResults.hotmart?.productId || null,
      amazonUrl:       publishResults.amazon?.url,
      amazonAsin:      publishResults.amazon?.asin || null,
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
    // Publicar ebooks ready — drena TODA a fila antes de gerar novos
    // (sem pausa entre batches: 5 a 5 até zerar)
    let readyPublished = 0;
    do {
      readyPublished = await publishReadyEbooks().catch(e => {
        logger.error('publishReady erro: ' + e.message);
        return 0;
      });
    } while (readyPublished > 0 && state.enabled);

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
      logger.error('Ciclo falhou: ' + err.message);
      setState({ lastError: err.message, currentStep: 'error' });
      // Backoff adaptativo por tipo de erro
      if (err.message && err.message.startsWith('PAID_PROVIDER_RECOVERED:')) {
        // Provider pago voltou -- reiniciar imediatamente
        logger.info('Provider pago recuperado -- reiniciando em 5s...');
        await sleep(5000);
      } else if (getIntervalMs() === 0) {
        // Modo continuo: backoff curto (30s)
        await sleep(30000);
      } else {
        // Modo intervalo: backoff 5 min
        await sleep(5 * 60 * 1000);
      }
    }

    // Pausa mínima entre ciclos (cooldown de 5s para logs drenarem)
    // Se ainda há ebooks prontos (gerados durante o ciclo), pula a pausa longa
    const { getDb } = require('./database');
    const pendingReady = getDb().prepare("SELECT COUNT(*) as n FROM ebooks WHERE status='ready'").get().n;
    if (pendingReady > 0) {
      // Volta imediatamente ao topo para publicar os ebooks prontos
      logger.info(`📚 ${pendingReady} ebooks prontos — publicando sem pausa...`);
      await sleep(3000);
      continue;
    }
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
