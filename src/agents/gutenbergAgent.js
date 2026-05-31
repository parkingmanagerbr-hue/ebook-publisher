/**
 * gutenbergAgent.js — Audiobooks dos Livros Mais Famosos do Mundo
 *
 * Baixa textos do Project Gutenberg (domínio público), parseia em capítulos
 * e gera audiobooks via ElevenLabs (audiobookAgent.js).
 *
 * Livros incluídos: clássicos universais em EN, PT, ES, FR, DE, IT
 * Limite por livro: MAX_CHARS chars (~60 min de áudio) para controlar custo ElevenLabs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { createLogger } = require('../core/logger');
const { generateAudiobook, isAvailable } = require('./audiobookAgent');

const logger = createLogger('gutenbergAgent');

const AUDIOBOOKS_DIR  = path.join(__dirname, '../../data/audiobooks');
const STATE_FILE      = path.join(__dirname, '../../data/gutenberg_state.json');
const MAX_CHARS       = 30_000;   // ~15-18 min de áudio por livro (controle de cota ElevenLabs)
const MAX_CHAPTERS    = 15;        // limitar capítulos
const DELAY_BETWEEN   = 10_000;   // ms entre livros

// ─── Catálogo: Livros mais famosos do mundo em domínio público ────────────────
// formato: { id, title, author, language, gutenbergId, url? }
const FAMOUS_BOOKS = [
  // ── Inglês ────────────────────────────────────────────────────────────────
  { id: 'pride-prejudice',        title: 'Pride and Prejudice',                  author: 'Jane Austen',              language: 'en', gutenbergId: 1342  },
  { id: 'alice-wonderland',       title: "Alice's Adventures in Wonderland",     author: 'Lewis Carroll',            language: 'en', gutenbergId: 11    },
  { id: 'dracula',                title: 'Dracula',                               author: 'Bram Stoker',              language: 'en', gutenbergId: 345   },
  { id: 'frankenstein',           title: 'Frankenstein',                          author: 'Mary Shelley',             language: 'en', gutenbergId: 84    },
  { id: 'sherlock-scarlet',       title: 'A Study in Scarlet',                   author: 'Arthur Conan Doyle',       language: 'en', gutenbergId: 244   },
  { id: 'time-machine',           title: 'The Time Machine',                     author: 'H.G. Wells',               language: 'en', gutenbergId: 35    },
  { id: 'war-of-worlds',          title: 'The War of the Worlds',                author: 'H.G. Wells',               language: 'en', gutenbergId: 36    },
  { id: '20000-leagues',          title: '20,000 Leagues Under the Sea',         author: 'Jules Verne',              language: 'en', gutenbergId: 164   },
  { id: 'around-world-80-days',   title: 'Around the World in Eighty Days',      author: 'Jules Verne',              language: 'en', gutenbergId: 103   },
  { id: 'tale-two-cities',        title: 'A Tale of Two Cities',                 author: 'Charles Dickens',          language: 'en', gutenbergId: 98    },
  { id: 'moby-dick',              title: 'Moby-Dick',                            author: 'Herman Melville',          language: 'en', gutenbergId: 2701  },
  { id: 'great-gatsby',           title: 'The Great Gatsby',                     author: 'F. Scott Fitzgerald',      language: 'en', gutenbergId: 64317 },
  { id: 'hamlet',                 title: 'Hamlet',                               author: 'William Shakespeare',      language: 'en', gutenbergId: 1524  },
  { id: 'romeo-juliet',           title: 'Romeo and Juliet',                     author: 'William Shakespeare',      language: 'en', gutenbergId: 1513  },
  { id: 'macbeth',                title: 'Macbeth',                              author: 'William Shakespeare',      language: 'en', gutenbergId: 1533  },
  { id: 'adventures-tom-sawyer',  title: 'The Adventures of Tom Sawyer',         author: 'Mark Twain',               language: 'en', gutenbergId: 74    },
  { id: 'adventures-huck-finn',   title: 'Adventures of Huckleberry Finn',       author: 'Mark Twain',               language: 'en', gutenbergId: 76    },
  { id: 'invisible-man',          title: 'The Invisible Man',                    author: 'H.G. Wells',               language: 'en', gutenbergId: 5230  },
  { id: 'dorian-gray',            title: 'The Picture of Dorian Gray',           author: 'Oscar Wilde',              language: 'en', gutenbergId: 174   },
  { id: 'jekyll-hyde',            title: 'Strange Case of Dr Jekyll and Mr Hyde', author: 'R.L. Stevenson',          language: 'en', gutenbergId: 43    },
  { id: 'count-monte-cristo',     title: 'The Count of Monte Cristo',            author: 'Alexandre Dumas',          language: 'en', gutenbergId: 1184  },
  { id: 'three-musketeers',       title: 'The Three Musketeers',                 author: 'Alexandre Dumas',          language: 'en', gutenbergId: 1257  },
  { id: 'little-women',           title: 'Little Women',                         author: 'Louisa May Alcott',        language: 'en', gutenbergId: 514   },
  { id: 'call-of-wild',           title: 'The Call of the Wild',                 author: 'Jack London',              language: 'en', gutenbergId: 215   },
  { id: 'treasure-island',        title: 'Treasure Island',                      author: 'Robert Louis Stevenson',   language: 'en', gutenbergId: 120   },
  { id: 'gulliver-travels',       title: "Gulliver's Travels",                   author: 'Jonathan Swift',           language: 'en', gutenbergId: 829   },
  { id: 'robinson-crusoe',        title: 'Robinson Crusoe',                      author: 'Daniel Defoe',             language: 'en', gutenbergId: 521   },
  { id: 'odyssey',                title: 'The Odyssey',                          author: 'Homer',                    language: 'en', gutenbergId: 1727  },
  { id: 'iliad',                  title: 'The Iliad',                            author: 'Homer',                    language: 'en', gutenbergId: 6130  },
  { id: 'metamorphosis',          title: 'The Metamorphosis',                    author: 'Franz Kafka',              language: 'en', gutenbergId: 5200  },
  { id: 'portrait-artist-young',  title: 'A Portrait of the Artist as a Young Man', author: 'James Joyce',          language: 'en', gutenbergId: 4217  },
  { id: 'scarlet-letter',         title: 'The Scarlet Letter',                   author: 'Nathaniel Hawthorne',      language: 'en', gutenbergId: 25344 },
  { id: 'wuthering-heights',      title: 'Wuthering Heights',                    author: 'Emily Brontë',            language: 'en', gutenbergId: 768   },
  { id: 'jane-eyre',              title: 'Jane Eyre',                            author: 'Charlotte Brontë',        language: 'en', gutenbergId: 1260  },
  { id: 'sense-sensibility',      title: 'Sense and Sensibility',                author: 'Jane Austen',              language: 'en', gutenbergId: 161   },
  { id: 'emma',                   title: 'Emma',                                 author: 'Jane Austen',              language: 'en', gutenbergId: 158   },
  { id: 'northanger-abbey',       title: 'Northanger Abbey',                     author: 'Jane Austen',              language: 'en', gutenbergId: 121   },
  { id: 'great-expectations',     title: 'Great Expectations',                   author: 'Charles Dickens',          language: 'en', gutenbergId: 1400  },
  { id: 'oliver-twist',           title: 'Oliver Twist',                         author: 'Charles Dickens',          language: 'en', gutenbergId: 730   },
  { id: 'david-copperfield',      title: 'David Copperfield',                    author: 'Charles Dickens',          language: 'en', gutenbergId: 766   },
  { id: 'red-badge-courage',      title: 'The Red Badge of Courage',             author: 'Stephen Crane',            language: 'en', gutenbergId: 73    },
  { id: 'secret-garden',          title: 'The Secret Garden',                    author: 'Frances Hodgson Burnett',  language: 'en', gutenbergId: 113   },
  { id: 'wizard-of-oz',           title: 'The Wonderful Wizard of Oz',           author: 'L. Frank Baum',            language: 'en', gutenbergId: 55    },
  { id: 'peter-pan',              title: 'Peter Pan',                            author: 'J.M. Barrie',              language: 'en', gutenbergId: 16    },

  // ── Português ─────────────────────────────────────────────────────────────
  { id: 'memorias-postumas',      title: 'Memórias Póstumas de Brás Cubas',      author: 'Machado de Assis',         language: 'pt', gutenbergId: 54829 },
  { id: 'dom-casmurro',           title: 'Dom Casmurro',                         author: 'Machado de Assis',         language: 'pt', gutenbergId: 55752 },
  { id: 'iracema',                title: 'Iracema',                              author: 'José de Alencar',          language: 'pt', gutenbergId: 37276 },
  { id: 'o-guarani',              title: 'O Guarani',                            author: 'José de Alencar',          language: 'pt', gutenbergId: 38869 },
  { id: 'quincas-borba',          title: 'Quincas Borba',                        author: 'Machado de Assis',         language: 'pt', gutenbergId: 55682 },

  // ── Espanhol ──────────────────────────────────────────────────────────────
  { id: 'don-quijote',            title: 'Don Quijote de la Mancha',             author: 'Miguel de Cervantes',      language: 'es', gutenbergId: 2000  },
  { id: 'lazarillo-tormes',       title: 'Lazarillo de Tormes',                  author: 'Anónimo',                  language: 'es', gutenbergId: 9520  },

  // ── Francês ───────────────────────────────────────────────────────────────
  { id: 'les-miserables',         title: 'Les Misérables',                       author: 'Victor Hugo',              language: 'fr', gutenbergId: 17489 },
  { id: 'le-comte-monte-cristo',  title: 'Le Comte de Monte-Cristo',             author: 'Alexandre Dumas',          language: 'fr', gutenbergId: 17989 },
  { id: 'notre-dame-paris',       title: 'Notre-Dame de Paris',                  author: 'Victor Hugo',              language: 'fr', gutenbergId: 19657 },

  // ── Alemão ────────────────────────────────────────────────────────────────
  { id: 'faust',                  title: 'Faust',                                author: 'Johann Wolfgang von Goethe', language: 'de', gutenbergId: 2229 },
  { id: 'die-leiden',             title: 'Die Leiden des jungen Werthers',       author: 'Johann Wolfgang von Goethe', language: 'de', gutenbergId: 2407 },

  // ── Italiano ──────────────────────────────────────────────────────────────
  { id: 'divina-commedia',        title: 'La Divina Commedia',                   author: 'Dante Alighieri',          language: 'it', gutenbergId: 1012  },
  { id: 'i-promessi-sposi',       title: 'I Promessi Sposi',                     author: 'Alessandro Manzoni',       language: 'it', gutenbergId: 2107  },

  // ── Russo (em inglês) ─────────────────────────────────────────────────────
  { id: 'crime-punishment',       title: 'Crime and Punishment',                 author: 'Fyodor Dostoevsky',        language: 'en', gutenbergId: 2554  },
  { id: 'brothers-karamazov',     title: 'The Brothers Karamazov',               author: 'Fyodor Dostoevsky',        language: 'en', gutenbergId: 28054 },
  { id: 'war-and-peace',          title: 'War and Peace',                        author: 'Leo Tolstoy',              language: 'en', gutenbergId: 2600  },
  { id: 'anna-karenina',          title: 'Anna Karenina',                        author: 'Leo Tolstoy',              language: 'en', gutenbergId: 1399  },
  { id: 'idiot',                  title: 'The Idiot',                            author: 'Fyodor Dostoevsky',        language: 'en', gutenbergId: 2638  },
];

// ─── Estado persistente ────────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { done: [], failed: [], lastRun: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Download Gutenberg ────────────────────────────────────────────────────────
async function downloadGutenbergText(gutenbergId) {
  // Tenta URLs em ordem de preferência
  const urls = [
    `https://www.gutenberg.org/files/${gutenbergId}/${gutenbergId}-0.txt`,
    `https://www.gutenberg.org/files/${gutenbergId}/${gutenbergId}.txt`,
    `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`,
    `https://www.gutenberg.org/ebooks/${gutenbergId}.txt.utf-8`,
  ];

  for (const url of urls) {
    try {
      logger.info(`📥 Baixando: ${url}`);
      const res = await axios.get(url, {
        timeout: 60_000,
        responseType: 'text',
        headers: { 'User-Agent': 'GENIAPublisher/2.0 (+https://genia.pub)' },
      });
      if (res.data && res.data.length > 1000) {
        logger.info(`✅ Baixado: ${(res.data.length / 1024).toFixed(0)} KB`);
        return res.data;
      }
    } catch (err) {
      logger.warn(`⚠️ Falhou ${url}: ${err.message}`);
    }
  }
  throw new Error(`Nenhuma URL funcionou para Gutenberg ID ${gutenbergId}`);
}

// ─── Remover cabeçalho/rodapé Gutenberg ───────────────────────────────────────
function stripGutenbergBoilerplate(text) {
  // Remove tudo antes de "*** START OF" e depois de "*** END OF"
  const startMatch = text.match(/\*\*\* ?START OF (?:THIS |THE )?PROJECT GUTENBERG[^\n]*\n/i);
  const endMatch   = text.match(/\*\*\* ?END OF (?:THIS |THE )?PROJECT GUTENBERG/i);

  if (startMatch) {
    text = text.slice(startMatch.index + startMatch[0].length);
  }
  if (endMatch) {
    text = text.slice(0, text.search(/\*\*\* ?END OF (?:THIS |THE )?PROJECT GUTENBERG/i));
  }

  // Remove Produced by / transcribed by lines
  text = text.replace(/^(Produced by|Transcribed by|Digitized by)[^\n]*\n/gim, '');
  // Remove múltiplas linhas em branco
  text = text.replace(/\n{4,}/g, '\n\n\n');

  return text.trim();
}

// ─── Parser de capítulos ───────────────────────────────────────────────────────
function parseChapters(rawText, bookTitle) {
  // Padrões de cabeçalho de capítulo — ordenados por especificidade
  const chapterPatterns = [
    /^CHAPTER\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^Chapter\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/m,
    /^CAPITULO\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^Chapitre\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^Kapitel\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^Capitolo\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^PART\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^ACT\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^BOOK\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^SCENE\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^SECTION\s+([\dIVXLCivxlc]+)[.\s]*(.{0,80})$/im,
    /^(\d+)\.\s+([A-Z][^\n]{5,80})$/m,   // "1. TITLE"
    /^([IVX]+)\.\s+([A-Z][^\n]{5,80})$/m, // "I. TITLE"
  ];

  // Tentar cada padrão e usar o que encontrar mais splits
  let bestSplit = null;
  let bestCount = 0;

  for (const pattern of chapterPatterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const matches = [...rawText.matchAll(global)];
    if (matches.length > bestCount && matches.length > 1) {
      bestCount = matches.length;
      bestSplit = { pattern: global, matches };
    }
  }

  const chapters = [];

  if (!bestSplit || bestSplit.matches.length < 2) {
    // Sem capítulos detectados — tratar texto todo como um único capítulo longo
    logger.warn(`⚠️ Nenhum padrão de capítulo encontrado — usando texto único`);
    const trimmed = rawText.trim().slice(0, MAX_CHARS);
    chapters.push({ number: 1, title: bookTitle, content: trimmed });
    return chapters;
  }

  // Dividir pelo padrão encontrado
  const { matches } = bestSplit;
  for (let i = 0; i < matches.length && i < MAX_CHAPTERS; i++) {
    const match = matches[i];
    const chNum = match[1] || String(i + 1);
    const chTitle = (match[2] || '').trim() || `Chapter ${chNum}`;
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const content = rawText.slice(start, end).trim();

    if (content.length < 50) continue; // Capítulo vazio — pular

    // Limitar tamanho de cada capítulo
    chapters.push({
      number: i + 1,
      title: chTitle.replace(/\s+/g, ' ').slice(0, 100),
      content: content.slice(0, Math.floor(MAX_CHARS / Math.min(matches.length, MAX_CHAPTERS))),
    });
  }

  logger.info(`📚 Capítulos parseados: ${chapters.length}`);
  return chapters;
}

// ─── Extrair introdução ────────────────────────────────────────────────────────
function extractIntroduction(rawText, chapters) {
  if (!chapters.length) return '';
  // Texto antes do primeiro capítulo
  const firstChapterIdx = rawText.indexOf(chapters[0].content.slice(0, 100));
  if (firstChapterIdx > 200) {
    return rawText.slice(0, firstChapterIdx).trim().slice(0, 2000);
  }
  return '';
}

// ─── Converter para estrutura ebook ───────────────────────────────────────────
function buildEbookStructure(bookDef, rawText) {
  const clean = stripGutenbergBoilerplate(rawText);
  const chapters = parseChapters(clean, bookDef.title);
  const intro = extractIntroduction(clean, chapters);

  // Calcular total de chars para log
  const totalChars = chapters.reduce((acc, ch) => acc + ch.content.length, 0);
  logger.info(`📊 "${bookDef.title}": ${chapters.length} capítulos, ${totalChars.toLocaleString()} chars`);

  return {
    title:        bookDef.title,
    subtitle:     `by ${bookDef.author}`,
    author:       bookDef.author,
    language:     bookDef.language,
    introduction: intro,
    chapters,
    conclusion:   '',
  };
}

// ─── Gerar audiobook de um livro ──────────────────────────────────────────────
async function processBook(book, state) {
  const outPath = path.join(AUDIOBOOKS_DIR, `gutenberg-${book.id}.mp3`);

  // Já existe?
  if (fs.existsSync(outPath)) {
    logger.info(`✅ Já existe: gutenberg-${book.id}.mp3`);
    if (!state.done.includes(book.id)) {
      state.done.push(book.id);
      saveState(state);
    }
    return 'exists';
  }

  // Já falhou recentemente?
  const failEntry = state.failed.find(f => f.id === book.id);
  if (failEntry) {
    const hoursSinceFail = (Date.now() - failEntry.ts) / 3_600_000;
    if (hoursSinceFail < 24) {
      logger.info(`⏭️ "${book.title}" falhou há ${hoursSinceFail.toFixed(1)}h — pulando`);
      return 'skip';
    }
    // Remover da lista de falhas para retry
    state.failed = state.failed.filter(f => f.id !== book.id);
  }

  logger.info(`\n📖 Processando: "${book.title}" [${book.language}] (Gutenberg #${book.gutenbergId})`);

  try {
    const rawText = await downloadGutenbergText(book.gutenbergId);
    const ebook = buildEbookStructure(book, rawText);

    if (!ebook.chapters.length) {
      throw new Error('Nenhum capítulo extraído');
    }

    const result = await generateAudiobook(ebook, `gutenberg-${book.id}`);
    if (result) {
      state.done.push(book.id);
      saveState(state);
      logger.info(`🎉 Audiobook gerado: ${path.basename(result)}`);
      return 'generated';
    }
    throw new Error('generateAudiobook retornou null');

  } catch (err) {
    logger.error(`❌ "${book.title}" falhou: ${err.message}`);
    state.failed.push({ id: book.id, ts: Date.now(), error: err.message });
    saveState(state);
    return 'error';
  }
}

// ─── MAIN: Gerar todos os audiobooks (um por vez) ─────────────────────────────
async function generateAllFamousAudiobooks() {
  if (!isAvailable()) {
    logger.warn('⚠️ ElevenLabs não disponível — defina ELEVENLABS_API_KEY');
    return;
  }

  fs.mkdirSync(AUDIOBOOKS_DIR, { recursive: true });
  const state = loadState();
  state.lastRun = new Date().toISOString();

  // Filtrar livros pendentes
  const pending = FAMOUS_BOOKS.filter(b => !state.done.includes(b.id));
  logger.info(`\n🌍 GENIA Famous Audiobooks`);
  logger.info(`   Total: ${FAMOUS_BOOKS.length} livros | Prontos: ${state.done.length} | Pendentes: ${pending.length}`);

  if (!pending.length) {
    logger.info('✅ Todos os audiobooks já foram gerados!');
    return;
  }

  let generated = 0;
  let errors = 0;

  for (const book of pending) {
    const result = await processBook(book, state);
    if (result === 'generated') generated++;
    if (result === 'error') errors++;

    // Delay entre livros para não sobrecarregar ElevenLabs
    if (result !== 'exists' && result !== 'skip' && pending.indexOf(book) < pending.length - 1) {
      logger.info(`⏳ Aguardando ${DELAY_BETWEEN / 1000}s antes do próximo livro...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN));
    }
  }

  logger.info(`\n📊 Sessão concluída: ${generated} gerados, ${errors} erros, ${state.done.length}/${FAMOUS_BOOKS.length} total`);
}

// ─── Gerar apenas um livro específico ─────────────────────────────────────────
async function generateSingleBook(bookIdOrTitle) {
  const book = FAMOUS_BOOKS.find(b =>
    b.id === bookIdOrTitle ||
    b.title.toLowerCase().includes(bookIdOrTitle.toLowerCase())
  );
  if (!book) {
    throw new Error(`Livro não encontrado: "${bookIdOrTitle}". IDs disponíveis: ${FAMOUS_BOOKS.map(b => b.id).join(', ')}`);
  }

  fs.mkdirSync(AUDIOBOOKS_DIR, { recursive: true });
  const state = loadState();
  return processBook(book, state);
}

// ─── Listar catálogo ──────────────────────────────────────────────────────────
function listCatalog() {
  const state = loadState();
  return FAMOUS_BOOKS.map(b => ({
    id:          b.id,
    title:       b.title,
    author:      b.author,
    language:    b.language,
    status:      state.done.includes(b.id)
                   ? 'done'
                   : state.failed.find(f => f.id === b.id)
                     ? 'failed'
                     : 'pending',
    mp3:         fs.existsSync(path.join(AUDIOBOOKS_DIR, `gutenberg-${b.id}.mp3`))
                   ? `/audiobooks/gutenberg-${b.id}.mp3`
                   : null,
  }));
}

module.exports = {
  generateAllFamousAudiobooks,
  generateSingleBook,
  listCatalog,
  FAMOUS_BOOKS,
};

// ─── CLI: node gutenbergAgent.js [bookId] ─────────────────────────────────────
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === 'list') {
    const catalog = listCatalog();
    console.table(catalog.map(b => ({ id: b.id, title: b.title, lang: b.language, status: b.status })));
    process.exit(0);
  }

  const fn = arg ? generateSingleBook(arg) : generateAllFamousAudiobooks();
  fn.then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
