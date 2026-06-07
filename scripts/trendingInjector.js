'use strict';
/**
 * trendingInjector.js — Busca assuntos mais procurados e injeta no banco de tópicos
 *
 * Fontes:
 *   1. Google Trends Daily Trends (Brasil)
 *   2. Google Trends Realtime (Saúde, Negócios, Tecnologia)
 *   3. Lista curada de tópicos virais GENIA (fallback sempre disponível)
 *
 * Roda a cada 6h automaticamente (chamado por megaAgent.js)
 */
require('dotenv').config();
const https  = require('https');
const http   = require('http');
const path   = require('path');

const LOG_FILE = path.join(__dirname, '../logs/trendingInjector.log');
const fs = require('fs');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ── Tópicos virais curados (fallback garantido) ───────────────────────────────
// Baseado em Google Trends BR + Hotmart + Amazon KDP bestsellers
const VIRAL_TOPICS_PT = [
  // Finanças (maior demanda)
  'Como sair das dívidas e recuperar o crédito em 2026',
  'Investir em ações com R$100: guia para iniciantes',
  'Renda extra online: 30 formas de ganhar dinheiro em casa',
  'Como ganhar dinheiro com inteligência artificial',
  'Criptomoedas para iniciantes: Bitcoin e Ethereum em 2026',
  'Como economizar dinheiro ganhando pouco',
  'Independência financeira: guia definitivo 2026',
  'Pix e novas formas de pagamento: oportunidades de negócio',
  // Saúde
  'Emagrecer de vez: método comprovado sem sofrimento',
  'Jejum intermitente: protocolo completo para perder peso',
  'Como acabar com a ansiedade e o estresse naturalmente',
  'Diabetes: como controlar sem remédios e viver bem',
  'Saúde mental: 30 hábitos para uma mente saudável',
  'Colesterol alto: o que comer e o que evitar',
  'Como dormir melhor e acordar com energia',
  'Suplementação natural: guia completo 2026',
  // Negócios
  'Dropshipping em 2026: como começar do zero',
  'Marketing digital para pequenos negócios',
  'Como vender no TikTok e Instagram: estratégias 2026',
  'Criação de conteúdo para ganhar dinheiro online',
  'Freelancer: como cobrar caro e ter clientes fiéis',
  'E-commerce: da ideia ao primeiro R$10.000',
  'Como criar um produto digital e viver de royalties',
  // IA e Tecnologia
  'ChatGPT e IA: como usar para ganhar dinheiro',
  'Prompt engineering: guia prático com ChatGPT',
  'Automação com IA: elimine trabalho manual',
  'Como criar um negócio com IA sem programar',
  // Relacionamentos
  'Como melhorar seu casamento e evitar o divórcio',
  'Educação dos filhos na era digital',
  'Como atrair a pessoa certa: autoconhecimento e amor',
  // Desenvolvimento Pessoal
  'Produtividade extrema: faça mais em menos tempo',
  'Disciplina e hábitos: como transformar sua vida',
  'Mindset milionário: como pensar como rico',
  'Como parar de procrastinar de uma vez por todas',
  // Espiritualidade
  'Lei da atração: como manifestar seus sonhos',
  'Meditação para iniciantes: guia prático',
  'Estoicismo aplicado: sabedoria antiga para vida moderna',
];

const VIRAL_TOPICS_EN = [
  'How to make money online in 2026: complete guide',
  'Passive income ideas: earn while you sleep',
  'AI tools to make money: complete guide 2026',
  'Weight loss without hunger: science-based approach',
  'Intermittent fasting: complete guide for beginners',
  'How to invest in stocks with $100',
  'Crypto for beginners: Bitcoin and Ethereum 2026',
  'Freelancing guide: earn $5000/month remotely',
  'Digital marketing for small business owners',
  'How to start a dropshipping business in 2026',
  'Anxiety relief: 30 proven techniques',
  'Sleep better: complete guide to quality sleep',
  'Productivity hacks: do more in less time',
  'Stoicism: ancient wisdom for modern life',
  'Manifestation and law of attraction guide',
  'Keto diet: complete beginner guide',
  'How to build muscle fast: complete guide',
  'ChatGPT and AI: how to make money with AI tools',
  'Prompt engineering for beginners',
];

const VIRAL_TOPICS_ES = [
  'Cómo ganar dinero con inteligencia artificial en 2026',
  'Guía de criptomonedas para principiantes',
  'Adelgazar sin pasar hambre: método científico',
  'Cómo salir de deudas y recuperar tu crédito',
  'Marketing digital para emprendedores',
  'Productividad extrema: haz más en menos tiempo',
  'Ayuno intermitente: guía completa para principiantes',
  'Cómo invertir con poco dinero en 2026',
  'Manifestación y ley de atracción: guía práctica',
  'Ansiedad: técnicas probadas para superarla',
];

// ── Google Trends Daily (Brasil) ──────────────────────────────────────────────
function fetchGoogleTrendsBR() {
  return new Promise((resolve) => {
    const url = 'https://trends.google.com/trends/api/dailytrends?hl=pt-BR&tz=-180&geo=BR&ns=15';
    https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          // Google Trends returns ")]}'\n" prefix
          const json = JSON.parse(data.replace(/^\)\]\}'/, ''));
          const topics = [];
          const days = json?.default?.trendingSearchesDays || [];
          for (const day of days) {
            for (const t of (day.trendingSearches || [])) {
              const q = t?.title?.query;
              if (q && q.length > 3) topics.push(q);
              // Related queries
              for (const r of (t?.relatedQueries || [])) {
                if (r?.query && r.query.length > 3) topics.push(r.query);
              }
            }
          }
          log(`[Trends] Google Trends BR: ${topics.length} trending topics`);
          resolve(topics);
        } catch (e) {
          log(`[Trends] Parse error: ${e.message}`);
          resolve([]);
        }
      });
    }).on('error', e => {
      log(`[Trends] Fetch error: ${e.message}`);
      resolve([]);
    });
  });
}

// ── Filtrar tópicos relevantes para ebooks ────────────────────────────────────
function filterEbookRelevant(topics) {
  const KEYWORDS = [
    'como', 'guia', 'dicas', 'aprenda', 'saúde', 'dinheiro', 'negócios',
    'ganhar', 'emagrecer', 'dieta', 'investir', 'ansiedade', 'relacionamento',
    'emprego', 'carreira', 'negócio', 'renda', 'lucro', 'sucesso', 'vida',
    'amor', 'família', 'educação', 'trabalho', 'tecnologia', 'bitcoin', 'ia',
    'inteligência', 'artificial', 'receita', 'fit', 'academia', 'treino',
    'hábito', 'mindset', 'produtividade', 'marketing', 'vendas', 'celular',
    'app', 'curso', 'método', 'segredo', 'truque', 'estratégia',
  ];
  return topics.filter(t => {
    const lower = t.toLowerCase();
    return KEYWORDS.some(k => lower.includes(k));
  });
}

// ── Converter trending term para tópico de ebook ──────────────────────────────
function expandToEbookTopic(term) {
  // Heuristics to turn a short search term into an ebook-worthy topic
  const t = term.trim();
  if (t.length > 60) return t; // already long enough
  const patterns = [
    [/^como /i, `${t}: guia completo e prático`],
    [/saúde|dieta|emagrecer|peso|treino/i, `${t}: guia definitivo para resultados reais`],
    [/dinheiro|renda|ganhar|investir|finanças/i, `${t}: estratégias comprovadas para 2026`],
    [/ia|inteligência artificial|chatgpt|tecnologia/i, `${t}: guia prático para iniciantes`],
    [/ansiedade|depressão|estresse|mental/i, `${t}: técnicas eficazes e ciência por trás`],
    [/negócio|empresa|empreender|startup/i, `${t}: do zero ao primeiro faturamento`],
  ];
  for (const [re, expanded] of patterns) {
    if (re.test(t)) return expanded;
  }
  return `${t}: guia completo para iniciantes`;
}

// ── Injetar tópicos no banco de dados ─────────────────────────────────────────
async function injectTopics(topics, source = 'trending') {
  try {
    const db = require('../src/core/database');
    const rawDb = db.getDb();

    // Ensure topics table has the required columns
    try {
      rawDb.prepare('ALTER TABLE topics ADD COLUMN source TEXT DEFAULT \'static\'').run();
    } catch {} // column may already exist

    let injected = 0;
    const stmt = rawDb.prepare(`
      INSERT OR IGNORE INTO topics (topic, category, demand_score, source, used_at)
      VALUES (?, 'trending', ?, ?, NULL)
    `);

    for (const t of topics) {
      const expanded = expandToEbookTopic(t);
      try {
        const result = stmt.run(expanded, 9.5, source);
        if (result.changes > 0) injected++;
      } catch {}
    }
    log(`[Inject] Injetados ${injected}/${topics.length} tópicos novos (source=${source})`);
    return injected;
  } catch (e) {
    log(`[Inject] DB error: ${e.message}`);
    return 0;
  }
}

// ── Injetar lista curada viral ─────────────────────────────────────────────────
async function injectViralTopics() {
  let total = 0;
  total += await injectTopics(VIRAL_TOPICS_PT, 'viral_pt');
  total += await injectTopics(VIRAL_TOPICS_EN, 'viral_en');
  total += await injectTopics(VIRAL_TOPICS_ES, 'viral_es');
  log(`[Inject] Total viral: ${total} tópicos injetados`);
  return total;
}

// ── Executar injeção completa ─────────────────────────────────────────────────
async function runInjection() {
  log('=== Trending Topics Injection Start ===');

  // 1. Google Trends Brasil
  const trendsBR = await fetchGoogleTrendsBR();
  const relevantBR = filterEbookRelevant(trendsBR);
  log(`[Trends] Relevantes BR: ${relevantBR.length}/${trendsBR.length}`);
  await injectTopics(relevantBR, 'google_trends_br');

  // 2. Tópicos virais curados
  await injectViralTopics();

  log('=== Trending Topics Injection Complete ===');
}

module.exports = { runInjection, injectViralTopics };

// Run directly if called as script
if (require.main === module) {
  runInjection().catch(e => {
    log(`FATAL: ${e.message}`);
    process.exit(1);
  });
}
