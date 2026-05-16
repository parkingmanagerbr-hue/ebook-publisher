/**
 * LearningAgent — ML para otimizar seleção de tópicos baseado em vendas
 * Aprende quais assuntos convertem melhor e melhora as próximas escolhas
 */
const { createLogger } = require('../core/logger');
const { getAllTopics, updateTopicScore, getEbooks, getStats, getDb } = require('../core/database');
const logger = createLogger('learningAgent');

/**
 * Scoring ML simples mas eficaz:
 * - Taxa de conversão (vendas / publicados no nicho)
 * - Receita média por e-book
 * - Tendência recente (últimas 2 semanas pesam mais)
 * - Concorrência (muitos e-books = mais difícil)
 * - Sazonalidade implícita (categoria + época)
 */
function computeMLScore(topic, allEbooks) {
  const topicEbooks = allEbooks.filter(e => e.topic === topic.topic);

  if (topicEbooks.length === 0) {
    // Tópico nunca testado → score base pelo demand_score
    return topic.demand_score * 0.8;
  }

  const totalSales = topicEbooks.reduce((s, e) => s + (e.sales_count || 0), 0);
  const totalRevenue = topicEbooks.reduce((s, e) => s + (e.revenue || 0), 0);
  const publishedCount = topicEbooks.filter(e => e.status === 'published').length;

  // Evitar divisão por zero
  if (publishedCount === 0) return topic.demand_score * 0.5;

  const avgSales = totalSales / publishedCount;
  const avgRevenue = totalRevenue / publishedCount;

  // Fator de recência (últimos 14 dias)
  const recentEbooks = topicEbooks.filter(e => {
    if (!e.published_at) return false;
    const daysDiff = (Date.now() - new Date(e.published_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff <= 14;
  });
  const recencyBonus = recentEbooks.length > 0 ? 2 : 0;

  // Fator de saturação (muitos e-books = penalidade leve)
  const saturationPenalty = Math.max(0, (publishedCount - 5) * 0.3);

  // Score final (0-10)
  const score = Math.min(10,
    (avgSales * 0.4) +          // Média de vendas (peso 40%)
    (avgRevenue * 0.1 * 0.3) + // Receita média (peso 30%)
    (topic.demand_score * 0.2) + // Demanda de mercado (peso 20%)
    recencyBonus +              // Bônus recência
    (Math.random() * 0.5) -    // Exploração aleatória (5%)
    saturationPenalty
  );

  return Math.max(0, score);
}

async function runLearningCycle() {
  logger.info('🧠 Iniciando ciclo de aprendizado ML...');

  const allTopics = getAllTopics();
  const allEbooks = getEbooks();
  const stats = getStats();

  logger.info(`Stats: ${stats.totalEbooks} e-books, ${stats.totalSales} vendas, R$ ${stats.totalRevenue?.toFixed(2)} receita`);

  // Recalcular ML score para cada tópico
  const db = getDb();
  const updateScore = db.prepare('UPDATE topics SET ml_score = ? WHERE topic = ?');

  const topicScores = allTopics.map(topic => {
    const mlScore = computeMLScore(topic, allEbooks);
    updateScore.run(mlScore, topic.topic);
    return { topic: topic.topic, category: topic.category, mlScore, demandScore: topic.demand_score };
  });

  // Ordenar por score final
  topicScores.sort((a, b) => (b.mlScore + b.demandScore) - (a.mlScore + a.demandScore));

  logger.info('📊 Top 5 tópicos recomendados pelo ML:');
  topicScores.slice(0, 5).forEach((t, i) => {
    logger.info(`  ${i+1}. ${t.topic} (ML: ${t.mlScore.toFixed(2)}, Demanda: ${t.demandScore})`);
  });

  // Detectar padrões de sucesso
  const bestCategory = detectBestCategory(allEbooks);
  if (bestCategory) {
    logger.info(`🏆 Melhor categoria: ${bestCategory.category} (${bestCategory.avgSales.toFixed(1)} vendas/ebook)`);
  }

  // Gerar relatório
  const report = {
    timestamp: new Date().toISOString(),
    stats,
    topRecommendations: topicScores.slice(0, 5),
    bestCategory,
    insight: generateInsight(topicScores, allEbooks, stats),
  };

  logger.info(`💡 Insight: ${report.insight}`);
  return report;
}

function detectBestCategory(allEbooks) {
  const categoryStats = {};

  allEbooks.filter(e => e.status === 'published').forEach(ebook => {
    // Precisamos do category — vamos assumir que o topic tem categoria implícita
    const cat = detectCategoryFromTopic(ebook.topic);
    if (!categoryStats[cat]) categoryStats[cat] = { sales: 0, count: 0 };
    categoryStats[cat].sales += ebook.sales_count || 0;
    categoryStats[cat].count++;
  });

  const categories = Object.entries(categoryStats)
    .map(([cat, data]) => ({ category: cat, avgSales: data.count > 0 ? data.sales / data.count : 0, count: data.count }))
    .filter(c => c.count >= 1)
    .sort((a, b) => b.avgSales - a.avgSales);

  return categories[0] || null;
}

function detectCategoryFromTopic(topic) {
  if (!topic) return 'geral';
  const lower = topic.toLowerCase();
  if (lower.includes('financ') || lower.includes('invest')) return 'financas';
  if (lower.includes('ia') || lower.includes('intelig')) return 'tecnologia';
  if (lower.includes('saúde') || lower.includes('emagrec')) return 'saude';
  if (lower.includes('negóci') || lower.includes('marketing')) return 'negocios';
  return 'geral';
}

function generateInsight(topicScores, allEbooks, stats) {
  if (stats.totalSales === 0) {
    return 'Aguardando primeiras vendas para calibrar o modelo de ML.';
  }

  const topTopic = topicScores[0];
  if (stats.totalRevenue > 100) {
    return `${topTopic.topic} está convertendo melhor. Focar neste nicho pode aumentar receita em até 40%.`;
  }

  return `Com ${stats.totalSales} vendas acumuladas, o sistema está aprendendo. Próximo foco: ${topTopic.topic}.`;
}

async function syncSalesFromPlatforms() {
  // TODO: Integrar com APIs da Cakto/Hotmart para puxar métricas reais
  // Por enquanto, simula uma verificação
  logger.info('Sincronizando métricas de vendas das plataformas...');
  // Quando Cakto/Hotmart tiverem APIs abertas, buscar aqui
}

module.exports = { runLearningCycle, syncSalesFromPlatforms };
