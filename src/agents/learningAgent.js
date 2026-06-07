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

// ─── Sincronização real de vendas via APIs das plataformas ──────────────────

async function fetchCaktoSales(cookieStr) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.cakto.com.br/api/sales/?limit=200&ordering=-created_at',
      {
        headers: {
          Cookie: cookieStr,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchHotmartSales(jwt) {
  if (!jwt) return null;
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(
      'https://api-sec-vlc.hotmart.com/payment/api/v1/sales/history?page=0&max=200',
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function syncSalesFromPlatforms() {
  logger.info('🔄 Sincronizando métricas de vendas das plataformas...');
  const fs   = require('fs');
  const path = require('path');
  const db   = getDb();

  let syncedCakto = 0, syncedHotmart = 0;

  // ── Cakto ──────────────────────────────────────────────────────────────────
  try {
    const SESS_DIR  = process.env.SESSIONS_DIR ||
      (fs.existsSync('/app/data') ? '/app/data/sessions' : path.join(__dirname, '../../data/sessions'));
    const caktoFile = path.join(SESS_DIR, 'cakto.json');
    if (fs.existsSync(caktoFile)) {
      const session   = JSON.parse(fs.readFileSync(caktoFile, 'utf8'));
      const cookieStr = (session.cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
      const data      = await fetchCaktoSales(cookieStr);

      if (data?.results && Array.isArray(data.results)) {
        // data.results: [{ id, status, total_price, product_name, ... }]
        const approved = data.results.filter(s => s.status === 'approved' || s.status === 'complete');
        // Agrupar por offer/product_name e somar vendas
        const byProduct = {};
        for (const sale of approved) {
          const key = (sale.product_name || sale.offer_name || '').slice(0, 60);
          if (!key) continue;
          if (!byProduct[key]) byProduct[key] = { sales: 0, revenue: 0 };
          byProduct[key].sales++;
          byProduct[key].revenue += parseFloat(sale.producer_net || sale.total_price || 0);
        }

        // Buscar ebook por título (correspondência aproximada)
        const allEbooks = db.prepare('SELECT id, title, cakto_url FROM ebooks WHERE status = ?').all('published');
        for (const [productName, stats] of Object.entries(byProduct)) {
          const ebook = allEbooks.find(e =>
            e.title && (
              e.title.toLowerCase().slice(0, 30) === productName.toLowerCase().slice(0, 30) ||
              productName.toLowerCase().includes(e.title.toLowerCase().slice(0, 20))
            )
          );
          if (!ebook) continue;
          // Só atualiza se os dados mudaram (evita writes desnecessários)
          const current = db.prepare('SELECT sales_count, revenue FROM ebooks WHERE id = ?').get(ebook.id);
          if (current && current.sales_count < stats.sales) {
            db.prepare('UPDATE ebooks SET sales_count = ?, revenue = ? WHERE id = ?')
              .run(stats.sales, stats.revenue, ebook.id);
            syncedCakto++;
          }
        }
        logger.info(`  ✅ Cakto: ${approved.length} vendas aprovadas | ${syncedCakto} ebooks atualizados`);
      }
    }
  } catch (e) {
    logger.warn(`  ⚠️  Cakto sync erro: ${e.message.slice(0, 80)}`);
  }

  // ── Hotmart ────────────────────────────────────────────────────────────────
  try {
    const SESS_DIR     = process.env.SESSIONS_DIR ||
      (fs.existsSync('/app/data') ? '/app/data/sessions' : path.join(__dirname, '../../data/sessions'));
    const hotmartFile  = path.join(SESS_DIR, 'hotmart.json');
    if (fs.existsSync(hotmartFile)) {
      const session = JSON.parse(fs.readFileSync(hotmartFile, 'utf8'));
      const jwt     = session.localStorage?.token;
      if (jwt) {
        const data = await fetchHotmartSales(jwt);
        const items = data?.items || data?.data || [];
        if (items.length > 0) {
          const approved = items.filter(s => s.purchase?.status === 'APPROVED');
          const byProduct = {};
          for (const sale of approved) {
            const name = (sale.product?.name || '').slice(0, 60);
            if (!name) continue;
            if (!byProduct[name]) byProduct[name] = { sales: 0, revenue: 0 };
            byProduct[name].sales++;
            byProduct[name].revenue += parseFloat(sale.purchase?.price?.value || 0);
          }

          const allEbooks = db.prepare('SELECT id, title FROM ebooks WHERE hotmart_product_id IS NOT NULL').all();
          for (const [productName, stats] of Object.entries(byProduct)) {
            const ebook = allEbooks.find(e =>
              e.title && e.title.toLowerCase().slice(0, 30) === productName.toLowerCase().slice(0, 30)
            );
            if (!ebook) continue;
            const current = db.prepare('SELECT sales_count FROM ebooks WHERE id = ?').get(ebook.id);
            if (current && current.sales_count < stats.sales) {
              db.prepare('UPDATE ebooks SET sales_count = ?, revenue = revenue + ? WHERE id = ?')
                .run(stats.sales, stats.revenue, ebook.id);
              syncedHotmart++;
            }
          }
          logger.info(`  ✅ Hotmart: ${approved.length} vendas aprovadas | ${syncedHotmart} ebooks atualizados`);
        }
      }
    }
  } catch (e) {
    logger.warn(`  ⚠️  Hotmart sync erro: ${e.message.slice(0, 80)}`);
  }

  if (syncedCakto + syncedHotmart > 0) {
    logger.info(`📈 Métricas de vendas atualizadas: ${syncedCakto} Cakto + ${syncedHotmart} Hotmart`);
  } else {
    logger.info('   Sem atualizações de vendas neste ciclo.');
  }

  return { syncedCakto, syncedHotmart };
}

module.exports = { runLearningCycle, syncSalesFromPlatforms };
