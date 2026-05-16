/**
 * WriterAgent — Geração completa de e-book via LLM
 * Cria outline + conteúdo capítulo por capítulo
 */
const { generate } = require('../core/aiClient');
const { createLogger } = require('../core/logger');
const logger = createLogger('writerAgent');

const SYSTEM_PROMPT = `Você é um escritor profissional de e-books educativos em português brasileiro.
Escreva de forma clara, prática e envolvente.
Use linguagem acessível mas profissional.
Inclua exemplos reais, dicas práticas e passos de ação.
Evite juridiquês e termos complicados sem explicação.
Formate com subtítulos, listas e destaques quando necessário.`;

async function generateOutline(topic) {
  logger.info(`Gerando outline para: ${topic}`);
  const prompt = `Crie um outline completo para um e-book sobre "${topic}".

  O e-book deve ter:
  - Título principal atrativo (máx 60 caracteres)
  - Subtítulo descritivo (máx 100 caracteres)
  - Descrição de venda (150-200 palavras, focada em benefícios e transformação)
  - 7-9 capítulos com nomes atrativos
  - Para cada capítulo: nome + 4-5 seções/tópicos

  Responda APENAS em JSON válido neste formato:
  {
    "title": "...",
    "subtitle": "...",
    "description": "...",
    "chapters": [
      {
        "number": 1,
        "title": "...",
        "sections": ["seção 1", "seção 2", "seção 3", "seção 4"]
      }
    ]
  }`;

  const { text, provider } = await generate(prompt, SYSTEM_PROMPT);

  // Extrair JSON da resposta
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Outline não retornou JSON válido');

  const outline = JSON.parse(jsonMatch[0]);
  logger.info(`Outline gerado: "${outline.title}" com ${outline.chapters.length} capítulos via ${provider}`);
  return { ...outline, provider };
}

async function generateIntroduction(outline) {
  logger.info('Gerando introdução...');
  const prompt = `Escreva a INTRODUÇÃO completa para o e-book "${outline.title}".

  A introdução deve ter:
  - Parágrafo de abertura impactante (problema/dor do leitor)
  - Por que esse assunto é importante agora
  - O que o leitor vai aprender
  - Como usar este e-book
  - Motivação e encorajamento

  Escreva entre 400-600 palavras. Use "você" para se dirigir ao leitor.
  Tópico do livro: ${outline.title} - ${outline.subtitle}`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateChapter(chapterInfo, ebookTitle) {
  logger.info(`Gerando capítulo ${chapterInfo.number}: ${chapterInfo.title}`);

  const sectionsText = chapterInfo.sections.map((s, i) => `${i+1}. ${s}`).join('\n');

  const prompt = `Escreva o CAPÍTULO ${chapterInfo.number} completo do e-book "${ebookTitle}".

  Título do capítulo: "${chapterInfo.title}"
  Seções a cobrir:
  ${sectionsText}

  Para cada seção:
  - Inicie com subtítulo em negrito
  - Escreva 200-350 palavras de conteúdo
  - Inclua exemplos práticos ou estudos de caso
  - Adicione dicas, alertas ou curiosidades quando relevante

  Total do capítulo: 1.200-2.000 palavras
  Use linguagem direta e prática em português brasileiro.
  Inclua pelo menos 1 "Dica Prática" ou "Atenção" em caixa separada por linha em branco.`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateConclusion(outline) {
  logger.info('Gerando conclusão...');
  const prompt = `Escreva a CONCLUSÃO completa do e-book "${outline.title}".

  A conclusão deve ter:
  - Resumo dos principais aprendizados (1 frase por capítulo)
  - Próximos passos concretos para o leitor
  - Mensagem motivacional final
  - CTA sutil: recomendar para amigos se gostou

  Entre 300-500 palavras. Deixe o leitor se sentindo capaz e motivado.`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateFullEbook(topic) {
  logger.info(`\n📚 Iniciando geração do e-book: ${topic}`);
  const startTime = Date.now();

  // 1. Outline
  const outline = await generateOutline(topic);

  // 2. Introdução
  const introduction = await generateIntroduction(outline);

  // 3. Capítulos (sequencial para não explodir cota)
  const chapters = [];
  for (const chapter of outline.chapters) {
    const content = await generateChapter(chapter, outline.title);
    chapters.push({ ...chapter, content });
    // Pequeno delay para não throttling
    await new Promise(r => setTimeout(r, 1000));
  }

  // 4. Conclusão
  const conclusion = await generateConclusion(outline);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  logger.info(`✅ E-book gerado em ${elapsed}s: ${chapters.length} capítulos`);

  return {
    title: outline.title,
    subtitle: outline.subtitle,
    description: outline.description,
    topic,
    provider: outline.provider,
    introduction,
    chapters,
    conclusion,
    wordCount: [introduction, ...chapters.map(c => c.content), conclusion]
      .join(' ').split(/\s+/).length,
  };
}

module.exports = { generateFullEbook, generateOutline };
