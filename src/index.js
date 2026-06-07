/**
 * GENIA EbookPublisher — Orquestrador Principal
 * Pipeline: Pesquisa → Escrita → Capa → PDF → Publicação → Aprendizado
 *
 * Prioridade de geração de conteúdo:
 *   1. Serviços web gratuitos (Gamma → Piktochart → ebookmaker.ai → Visme)
 *      Usa contas Google do Chrome. 168 ebooks/mês gratuitos.
 *   2. Pipeline normal (writerAgent LLM + pdfAgent)
 *      Ilimitado via Gemini/Cerebras/SambaNova.
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { createLogger } = require('./core/logger');
const { generateFullEbook } = require('./agents/writerAgent');
const { generateCover } = require('./agents/coverAgent');
const { generatePDF } = require('./agents/pdfAgent');
const { publishToCakto } = require('./agents/publisherCakto');
const { publishToHotmart } = require('./agents/publisherHotmart');
const { publishToAmazon } = require('./agents/publisherAmazon');
const { runLearningCycle } = require('./agents/learningAgent');
const { generateAudiobook, isAvailable: audiobookAvailable } = require('./agents/audiobookAgent');
const db = require('./core/database');

// Web Ebook Agents (Gamma, Piktochart, ebookmaker.ai, Visme)
let webEbookAgents = null;
try {
  webEbookAgents = require('./agents/webEbookAgents');
} catch (e) {
  // Não fatal — usa pipeline normal se módulo não estiver disponível
}

const logger = createLogger('orchestrator');

// ── Cron mensal: reset de créditos dos serviços web no dia 1 de cada mês ──────
if (webEbookAgents) {
  cron.schedule('0 0 1 * *', () => {
    logger.info('🔄 [cron] Reset mensal de créditos web ebook');
    try { webEbookAgents.resetMonthlyCredits(); }
    catch (e) { logger.warn('Reset mensal falhou: ' + e.message); }
  });
}

// =============================================
// PIPELINE COMPLETO
// =============================================
async function runPipeline(topicOverride = null, language = null) {
  logger.info('\n' + '='.repeat(60));
  logger.info('🚀 GENIA EbookPublisher — Iniciando pipeline');
  logger.info('='.repeat(60));

  const ebookId = uuidv4();
  const lang = language || process.env.EBOOK_LANGUAGE || 'pt-BR';

  try {
    // ===== 1. SELECIONAR TÓPICO =====
    let topic;
    if (topicOverride) {
      topic = { topic: topicOverride };
      logger.info(`📌 Tópico definido manualmente: ${topicOverride}`);
    } else {
      topic = db.getNextTopic();
      if (!topic) throw new Error('Nenhum tópico disponível no banco');
      logger.info(`📊 Tópico selecionado (ML score: ${topic.ml_score?.toFixed(2)}): ${topic.topic}`);
    }

    db.markTopicUsed(topic.topic);

    // ===== 2. TENTAR SERVIÇOS WEB GRATUITOS PRIMEIRO =====
    let ebook, pdfPath, coverPath;
    let webResult = null;

    const useWebFirst = process.env.WEB_EBOOK_FIRST !== 'false' && webEbookAgents;
    if (useWebFirst) {
      try {
        logger.info(`\n🌐 ETAPA 1: Tentando serviços web gratuitos (Gamma/Piktochart/ebookmaker/Visme)...`);
        const credits = webEbookAgents.getCreditsSummary();
        logger.info(`   Créditos restantes: ${Object.entries(credits.services).map(([s,i]) => `${s}:${i.remaining}`).join(' | ')}`);

        webResult = await webEbookAgents.tryWebEbookGeneration({ topic: topic.topic, language: lang });

        if (webResult) {
          logger.info(`✅ Web gerado via ${webResult.source} (${webResult.email}): ${webResult.pdfPath}`);
          // Construir objeto ebook compatível com o resto do pipeline
          ebook = {
            id:          ebookId,
            title:       webResult.title,
            subtitle:    '',
            description: webResult.description || `Ebook sobre ${topic.topic}`,
            topic:       topic.topic,
            chapters:    [],
            wordCount:   0,
            provider:    webResult.source,
            language:    lang,
          };
          pdfPath = webResult.pdfPath;
          // Gerar capa normal para ter uma imagem de capa pro Hotmart/KDP
          logger.info('\n🎨 Gerando capa para o ebook web...');
          coverPath = await generateCover(ebook.title, ebook.subtitle, topic.topic).catch(() => null);
        }
      } catch (webErr) {
        logger.warn(`⚠️  Serviços web falharam: ${webErr.message.slice(0, 100)} — usando pipeline normal`);
      }
    }

    // ===== 2b. PIPELINE NORMAL (fallback ou sempre, se WEB_EBOOK_FIRST=false) =====
    if (!webResult) {
      logger.info(`\n📝 ETAPA 1: Gerando conteúdo do e-book [idioma=${lang}]...`);
      ebook = await generateFullEbook(topic.topic, lang);
      logger.info(`✅ Conteúdo gerado: "${ebook.title}" (${ebook.wordCount} palavras) [${lang}]`);

      // ===== 3. GERAR CAPA =====
      logger.info('\n🎨 ETAPA 2: Gerando capa...');
      coverPath = await generateCover(ebook.title, ebook.subtitle, topic.topic);
      logger.info(`✅ Capa gerada: ${coverPath}`);

      // ===== 4. GERAR PDF =====
      logger.info('\n📄 ETAPA 3: Gerando PDF...');
      const ebookDataForPdf = { ...ebook, id: ebookId, coverPath, price: parseFloat(process.env.EBOOK_PRICE || '4.99') };
      pdfPath = await generatePDF(ebookDataForPdf, coverPath);
      logger.info(`✅ PDF gerado: ${pdfPath}`);
    } else {
      logger.info(`\n📄 PDF web já disponível: ${pdfPath}`);
    }

    // ── Objeto unificado para o resto do pipeline ──────────────────────────────
    const ebookData = { ...ebook, id: ebookId, coverPath, price: parseFloat(process.env.EBOOK_PRICE || '4.99') };

    // Salvar no banco
    db.saveEbook({
      ...ebookData,
      id: ebookId,
      pdfPath,
      aiProvider: ebook.provider || 'web',
      status: 'ready'
    });

    // ===== 4.5 AUDIOBOOK =====
    let audiobookPath = null;
    if (audiobookAvailable()) {
      logger.info('\n🎙️ ETAPA 4.5: Gerando audiobook...');
      try {
        audiobookPath = await generateAudiobook(ebook, ebookId);
        if (audiobookPath) logger.info(`✅ Audiobook gerado: ${audiobookPath}`);
      } catch (err) {
        logger.warn(`⚠️ Audiobook falhou (não crítico): ${err.message}`);
      }
    }

    // ===== 5. PUBLICAR =====
    let results = {};
    if (process.env.AUTO_PUBLISH !== 'false') {
      logger.info('\n🚀 ETAPA 4: Publicando nas plataformas...');

      const publishData = { ...ebookData, pdfPath, coverPath };

      // Cakto — isolado: exceção não mata o pipeline
      if (process.env.AUTO_PUBLISH_CAKTO !== 'false' &&
          (process.env.AUTO_PUBLISH_CAKTO === 'true' || (process.env.CAKTO_EMAIL && process.env.CAKTO_PASSWORD))) {
        logger.info('Publicando no Cakto...');
        try {
          const caktoResult = await publishToCakto(publishData);
          results.cakto = caktoResult;
          if (caktoResult.success) logger.info(`✅ Cakto: ${caktoResult.url}`);
          else logger.warn(`⚠️ Cakto falhou: ${caktoResult.error}`);
        } catch (caktoErr) {
          logger.warn(`⚠️ Cakto erro (não fatal): ${caktoErr.message.slice(0, 120)}`);
          results.cakto = { success: false, error: caktoErr.message };
        }
      } else {
        logger.warn('⚠️ Cakto pulado (AUTO_PUBLISH_CAKTO não ativado)');
      }

      // Hotmart — isolado: exceção não mata o pipeline
      if (process.env.AUTO_PUBLISH_HOTMART !== 'false' &&
          (process.env.AUTO_PUBLISH_HOTMART === 'true' || (process.env.HOTMART_EMAIL && process.env.HOTMART_PASSWORD))) {
        logger.info('Publicando na Hotmart...');
        try {
          const hotmartResult = await publishToHotmart(publishData);
          results.hotmart = hotmartResult;
          if (hotmartResult.success) logger.info(`✅ Hotmart: ${hotmartResult.url}`);
          else logger.warn(`⚠️ Hotmart falhou: ${hotmartResult.error}`);
        } catch (hotmartErr) {
          logger.warn(`⚠️ Hotmart erro (não fatal): ${hotmartErr.message.slice(0, 120)}`);
          results.hotmart = { success: false, error: hotmartErr.message };
        }
      } else {
        logger.warn('⚠️ Hotmart pulado (AUTO_PUBLISH_HOTMART não ativado)');
      }

      // Amazon KDP — isolado: exceção não mata o pipeline
      if (process.env.AUTO_PUBLISH_AMAZON !== 'false' &&
          (process.env.AUTO_PUBLISH_AMAZON === 'true' || (process.env.KDP_EMAIL && process.env.KDP_PASSWORD))) {
        logger.info('Publicando na Amazon KDP...');
        try {
          const amazonResult = await publishToAmazon(publishData);
          results.amazon = amazonResult;
          if (amazonResult?.success) logger.info(`✅ Amazon KDP: ${amazonResult.url || amazonResult.asin || 'OK'}`);
          else logger.warn(`⚠️ Amazon KDP falhou: ${amazonResult?.error || 'desconhecido'}`);
        } catch (amazonErr) {
          logger.warn(`⚠️ Amazon KDP erro (não fatal): ${amazonErr.message.slice(0, 120)}`);
          results.amazon = { success: false, error: amazonErr.message };
        }
      } else {
        logger.warn('⚠️ Amazon KDP pulado (AUTO_PUBLISH_AMAZON não ativado)');
      }

      // Atualizar status
      const published = results.cakto?.success || results.hotmart?.success || results.amazon?.success;
      db.updateEbookStatus(ebookId, published ? 'published' : 'ready', {
        caktoUrl: results.cakto?.url,
        hotmartUrl: results.hotmart?.url,
        hotmartProductId: results.hotmart?.hotmartProductId || results.hotmart?.productId || null,
        caktoProductId: results.cakto?.caktoProductId || results.cakto?.productId || null,
        amazonUrl: results.amazon?.url || null,
        amazonAsin: results.amazon?.asin || null,
      });

    } else {
      logger.info('⏸️ Auto-publish desativado. PDF e capa gerados mas não publicados.');
      db.updateEbookStatus(ebookId, 'ready');
    }

    // ===== 6. APRENDIZADO =====
    logger.info('\n🧠 ETAPA 5: Rodando ciclo de aprendizado ML...');
    await runLearningCycle();

    // ===== RESUMO =====
    logger.info('\n' + '='.repeat(60));
    logger.info('✅ PIPELINE CONCLUÍDO!');
    logger.info(`   📚 E-book: "${ebook.title}"`);
    logger.info(`   📄 PDF: ${pdfPath}`);
    logger.info(`   🖼️  Capa: ${coverPath}`);
    logger.info(`   🎙️  Audiobook: ${audiobookPath || 'não gerado'}`);
    logger.info(`   💰 Preço: R$ 4,99`);
    logger.info('='.repeat(60));

    return { success: true, ebookId, title: ebook.title, pdfPath, coverPath, publishResults: results };

  } catch (err) {
    logger.error(`❌ Pipeline falhou: ${err.message}`);
    logger.error(err.stack);
    db.updateEbookStatus(ebookId, 'error');
    return { success: false, error: err.message };
  }
}

// =============================================
// MODO EXEMPLO (sem publicação)
// =============================================
async function runExample() {
  logger.info('🎯 Modo EXEMPLO: Gerando e-book sobre o tópico #1 mais buscado');
  process.env.AUTO_PUBLISH = 'false'; // Não publicar no modo exemplo
  return runPipeline('Educação financeira e saída das dívidas');
}

// =============================================
// AGENDAMENTO AUTOMÁTICO
// =============================================
function startScheduler() {
  const intervalHours = parseInt(process.env.PUBLISH_INTERVAL_HOURS || '6');
  const cronExpression = `0 */${intervalHours} * * *`;

  logger.info(`📅 Agendando criação de e-books a cada ${intervalHours} horas`);
  cron.schedule(cronExpression, async () => {
    logger.info('⏰ Cron ativado — iniciando novo e-book');
    await runPipeline();
  });

  // Aprendizado ML a cada hora
  cron.schedule('0 * * * *', async () => {
    logger.info('🧠 Cron ML — sincronizando métricas');
    await runLearningCycle();
  });

  logger.info('✅ Scheduler ativo. Pressione Ctrl+C para parar.');
}

// =============================================
// ENTRY POINT
// =============================================
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--example')) {
    await runExample();
  } else if (args.includes('--only=research')) {
    logger.info('Modo pesquisa apenas');
    // Apenas mostrar tópicos ordenados
    const topics = db.getAllTopics();
    logger.info('Top 10 tópicos:');
    topics.slice(0, 10).forEach((t, i) => logger.info(`  ${i+1}. ${t.topic} (${t.demand_score})`));
  } else if (args.includes('--topic')) {
    const topicIdx = args.indexOf('--topic');
    const topicArg = args[topicIdx + 1];
    await runPipeline(topicArg);
  } else {
    // Modo normal: pipeline + scheduler
    await runPipeline(); // Rodar imediatamente uma vez
    startScheduler();    // Depois agendar
  }
}

// Só executa main() quando rodado diretamente (node src/index.js)
// Quando imported como módulo (require('../index')), apenas exporta funções
if (require.main === module) {
  main().catch(err => {
    logger.error('Erro fatal:', err);
    process.exit(1);
  });
}

module.exports = { runPipeline, runExample };
