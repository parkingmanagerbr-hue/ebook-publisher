/**
 * GENIA EbookPublisher — Orquestrador Principal
 * Pipeline: Pesquisa → Escrita → Capa → PDF → Publicação → Aprendizado
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
const { runLearningCycle } = require('./agents/learningAgent');
const { generateAudiobook, isAvailable: audiobookAvailable } = require('./agents/audiobookAgent');
const db = require('./core/database');

const logger = createLogger('orchestrator');

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

    // ===== 2. ESCREVER E-BOOK =====
    logger.info(`\n📝 ETAPA 1: Gerando conteúdo do e-book [idioma=${lang}]...`);
    const ebook = await generateFullEbook(topic.topic, lang);
    logger.info(`✅ Conteúdo gerado: "${ebook.title}" (${ebook.wordCount} palavras) [${lang}]`);

    // ===== 3. GERAR CAPA =====
    logger.info('\n🎨 ETAPA 2: Gerando capa...');
    const coverPath = await generateCover(ebook.title, ebook.subtitle, topic.topic);
    logger.info(`✅ Capa gerada: ${coverPath}`);

    // ===== 4. GERAR PDF =====
    logger.info('\n📄 ETAPA 3: Gerando PDF...');
    const ebookData = { ...ebook, id: ebookId, coverPath, price: 4.99 };
    const pdfPath = await generatePDF(ebookData, coverPath);
    logger.info(`✅ PDF gerado: ${pdfPath}`);

    // Salvar no banco
    db.saveEbook({
      ...ebookData,
      id: ebookId,
      pdfPath,
      aiProvider: ebook.provider,
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
    if (process.env.AUTO_PUBLISH !== 'false') {
      logger.info('\n🚀 ETAPA 4: Publicando nas plataformas...');

      const publishData = { ...ebookData, pdfPath, coverPath };
      const results = {};

      // Cakto
      if (process.env.AUTO_PUBLISH_CAKTO !== 'false' &&
          (process.env.AUTO_PUBLISH_CAKTO === 'true' || (process.env.CAKTO_EMAIL && process.env.CAKTO_PASSWORD))) {
        logger.info('Publicando no Cakto...');
        const caktoResult = await publishToCakto(publishData);
        results.cakto = caktoResult;
        if (caktoResult.success) logger.info(`✅ Cakto: ${caktoResult.url}`);
        else logger.warn(`⚠️ Cakto falhou: ${caktoResult.error}`);
      } else {
        logger.warn('⚠️ Cakto pulado (AUTO_PUBLISH_CAKTO não ativado)');
      }

      // Hotmart
      if (process.env.AUTO_PUBLISH_HOTMART !== 'false' &&
          (process.env.AUTO_PUBLISH_HOTMART === 'true' || (process.env.HOTMART_EMAIL && process.env.HOTMART_PASSWORD))) {
        logger.info('Publicando na Hotmart...');
        const hotmartResult = await publishToHotmart(publishData);
        results.hotmart = hotmartResult;
        if (hotmartResult.success) logger.info(`✅ Hotmart: ${hotmartResult.url}`);
        else logger.warn(`⚠️ Hotmart falhou: ${hotmartResult.error}`);
      } else {
        logger.warn('⚠️ Hotmart pulado (AUTO_PUBLISH_HOTMART não ativado)');
      }

      // Atualizar status
      const published = results.cakto?.success || results.hotmart?.success;
      db.updateEbookStatus(ebookId, published ? 'published' : 'ready', {
        caktoUrl: results.cakto?.url,
        hotmartUrl: results.hotmart?.url,
        hotmartProductId: results.hotmart?.hotmartProductId || results.hotmart?.productId || null,
        caktoProductId: results.cakto?.caktoProductId || results.cakto?.productId || null,
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

    return { success: true, ebookId, title: ebook.title, pdfPath, coverPath };

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
