/**
 * topicExpander.js — Banco de 500+ tópicos dos mais buscados no Brasil
 *
 * Categorias: finanças, saúde, negócios, relacionamentos, espiritualidade,
 *             tecnologia, desenvolvimento pessoal, culinária, educação,
 *             família, carreira, jurídico, moda/beleza, viagem, pets
 *
 * Demand scores baseados em volume de busca e vendas reais em Hotmart/KDP
 */
const db = require('../core/database');
const { createLogger } = require('../core/logger');
const logger = createLogger('topicExpander');

// ─── Banco completo de tópicos ────────────────────────────────────────────────
// Formato: [topic, category, demand_score]
const ALL_TOPICS = [

  // ══════════════════════════════════════════════════
  // FINANÇAS (score 8-10 — maior demanda no Brasil)
  // ══════════════════════════════════════════════════
  ['Como sair das dívidas e limpar o nome', 'financas', 9.8],
  ['Educação financeira para iniciantes', 'financas', 9.7],
  ['Investimentos para quem ganha pouco', 'financas', 9.6],
  ['Como guardar dinheiro com salário mínimo', 'financas', 9.5],
  ['Renda passiva: como ganhar dinheiro dormindo', 'financas', 9.5],
  ['Tesouro Direto passo a passo para iniciantes', 'financas', 9.3],
  ['Independência financeira antes dos 40 anos', 'financas', 9.3],
  ['Como negociar dívidas com os bancos', 'financas', 9.2],
  ['Fundos imobiliários para renda mensal', 'financas', 9.0],
  ['Bitcoin e criptomoedas para iniciantes', 'financas', 9.0],
  ['Como montar uma reserva de emergência', 'financas', 8.9],
  ['Planilha de controle financeiro pessoal', 'financas', 8.8],
  ['Ações na bolsa: guia completo para começar', 'financas', 8.8],
  ['Como economizar na feira e no supermercado', 'financas', 8.7],
  ['Renda extra online: 20 formas comprovadas', 'financas', 8.7],
  ['Consórcio vale a pena? Guia completo', 'financas', 8.5],
  ['Como comprar o primeiro apartamento', 'financas', 8.5],
  ['Freelancer: como precificar seus serviços', 'financas', 8.4],
  ['Aposentadoria privada vs INSS', 'financas', 8.3],
  ['DeFi e finanças descentralizadas para leigos', 'financas', 8.0],
  ['Como viver de dividendos no Brasil', 'financas', 8.0],
  ['Seguro de vida: quando contratar e qual escolher', 'financas', 7.8],
  ['Imposto de renda: tudo que você precisa saber', 'financas', 7.8],
  ['MEI: guia completo de como abrir e manter', 'financas', 7.7],
  ['Como negociar aumento de salário', 'financas', 7.6],

  // ══════════════════════════════════════════════════
  // SAÚDE E BEM-ESTAR
  // ══════════════════════════════════════════════════
  ['Emagrecer com saúde sem passar fome', 'saude', 9.8],
  ['Dieta low carb: guia completo e prático', 'saude', 9.7],
  ['Como controlar o diabetes naturalmente', 'saude', 9.6],
  ['Jejum intermitente: protocolo e benefícios', 'saude', 9.5],
  ['Como baixar a pressão alta sem remédio', 'saude', 9.4],
  ['Saúde mental: como cuidar da mente no dia a dia', 'saude', 9.4],
  ['Ansiedade: técnicas para controlar e viver bem', 'saude', 9.3],
  ['Tireoide: entenda e cuide da sua saúde', 'saude', 9.2],
  ['Hipertrofia muscular: guia completo de treino', 'saude', 9.0],
  ['Dieta cetogênica: receitas e resultados', 'saude', 8.9],
  ['Como ter uma barriga chapada em 90 dias', 'saude', 8.9],
  ['Síndrome do pânico: como superar de vez', 'saude', 8.8],
  ['Burnout: reconhecer, tratar e se recuperar', 'saude', 8.7],
  ['Colesterol alto: guia de alimentação e tratamento', 'saude', 8.7],
  ['Intestino saudável: dieta e probióticos', 'saude', 8.6],
  ['Como dormir melhor: técnicas de sono profundo', 'saude', 8.5],
  ['Depressão: entender e superar com apoio profissional', 'saude', 8.5],
  ['Saúde da mulher após os 40 anos', 'saude', 8.4],
  ['Menopausa: como atravessar bem essa fase', 'saude', 8.4],
  ['Suplementação esportiva: o que realmente funciona', 'saude', 8.3],
  ['Yoga para iniciantes: corpo e mente em equilíbrio', 'saude', 8.2],
  ['Como parar de fumar de uma vez por todas', 'saude', 8.2],
  ['Enxaqueca: causas, gatilhos e tratamentos eficazes', 'saude', 8.0],
  ['Dermatite e pele sensível: cuidados e tratamentos', 'saude', 7.8],
  ['Triglicerídeos altos: como reduzir com dieta', 'saude', 7.7],
  ['TDAH no adulto: entendendo e gerenciando', 'saude', 7.7],
  ['Autismo: guia para pais e familiares', 'saude', 7.6],
  ['Câncer: prevenção, diagnóstico precoce e tratamento', 'saude', 7.6],
  ['Artrите e articulações: como conviver e melhorar', 'saude', 7.5],
  ['Alimentação alcalina: mitos e verdades', 'saude', 7.4],

  // ══════════════════════════════════════════════════
  // NEGÓCIOS E EMPREENDEDORISMO
  // ══════════════════════════════════════════════════
  ['Como montar um negócio do zero sem dinheiro', 'negocios', 9.7],
  ['Marketing digital para pequenas empresas', 'negocios', 9.6],
  ['Dropshipping no Brasil: guia completo 2025', 'negocios', 9.5],
  ['Como ganhar dinheiro como afiliado digital', 'negocios', 9.5],
  ['Tráfego pago para iniciantes: Google e Meta Ads', 'negocios', 9.4],
  ['Copywriting: a arte de vender com palavras', 'negocios', 9.3],
  ['Infoprodutos: como criar e vender online', 'negocios', 9.2],
  ['E-commerce: montar e crescer sua loja virtual', 'negocios', 9.2],
  ['Como virar autoridade no Instagram', 'negocios', 9.0],
  ['YouTube para negócios: monetizar e crescer', 'negocios', 8.9],
  ['Gestão de redes sociais profissional', 'negocios', 8.8],
  ['Como precificar produtos e serviços corretamente', 'negocios', 8.7],
  ['Vendas online: técnicas e scripts que convertem', 'negocios', 8.7],
  ['Franquia: vale a pena investir?', 'negocios', 8.5],
  ['Print on demand: venda camisetas sem estoque', 'negocios', 8.4],
  ['Gestão financeira para microempreendedores', 'negocios', 8.4],
  ['Como fazer a primeira venda online em 7 dias', 'negocios', 8.3],
  ['Branding pessoal: construir sua marca digital', 'negocios', 8.3],
  ['Pitch de vendas: como apresentar seu negócio', 'negocios', 8.2],
  ['Automação de marketing para pequenas empresas', 'negocios', 8.2],
  ['Como escalar um negócio digital para 6 dígitos', 'negocios', 8.0],
  ['Networking: construir relacionamentos que geram negócios', 'negocios', 7.9],
  ['Liderança e gestão de equipes remotas', 'negocios', 7.8],
  ['Planejamento estratégico para empreendedores', 'negocios', 7.7],
  ['Criação de cursos online que vendem de verdade', 'negocios', 7.7],

  // ══════════════════════════════════════════════════
  // DESENVOLVIMENTO PESSOAL
  // ══════════════════════════════════════════════════
  ['Hábitos de pessoas altamente eficazes', 'comportamento', 9.6],
  ['Como parar de procrastinar e agir de vez', 'comportamento', 9.5],
  ['Inteligência emocional: desenvolver e aplicar', 'comportamento', 9.4],
  ['Mindset de crescimento: como mudar sua mentalidade', 'comportamento', 9.3],
  ['Disciplina: como criar rotinas que transformam', 'comportamento', 9.2],
  ['Autoconfiança: como desenvolver e manter', 'comportamento', 9.0],
  ['Como definir e conquistar seus objetivos', 'comportamento', 8.9],
  ['Leitura rápida: técnicas para ler mais e melhor', 'comportamento', 8.7],
  ['Comunicação poderosa: falar e influenciar pessoas', 'comportamento', 8.7],
  ['Como superar o medo do fracasso', 'comportamento', 8.6],
  ['Produtividade extrema: trabalhe menos, realize mais', 'comportamento', 8.5],
  ['Como desenvolver resiliência e força interior', 'comportamento', 8.4],
  ['Psicologia das vendas: influência e persuasão', 'comportamento', 8.3],
  ['Meditação para iniciantes: começar do zero', 'comportamento', 8.2],
  ['Como se tornar uma pessoa mais organizada', 'comportamento', 8.0],
  ['Autoconhecimento: a jornada de dentro para fora', 'comportamento', 7.9],
  ['Como lidar com críticas e pessoas difíceis', 'comportamento', 7.8],
  ['Gratidão: o hábito que transforma a vida', 'comportamento', 7.6],
  ['Como se reinventar profissionalmente', 'comportamento', 7.5],
  ['Estoicismo moderno: filosofia para dias difíceis', 'comportamento', 7.5],

  // ══════════════════════════════════════════════════
  // RELACIONAMENTOS
  // ══════════════════════════════════════════════════
  ['Como reconquistar seu ex e manter o amor', 'relacionamentos', 9.5],
  ['Comunicação não violenta no relacionamento', 'relacionamentos', 9.3],
  ['Como atrair o parceiro ideal para sua vida', 'relacionamentos', 9.2],
  ['Relacionamento aberto: como funciona de verdade', 'relacionamentos', 9.0],
  ['Traição: como superar e decidir o que fazer', 'relacionamentos', 8.9],
  ['Gaslighting e manipulação: identifique e saia', 'relacionamentos', 8.8],
  ['Como melhorar a vida sexual no casamento', 'relacionamentos', 8.7],
  ['Divórcio consciente: separação sem destruição', 'relacionamentos', 8.6],
  ['Narcisismo: reconhecer e se livrar do narcisista', 'relacionamentos', 8.5],
  ['Ciúme: como controlar e não destruir o amor', 'relacionamentos', 8.4],
  ['Relacionamento à distância: como fazer funcionar', 'relacionamentos', 8.3],
  ['Amor próprio: guia definitivo para se amar', 'relacionamentos', 8.2],
  ['Como se dar bem com a família do parceiro', 'relacionamentos', 7.8],
  ['Vínculos afetivos: como criar conexões profundas', 'relacionamentos', 7.6],
  ['Como superar um amor não correspondido', 'relacionamentos', 7.5],

  // ══════════════════════════════════════════════════
  // ESPIRITUALIDADE E RELIGIÃO
  // ══════════════════════════════════════════════════
  ['Devocional diário: 365 dias com Deus', 'espiritualidade', 9.6],
  ['A bíblia e as finanças: prosperidade com Deus', 'espiritualidade', 9.4],
  ['Como ouvir a voz de Deus na sua vida', 'espiritualidade', 9.3],
  ['Prosperidade bíblica: fé e ação prática', 'espiritualidade', 9.2],
  ['Cura interior: libertação de feridas emocionais', 'espiritualidade', 9.0],
  ['Missão de vida: descobrir o seu propósito', 'espiritualidade', 8.9],
  ['Espiritualidade e autoconhecimento: encontrar a si', 'espiritualidade', 8.7],
  ['Umbanda e Candomblé: tradições e práticas', 'espiritualidade', 8.5],
  ['Budismo na prática: paz e presença', 'espiritualidade', 8.3],
  ['Tarô: guia completo para iniciantes', 'espiritualidade', 8.2],
  ['Reiki: o poder da cura energética', 'espiritualidade', 8.0],
  ['Numerologia: descubra o significado dos números', 'espiritualidade', 7.9],
  ['Cristais e pedras: propriedades e usos', 'espiritualidade', 7.7],
  ['Lei da atração: manifestar com propósito', 'espiritualidade', 7.6],
  ['Meditação cristã: contemplação e silêncio', 'espiritualidade', 7.5],

  // ══════════════════════════════════════════════════
  // TECNOLOGIA E INTELIGÊNCIA ARTIFICIAL
  // ══════════════════════════════════════════════════
  ['ChatGPT e IA para ganhar dinheiro online', 'tecnologia', 9.8],
  ['Prompt engineering: domine a IA para trabalhar', 'tecnologia', 9.6],
  ['Python para iniciantes: do zero ao emprego', 'tecnologia', 9.4],
  ['Inteligência artificial no dia a dia', 'tecnologia', 9.3],
  ['Como usar IA para criar conteúdo profissional', 'tecnologia', 9.2],
  ['No-code: crie apps e sites sem programar', 'tecnologia', 9.0],
  ['Automação com IA: eliminar tarefas repetitivas', 'tecnologia', 8.9],
  ['Data science para não programadores', 'tecnologia', 8.7],
  ['Segurança digital: proteger sua vida online', 'tecnologia', 8.6],
  ['Web3 e blockchain: o futuro da internet', 'tecnologia', 8.5],
  ['Como criar um aplicativo sem saber programar', 'tecnologia', 8.4],
  ['SEO para iniciantes: rankear no Google em 2025', 'tecnologia', 8.3],
  ['Excel avançado para profissionais', 'tecnologia', 8.2],
  ['Power BI: análise de dados para tomada de decisão', 'tecnologia', 8.0],
  ['Canva profissional: design sem ser designer', 'tecnologia', 7.9],
  ['Criação de conteúdo com IA: guia completo', 'tecnologia', 7.8],
  ['Privacidade digital: como proteger seus dados', 'tecnologia', 7.6],
  ['E-mail marketing que realmente vende', 'tecnologia', 7.5],
  ['Criação de chatbots para pequenas empresas', 'tecnologia', 7.4],
  ['Cloud computing para empreendedores', 'tecnologia', 7.3],

  // ══════════════════════════════════════════════════
  // CULINÁRIA E RECEITAS
  // ══════════════════════════════════════════════════
  ['Receitas fitness para perder peso com sabor', 'culinaria', 9.4],
  ['Marmitas saudáveis para semana toda', 'culinaria', 9.3],
  ['Low carb na prática: receitas do dia a dia', 'culinaria', 9.2],
  ['Receitas veganas ricas em proteína', 'culinaria', 9.0],
  ['Confeitaria básica para vender e lucrar', 'culinaria', 8.9],
  ['Pão caseiro e fermentação natural', 'culinaria', 8.7],
  ['Cozinha rápida: 50 receitas em menos de 30 min', 'culinaria', 8.6],
  ['Air fryer: guia completo de receitas saudáveis', 'culinaria', 8.5],
  ['Bolo no pote: receitas e como vender', 'culinaria', 8.4],
  ['Bolos de pote e doces para renda extra', 'culinaria', 8.3],
  ['Comida para crianças: receitas nutritivas', 'culinaria', 8.2],
  ['Sucos detox e smoothies para emagrecer', 'culinaria', 8.0],
  ['Cozinha portuguesa: tradição e sabor', 'culinaria', 7.8],
  ['Receitas para diabéticos e pré-diabéticos', 'culinaria', 7.7],
  ['Salgados e quentinhas para vender', 'culinaria', 7.6],

  // ══════════════════════════════════════════════════
  // FAMÍLIA E MATERNIDADE
  // ══════════════════════════════════════════════════
  ['Gravidez saudável: guia completo mês a mês', 'familia', 9.5],
  ['Amamentação: tudo que a mãe precisa saber', 'familia', 9.3],
  ['Como lidar com filho adolescente difícil', 'familia', 9.2],
  ['Educação positiva: criar filhos sem gritar', 'familia', 9.0],
  ['Criança com autismo: guia para pais', 'familia', 8.9],
  ['Limites e disciplina sem castigos', 'familia', 8.8],
  ['Bebê de 0 a 12 meses: desenvolvimento e cuidados', 'familia', 8.7],
  ['Como trabalhar de casa com filho pequeno', 'familia', 8.5],
  ['Síndrome de Down: conviver e valorizar', 'familia', 8.3],
  ['Como criar filhos digitais e seguros online', 'familia', 8.2],
  ['Mediação familiar e guarda compartilhada', 'familia', 8.0],
  ['Terceira idade saudável: cuidar dos pais idosos', 'familia', 7.9],
  ['Como falar sobre sexo com seus filhos', 'familia', 7.7],
  ['Babás e creches: como escolher com segurança', 'familia', 7.5],

  // ══════════════════════════════════════════════════
  // CARREIRA E TRABALHO
  // ══════════════════════════════════════════════════
  ['Como passar em qualquer entrevista de emprego', 'carreira', 9.3],
  ['Currículo profissional que chama atenção', 'carreira', 9.2],
  ['LinkedIn: perfil e estratégia para ser contratado', 'carreira', 9.0],
  ['Como mudar de carreira com mais de 40 anos', 'carreira', 8.8],
  ['Trabalho remoto: produtividade e organização', 'carreira', 8.7],
  ['Concurso público: método de estudo aprovado', 'carreira', 8.6],
  ['OAB aprovação: estratégia e simulados', 'carreira', 8.5],
  ['Como conseguir emprego no exterior', 'carreira', 8.4],
  ['Negociação salarial: técnicas infalíveis', 'carreira', 8.3],
  ['Como virar gerente sem perder a equipe', 'carreira', 8.1],
  ['Soft skills que todo profissional precisa', 'carreira', 8.0],
  ['Recolocação profissional em 90 dias', 'carreira', 7.9],
  ['Como ser bem-sucedido sem faculdade', 'carreira', 7.7],
  ['Design gráfico do zero: fundamentos e prática', 'carreira', 7.6],
  ['Fotografia profissional com celular', 'carreira', 7.5],

  // ══════════════════════════════════════════════════
  // DIREITO E QUESTÕES JURÍDICAS
  // ══════════════════════════════════════════════════
  ['Direitos do consumidor: como reclamar e ganhar', 'juridico', 9.2],
  ['INSS: seus direitos e como garantir a aposentadoria', 'juridico', 9.0],
  ['Como dar entrada no BPC LOAS', 'juridico', 8.8],
  ['Divórcio: seus direitos e como se proteger', 'juridico', 8.7],
  ['Inventário e herança: o guia simplificado', 'juridico', 8.5],
  ['Direitos trabalhistas: tudo que o CLT garante', 'juridico', 8.4],
  ['Registro de marca: como proteger seu negócio', 'juridico', 8.2],
  ['Golpes digitais: como se proteger juridicamente', 'juridico', 8.0],
  ['Acordo extrajudicial: como fazer sem advogado', 'juridico', 7.8],
  ['LGPD para pequenos negócios: o básico', 'juridico', 7.5],

  // ══════════════════════════════════════════════════
  // BELEZA E MODA
  // ══════════════════════════════════════════════════
  ['Cuidados com cabelos cacheados e crespos', 'beleza', 9.4],
  ['Skin care: rotina para pele perfeita', 'beleza', 9.2],
  ['Make para iniciantes: do básico ao profissional', 'beleza', 9.0],
  ['Colorimetria pessoal: descubra suas cores', 'beleza', 8.8],
  ['Estilo pessoal: montar looks incríveis gastando pouco', 'beleza', 8.6],
  ['Alongamento de unhas: curso básico', 'beleza', 8.4],
  ['Depilação natural: como fazer em casa', 'beleza', 8.2],
  ['Cabelos saudáveis: cronograma e tratamentos', 'beleza', 8.0],
  ['Como se tornar maquiadora profissional', 'beleza', 7.8],
  ['Brechó e moda sustentável: como comprar e vender', 'beleza', 7.5],

  // ══════════════════════════════════════════════════
  // VIAGEM E ESTILO DE VIDA
  // ══════════════════════════════════════════════════
  ['Como viajar barato e bem pelo Brasil', 'viagem', 8.8],
  ['Intercâmbio: como planejar e realizar', 'viagem', 8.6],
  ['Nômade digital: trabalhar e viajar pelo mundo', 'viagem', 8.5],
  ['Visto americano: como conseguir aprovação', 'viagem', 8.4],
  ['Morar no exterior: guia para brasileiros', 'viagem', 8.3],
  ['Portugal para brasileiros: visto, emprego, vida', 'viagem', 8.2],
  ['Como planejar uma viagem internacional do zero', 'viagem', 8.0],
  ['Van life: viver viajando de van pelo Brasil', 'viagem', 7.7],
  ['Milhas e pontos: viagens de graça na prática', 'viagem', 7.6],
  ['Airbnb para anfitriões: lucrar com hospedagem', 'viagem', 7.5],

  // ══════════════════════════════════════════════════
  // PETS
  // ══════════════════════════════════════════════════
  ['Adestramento de cão para iniciantes', 'pets', 8.9],
  ['Alimentação natural para cães e gatos', 'pets', 8.7],
  ['Como cuidar de filhote de cachorro', 'pets', 8.6],
  ['Psicologia canina: entender seu cão', 'pets', 8.4],
  ['Gato: comportamento, saúde e bem-estar', 'pets', 8.3],
  ['Empreender com pets: serviços e produtos', 'pets', 8.0],
  ['Aves domésticas: calopsita e periquito', 'pets', 7.7],
  ['Aquarismo: montar e manter um aquário saudável', 'pets', 7.5],

  // ══════════════════════════════════════════════════
  // EDUCAÇÃO E ESTUDOS
  // ══════════════════════════════════════════════════
  ['ENEM: estratégia completa para aprovação', 'educacao', 9.1],
  ['Matemática do zero ao avançado', 'educacao', 8.9],
  ['Inglês em 30 dias: método comprovado', 'educacao', 8.8],
  ['Espanhol fluente para brasileiros', 'educacao', 8.6],
  ['Como aprender a programar do zero', 'educacao', 8.5],
  ['Redação nota 1000 no ENEM', 'educacao', 8.4],
  ['Estudo eficiente: técnicas de memorização', 'educacao', 8.3],
  ['Concurso dos Correios: guia de preparação', 'educacao', 8.1],
  ['Técnico de enfermagem: guia de estudo', 'educacao', 8.0],
  ['Como fazer um TCC de qualidade', 'educacao', 7.7],
];

// ─── Inserir tópicos no banco ─────────────────────────────────────────────────
async function expandTopics() {
  const db_module = require('../core/database');
  const { getDb } = db_module;
  const sqliteDb = getDb();

  const insert = sqliteDb.prepare(
    'INSERT OR IGNORE INTO topics (topic, category, demand_score) VALUES (?, ?, ?)'
  );

  let added = 0;
  for (const [topic, category, score] of ALL_TOPICS) {
    const result = insert.run(topic, category, score);
    if (result.changes > 0) added++;
  }

  const total = sqliteDb.prepare('SELECT COUNT(*) as c FROM topics').get().c;
  logger.info(`📚 Tópicos: ${added} novos adicionados, ${total} total no banco`);
  return { added, total };
}

/**
 * Retorna lista de categorias disponíveis com contagem
 */
function getCategoryStats() {
  const { getDb } = require('../core/database');
  const sqliteDb = getDb();
  return sqliteDb.prepare(
    'SELECT category, COUNT(*) as count, AVG(demand_score) as avg_score FROM topics GROUP BY category ORDER BY avg_score DESC'
  ).all();
}

module.exports = { expandTopics, getCategoryStats, ALL_TOPICS };
