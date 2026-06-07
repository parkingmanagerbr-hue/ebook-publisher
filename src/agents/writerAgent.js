/**
 * WriterAgent — Geração completa de e-book via LLM
 * Cria outline + conteúdo capítulo por capítulo
 * Suporta múltiplos idiomas via parâmetro `language`
 */
const { generate } = require('../core/aiClient');
const { createLogger } = require('../core/logger');
const logger = createLogger('writerAgent');

// ── Language definitions ─────────────────────────────────────────────────────
const LANGUAGE_CONFIG = {
  'pt-BR': { name: 'Portuguese (Brazilian)', nativeName: 'português brasileiro', you: 'você', writingInstructions: 'Use linguagem direta e prática em português brasileiro.' },
  'pt':    { name: 'Portuguese (Brazilian)', nativeName: 'português brasileiro', you: 'você', writingInstructions: 'Use linguagem direta e prática em português brasileiro.' },
  'en':    { name: 'English', nativeName: 'English', you: 'you', writingInstructions: 'Use clear, practical, engaging English.' },
  'es':    { name: 'Spanish', nativeName: 'español', you: 'tú/usted', writingInstructions: 'Use un lenguaje directo y práctico en español.' },
  'fr':    { name: 'French', nativeName: 'français', you: 'vous', writingInstructions: 'Utilisez un langage clair et pratique en français.' },
  'de':    { name: 'German', nativeName: 'Deutsch', you: 'Sie', writingInstructions: 'Verwenden Sie eine klare und praktische Sprache auf Deutsch.' },
  'it':    { name: 'Italian', nativeName: 'italiano', you: 'lei', writingInstructions: 'Usa un linguaggio diretto e pratico in italiano.' },
  'pl':    { name: 'Polish', nativeName: 'język polski', you: 'Pan/Pani', writingInstructions: 'Używaj jasnego i praktycznego języka po polsku.' },
  'nl':    { name: 'Dutch', nativeName: 'Nederlands', you: 'u', writingInstructions: 'Gebruik duidelijke en praktische taal in het Nederlands.' },
  'ja':    { name: 'Japanese', nativeName: '日本語', you: 'あなた', writingInstructions: '明確で実践的な日本語を使ってください。' },
  'zh':    { name: 'Chinese (Simplified)', nativeName: '中文（简体）', you: '您', writingInstructions: '使用清晰实用的中文。' },
};

function getLangConfig(language) {
  return LANGUAGE_CONFIG[language] || LANGUAGE_CONFIG['pt-BR'];
}

function buildSystemPrompt(language) {
  const lang = getLangConfig(language);
  if (language === 'pt-BR' || language === 'pt') {
    return `Você é um escritor profissional de e-books educativos em português brasileiro.
Escreva de forma clara, prática e envolvente.
Use linguagem acessível mas profissional.
Inclua exemplos reais, dicas práticas e passos de ação.
Evite juridiquês e termos complicados sem explicação.
Formate com subtítulos, listas e destaques quando necessário.`;
  }
  return `You are a professional educational e-book writer. Write ENTIRELY in ${lang.name} (${lang.nativeName}).
DO NOT use any other language. All content must be in ${lang.nativeName}.
Write clearly, practically, and engagingly.
Use accessible but professional language.
Include real examples, practical tips, and action steps.
Format with subheadings, lists, and highlights when necessary.
${lang.writingInstructions}`;
}

async function generateOutline(topic, language = 'pt-BR') {
  logger.info(`Gerando outline para: ${topic} [lang=${language}]`);
  const SYSTEM_PROMPT = buildSystemPrompt(language);
  const lang = getLangConfig(language);
  const prompt = `Create a complete outline for an e-book about "${topic}". Write ENTIRELY in ${lang.name} (${lang.nativeName}).

  The e-book must have:
  - Main title (max 60 chars) — in ${lang.nativeName}
  - Descriptive subtitle (max 100 chars) — in ${lang.nativeName}
  - Sales description (150-200 words, focused on benefits and transformation) — in ${lang.nativeName}
  - 5-7 chapters with attractive names — in ${lang.nativeName}
  - For each chapter: name + 4-5 sections/topics — in ${lang.nativeName}

  Respond ONLY in valid JSON in this format (all text values must be in ${lang.nativeName}):
  {
    "title": "...",
    "subtitle": "...",
    "description": "...",
    "language": "${language}",
    "chapters": [
      {
        "number": 1,
        "title": "...",
        "sections": ["section 1", "section 2", "section 3", "section 4"]
      }
    ]
  }`;

  const { text, provider } = await generate(prompt, SYSTEM_PROMPT);

  // Extrair JSON da resposta
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Outline não retornou JSON válido');

  const outline = JSON.parse(jsonMatch[0]);
  logger.info(`Outline gerado: "${outline.title}" com ${outline.chapters.length} capítulos via ${provider} [lang=${language}]`);
  return { ...outline, language, provider };
}

async function generateIntroduction(outline, language = 'pt-BR') {
  logger.info('Gerando introdução...');
  const SYSTEM_PROMPT = buildSystemPrompt(language);
  const lang = getLangConfig(language);
  const prompt = `Write the complete INTRODUCTION for the e-book "${outline.title}". Write ENTIRELY in ${lang.name} (${lang.nativeName}).

  The introduction must have:
  - Impactful opening paragraph (reader's problem/pain)
  - Why this subject matters now
  - What the reader will learn
  - How to use this e-book
  - Motivation and encouragement

  Write 400-600 words. Use "${lang.you}" to address the reader.
  Topic: ${outline.title} - ${outline.subtitle}`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateChapter(chapterInfo, ebookTitle, language = 'pt-BR') {
  logger.info(`Gerando capítulo ${chapterInfo.number}: ${chapterInfo.title}`);
  const SYSTEM_PROMPT = buildSystemPrompt(language);
  const lang = getLangConfig(language);

  const sectionsText = chapterInfo.sections.map((s, i) => `${i+1}. ${s}`).join('\n');

  const prompt = `Write CHAPTER ${chapterInfo.number} completely for the e-book "${ebookTitle}". Write ENTIRELY in ${lang.name} (${lang.nativeName}).

  Chapter title: "${chapterInfo.title}"
  Sections to cover:
  ${sectionsText}

  For each section:
  - Start with a bold subheading
  - Write 200-350 words of content
  - Include practical examples or case studies
  - Add tips, warnings, or curiosities when relevant

  Total chapter: 1,200-2,000 words.
  ${lang.writingInstructions}
  Include at least 1 practical tip or warning in a box separated by blank lines.`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateConclusion(outline, language = 'pt-BR') {
  logger.info('Gerando conclusão...');
  const SYSTEM_PROMPT = buildSystemPrompt(language);
  const lang = getLangConfig(language);
  const prompt = `Write the complete CONCLUSION for the e-book "${outline.title}". Write ENTIRELY in ${lang.name} (${lang.nativeName}).

  The conclusion must have:
  - Summary of key learnings (1 sentence per chapter)
  - Concrete next steps for the reader
  - Final motivational message
  - Subtle CTA: recommend to friends if enjoyed

  300-500 words. Leave the reader feeling capable and motivated.`;

  const { text } = await generate(prompt, SYSTEM_PROMPT);
  return text;
}

async function generateFullEbook(topic, language = 'pt-BR') {
  logger.info(`\n📚 Iniciando geração do e-book: ${topic} [idioma=${language}]`);
  const startTime = Date.now();

  // 1. Outline
  const outline = await generateOutline(topic, language);

  // 2. Introdução
  const introduction = await generateIntroduction(outline, language);

  // 3. Capítulos (sequencial para não explodir cota)
  const chapters = [];
  for (const chapter of outline.chapters) {
    const content = await generateChapter(chapter, outline.title, language);
    chapters.push({ ...chapter, content });
    // Delay entre capítulos para reduzir pressão de rate limit
    // 5s dá mais respiração quando só 2 chaves Cerebras estão disponíveis
    await new Promise(r => setTimeout(r, 5000));
  }

  // 4. Conclusão
  const conclusion = await generateConclusion(outline, language);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  logger.info(`✅ E-book gerado em ${elapsed}s: ${chapters.length} capítulos [lang=${language}]`);

  return {
    title: outline.title,
    subtitle: outline.subtitle,
    description: outline.description,
    topic,
    language,
    provider: outline.provider,
    introduction,
    chapters,
    conclusion,
    wordCount: [introduction, ...chapters.map(c => c.content), conclusion]
      .join(' ').split(/\s+/).length,
  };
}

module.exports = { generateFullEbook, generateOutline };
