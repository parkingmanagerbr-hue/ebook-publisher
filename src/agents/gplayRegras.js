'use strict';
/**
 * gplayRegras.js — o que decide, antes do navegador, quem vai para o Google
 * Play Livros e com que dados.
 *
 * A conta (Partner Center) esta em "preliminary policy review" desde
 * 13/10/2026, com UM livro enviado. A primeira impressao da conta conta: o
 * Google reprova por capa com titulo diferente do cadastro, alegacao sem
 * lastro e link para conteudo pago fora da loja. Por isso a fila e estreita e
 * o ritmo e baixo — e cada trava aqui tem teste.
 *
 * Tudo puro.
 */
const { PROMESSA_SEM_LASTRO } = require('./coverPackaging');

/** Teto padrao por dia (GPLAY_TETO_DIA). */
const TETO_DIA_PADRAO = 2;
/** Preco padrao da loja para livro avulso (o mesmo do primeiro livro). */
const PRECO_PADRAO = '4.99';
/** Descricao que sobra menor que isto nao vai: pagina rasa e o que o Google reprova. */
const MINIMO_DESCRICAO = 200;
/** Reprovacoes seguidas que param a loja. */
const MAX_REPROVACOES_SEGUIDAS = 3;

/**
 * Nome do idioma como a lista do Google escreve (medido no autocomplete em
 * 13/10/2026: o holandes e "Dutch; Flemish"). Japones e chines ficam de fora:
 * a capa com o titulo e escrita com DejaVu, que nao tem esses caracteres.
 */
const IDIOMAS = {
  pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', nl: 'Dutch; Flemish', pl: 'Polish',
};

/** Idioma do Google para o livro, ou null (nao publica). */
function idiomaGoogle(language) {
  const k = String(language == null ? '' : language).slice(0, 2).toLowerCase();
  return IDIOMAS[k] || null;
}

/**
 * Codigos BISAC com o rotulo EXATO da opcao (os 76 conferidos no autocomplete
 * em 13/10/2026). O fluxo digita o codigo e clica a opcao que comeca por
 * "(CODIGO)".
 */
const BISAC = {
  BUS000000: 'Business & Economics / General',
  BUS050000: 'Business & Economics / Personal Finance / General',
  BUS050030: 'Business & Economics / Personal Finance / Money Management',
  BUS036000: 'Business & Economics / Investments & Securities / General',
  BUS025000: 'Business & Economics / Entrepreneurship',
  BUS043000: 'Business & Economics / Marketing / General',
  BUS090000: 'Business & Economics / E-Commerce / General',
  BUS058000: 'Business & Economics / Sales & Selling / General',
  BUS071000: 'Business & Economics / Leadership',
  BUS037020: 'Business & Economics / Careers / Job Hunting',
  BUS012000: 'Business & Economics / Careers / General',
  BUS107000: 'Business & Economics / Personal Success',
  SEL000000: 'Self-Help / General',
  SEL027000: 'Self-Help / Personal Growth / Success',
  SEL016000: 'Self-Help / Personal Growth / Happiness',
  SEL024000: 'Self-Help / Self-Management / Stress Management',
  SEL036000: 'Self-Help / Anxieties & Phobias',
  SEL035000: 'Self-Help / Self-Management / Time Management',
  SEL023000: 'Self-Help / Personal Growth / Self-Esteem',
  HEA000000: 'Health & Fitness / General',
  HEA017000: 'Health & Fitness / Diet & Nutrition / Nutrition',
  HEA019000: 'Health & Fitness / Diet & Nutrition / Weight Loss',
  HEA007000: 'Health & Fitness / Exercise / General',
  HEA041000: 'Health & Fitness / Pregnancy & Childbirth',
  HEA024000: "Health & Fitness / Women's Health",
  CKB000000: 'Cooking / General',
  CKB039000: 'Cooking / Health & Healing / General',
  CKB070000: 'Cooking / Methods / Quick & Easy',
  CKB086000: 'Cooking / Vegetarian',
  CKB125000: 'Cooking / Vegan',
  CKB025000: 'Cooking / Health & Healing / Diabetic & Sugar-Free',
  CKB111000: 'Cooking / Health & Healing / Gluten-Free',
  TRV000000: 'Travel / General',
  TRV033000: 'Travel / Special Interest / Budget',
  TRV024020: 'Travel / South America / Brazil',
  FAM000000: 'Family & Relationships / General',
  FAM034000: 'Family & Relationships / Parenting / General',
  FAM029000: 'Family & Relationships / Love & Romance',
  REL000000: 'Religion / General',
  REL012000: 'Religion / Christian Living / General',
  REL012020: 'Religion / Christian Living / Devotional',
  OCC000000: 'Body, Mind & Spirit / General',
  COM000000: 'Computers / General',
  COM004000: 'Computers / Artificial Intelligence / General',
  COM060000: 'Computers / Internet / General',
  EDU000000: 'Education / General',
  STU000000: 'Study Aids / General',
  FOR000000: 'Language Study / General',
  HOM000000: 'House & Home / General',
  GAR000000: 'Gardening / General',
  PET000000: 'Pets / General',
  CRA000000: 'Crafts & Hobbies / General',
  SPO000000: 'Sports & Recreation / General',
  MUS000000: 'Music / General',
  PHO000000: 'Photography / General',
  LAW000000: 'Law / General',
  PSY000000: 'Psychology / General',
  MED058000: 'Medical / Nursing / General',
  TEC000000: 'Technology & Engineering / General',
  DES000000: 'Design / General',
};

/**
 * Regras topico/titulo -> dois codigos, do mais especifico ao mais geral. A
 * ordem da lista importa: a primeira regra que casa vence (o especifico vem
 * antes). Na duvida, o General da area.
 */
const REGRAS_BISAC = [
  [/brasil|brazil/i, /viag|viaj|turism|travel|trip/i, ['TRV024020', 'TRV033000']],
  [/viag|viaj|turism|travel|trip|mochil/i, null, ['TRV033000', 'TRV000000']],
  [/intelig[eê]ncia artificial|\bia\b|\bai\b|chatgpt|artificial intelligence/i, /dinheiro|renda|ganhar|money|income|neg[oó]cio/i, ['COM004000', 'BUS025000']],
  [/intelig[eê]ncia artificial|\bia\b|\bai\b|chatgpt|artificial intelligence/i, null, ['COM004000', 'COM000000']],
  [/tesouro|investi|a[cç][oõ]es|bolsa|dividend|cripto|bitcoin|renda fixa|stock/i, null, ['BUS036000', 'BUS050000']],
  [/d[ií]vida|nome sujo|limpar o nome|or[cç]amento|finan[cç]|dinheiro|poupar|economizar|money|budget/i, null, ['BUS050030', 'BUS050000']],
  [/entrevista|curr[ií]culo|emprego|carreira|job|resume|career/i, null, ['BUS037020', 'BUS012000']],
  [/vend(a|as|er)|sales|selling/i, null, ['BUS058000', 'BUS000000']],
  [/marketing|instagram|tiktok|redes sociais|youtube|afiliad/i, null, ['BUS043000', 'BUS090000']],
  [/empreend|neg[oó]cio|startup|freelanc|renda extra|business/i, null, ['BUS025000', 'BUS000000']],
  [/lideran|leader/i, null, ['BUS071000', 'BUS000000']],
  [/vegan/i, null, ['CKB125000', 'CKB000000']],
  [/vegetarian/i, null, ['CKB086000', 'CKB000000']],
  [/sem gl[uú]ten|gluten/i, null, ['CKB111000', 'CKB039000']],
  [/diab[eé]t|sem a[cç][uú]car|sugar/i, null, ['CKB025000', 'CKB039000']],
  [/receita|culin[aá]ri|cozinh|marmita|card[aá]pio|recipe|cook/i, null, ['CKB070000', 'CKB000000']],
  [/emagre|perder peso|weight loss/i, null, ['HEA019000', 'HEA000000']],
  [/gravidez|gesta[cç]|gr[aá]vida|pregnan/i, null, ['HEA041000', 'HEA000000']],
  [/nutri[cç]|alimenta[cç]|dieta|nutrition|diet/i, null, ['HEA017000', 'HEA000000']],
  [/exerc[ií]c|treino|muscula|academia|fitness|workout/i, null, ['HEA007000', 'HEA000000']],
  [/enfermag|nursing/i, null, ['MED058000', 'STU000000']],
  [/ansiedade|anxiety|p[aâ]nico/i, null, ['SEL036000', 'SEL000000']],
  [/estresse|stress|burnout/i, null, ['SEL024000', 'SEL000000']],
  [/tempo|produtiv|procrastin|time management/i, null, ['SEL035000', 'SEL000000']],
  [/autoestima|self-esteem|confian[cç]a/i, null, ['SEL023000', 'SEL000000']],
  [/felicidade|happiness|gratid/i, null, ['SEL016000', 'SEL000000']],
  [/intelig[eê]ncia emocional|h[aá]bito|disciplina|sucesso|mentalidade|motiva|success|habit/i, null, ['SEL027000', 'SEL000000']],
  [/filho|crian[cç]|beb[eê]|parent|maternidade|paternidade/i, null, ['FAM034000', 'FAM000000']],
  [/amor|relacionamento|casamento|reconquist|namoro|romance|love/i, null, ['FAM029000', 'FAM000000']],
  [/devocional|devotional|ora[cç][aã]o|b[ií]blia|bible/i, null, ['REL012020', 'REL012000']],
  [/deus|f[eé] crist|igreja|crist[aã]o|christian|god/i, null, ['REL012000', 'REL000000']],
  [/medita[cç]|espiritual|chakra|spiritual/i, null, ['OCC000000', 'SEL000000']],
  [/pet|cachorro|c[aã]o|gato|dog|cat/i, null, ['PET000000', 'BUS025000']],
  [/jardim|horta|plantas|garden/i, null, ['GAR000000', 'HOM000000']],
  [/casa|organiza[cç][aã]o|limpeza|decora|home/i, null, ['HOM000000', 'SEL000000']],
  [/idioma|ingl[eê]s|espanhol|language|english|spanish/i, null, ['FOR000000', 'EDU000000']],
  [/concurso|vestibular|enem|estudo|exam|study/i, null, ['STU000000', 'EDU000000']],
  [/fotograf|photograph/i, null, ['PHO000000', 'DES000000']],
  [/m[uú]sica|viol[aã]o|guitar|music/i, null, ['MUS000000', 'EDU000000']],
  [/artesanato|croch[eê]|tric[oô]|craft/i, null, ['CRA000000', 'BUS025000']],
  [/esporte|corrida|futebol|sport|running/i, null, ['SPO000000', 'HEA007000']],
  [/direito|lei\b|jur[ií]dic|law/i, null, ['LAW000000', 'BUS000000']],
  [/psicolog|psychology/i, null, ['PSY000000', 'SEL000000']],
  [/les[aãõo]+e?s?\b|preven[cç][aã]o|ergonom|seguran[cç]a no trabalho|injur/i, null, ['HEA000000', 'SEL000000']],
  [/sa[uú]de|health/i, null, ['HEA000000', 'SEL000000']],
  [/programa|software|computador|internet|site|app\b|tecnolog/i, null, ['COM060000', 'COM000000']],
];

/** Os dois generos do livro: [{codigo, rotulo}], sempre dois e sempre da tabela. */
function generosDoLivro(topico, titulo) {
  const texto = String(topico || '') + ' ' + String(titulo || '');
  for (const [a, b, codigos] of REGRAS_BISAC) {
    if (a.test(texto) && (!b || b.test(texto))) return codigos.map(c => ({ codigo: c, rotulo: BISAC[c] }));
  }
  return ['SEL000000', 'EDU000000'].map(c => ({ codigo: c, rotulo: BISAC[c] }));
}

/** O texto da opcao do autocomplete que corresponde ao codigo. */
function opcaoDoGenero(codigo) {
  return '(' + codigo + ') ' + BISAC[codigo];
}

// ── texto ao leitor ──────────────────────────────────────────────────────────

/**
 * Frase com alegacao que o livro nao prova. A lista de capa (PROMESSA_SEM_LASTRO)
 * cobre credencial, percentual e "mais vendido"; aqui entra o que aparece em
 * descricao: "testadas por especialistas", "viajantes experientes", "garante",
 * "o melhor" — e autoria por IA, que nunca e dita ao leitor. Fronteira por
 * LETRA Unicode: a barra-b nao trata "ã" como letra.
 */
const ALEGACAO_DESCRICAO = new RegExp([
  'testad[oa]s?\\s+(e\\s+aprovad[oa]s?\\s+)?por', 'tested\\s+by', 'probad[oa]s?\\s+por',
  'especialistas?', 'experts?', 'expertos?', 'viajantes?\\s+experientes?', 'experienced\\s+travel',
  'garant', 'guarant', 'comprovad', 'cient[ií]fic', 'scientific', 'proven',
  '(?<!\\p{L})(o|a|os|as)\\s+melhor(es)?(?!\\p{L})', '(?<!\\p{L})the\\s+best(?!\\p{L})', '(?<!\\p{L})(el|la|los|las)\\s+mejor(es)?(?!\\p{L})',
  '#\\s?1(?!\\d)', 'n[uú]mero\\s+1(?!\\d)', 'number\\s+one',
  '\\d+\\s*%',
  '(gerad|escrit|criad|produzid|feit)[oa]s?\\s+(por|com)\\s+(uma?\\s+)?(ia|intelig[eê]ncia\\s+artificial)(?!\\p{L})',
  '(generated|written|created)\\s+(by|with)\\s+(an?\\s+)?(ai|artificial\\s+intelligence)(?!\\p{L})',
].join('|'), 'iu');

/**
 * Tira da descricao as frases com alegacao sem lastro. Devolve o texto limpo
 * e quantas frases sairam (vai para o log). Pura.
 */
function limparDescricao(texto) {
  let removidas = 0;
  const paragrafos = String(texto == null ? '' : texto).split(/\n{2,}/).map(p => {
    const frases = p.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
    const ficam = frases.filter(f => {
      const ruim = ALEGACAO_DESCRICAO.test(f) || PROMESSA_SEM_LASTRO.test(f);
      if (ruim) removidas++;
      return !ruim;
    });
    return ficam.join(' ');
  }).filter(Boolean);
  return { texto: paragrafos.join('\n\n'), removidas };
}

/** Titulo com promessa numerica sem lastro ("+50%", "em 7 dias"). Pura. */
const PROMESSA_NO_TITULO = /\d+\s*%|\+\s?\d|(?<!\p{L})(em|in|en)\s+\d+\s+(dias?|semanas?|horas?|minutos?|days?|weeks?|hours?|minutes?|d[ií]as)(?!\p{L})|\d+\s?x\s+(mais|more|m[aá]s)|R\$\s?\d/iu;
function tituloComPromessa(titulo) {
  const t = String(titulo == null ? '' : titulo);
  return PROMESSA_NO_TITULO.test(t) || PROMESSA_SEM_LASTRO.test(t);
}

/**
 * O livro pode ir para o Google Play? null quando pode, ou o motivo. Pura —
 * quem confere disco e o script (`temPdf`, `temCapa`).
 */
function motivoParaNaoPublicar(livro, { temPdf = true, temCapa = true } = {}) {
  const l = livro || {};
  if (l.combo_de) return 'combo';
  if (l.audio_de) return 'audiolivro';
  if (!String(l.title || '').trim()) return 'sem-titulo';
  if (!idiomaGoogle(l.language)) return 'idioma-sem-mapeamento';
  if (!temPdf) return 'sem-pdf';
  if (!temCapa) return 'sem-capa';
  if (tituloComPromessa(l.title) || tituloComPromessa(l.subtitle)) return 'titulo-com-promessa';
  if (limparDescricao(l.description).texto.length < MINIMO_DESCRICAO) return 'descricao-curta';
  return null;
}

/**
 * Ordem da fila: rascunho ja aberto (retoma antes de criar outro), depois quem
 * teve venda real, depois portugues com texto guardado, depois o resto — e,
 * dentro de cada grupo, o mais recente. Pura.
 */
function ordenarFila(livros, { vendidos = new Set(), comTexto = new Set() } = {}) {
  const peso = l => (l.gplay_id ? 0 : vendidos.has(l.id) ? 1 : (/^pt/i.test(l.language || '') && comTexto.has(l.id)) ? 2 : 3);
  return [...(livros || [])].filter(Boolean).sort((a, b) => peso(a) - peso(b) || (Number(b.rowid) || 0) - (Number(a.rowid) || 0));
}

/** Ainda cabe publicar hoje? */
function cabeHoje(publicadosHoje, teto = TETO_DIA_PADRAO) {
  const t = Number(teto);
  return Number(publicadosHoje) < (Number.isFinite(t) && t >= 0 ? t : TETO_DIA_PADRAO);
}

/** Data do dia no fuso do negocio (o VPS esta em hora europeia). */
function diaDoNegocio(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

// ── leitura do Partner Center ────────────────────────────────────────────────

/**
 * Estado do livro pela pagina de revisao (#book/<id>/review). "Your book is
 * not live" foi o que apareceu em 13/10/2026. Pagina que nao diz nenhum dos
 * dois e 'desconhecido' — e desconhecido BLOQUEIA o portao. Pura.
 */
function estadoNaRevisao(texto) {
  const t = String(texto || '');
  if (/your book is not live/i.test(t)) return /reject|not approved|declined|violat|takedown|removed/i.test(t.replace(/your account is not yet approved/ig, '')) ? 'reprovado' : 'em-revisao';
  if (/your book is live|live on google play|view on google play/i.test(t)) return 'live';
  return 'desconhecido';
}

/** Estado pela coluna Status da lista ("sync Pending account review"). Pura. */
function estadoNaLista(status) {
  const s = String(status || '');
  if (/reject|not approved|declined|suspend|takedown|removed|violat/i.test(s)) return 'reprovado';
  if (/pending|review|processing/i.test(s)) return 'em-revisao';
  if (/draft|not published|unpublished|incomplete/i.test(s)) return 'rascunho';
  if (/live|on sale|published/i.test(s)) return 'live';
  return 'desconhecido';
}

/** GGKEY de um texto (URL do editor, linha da lista). Pura. */
function ggkeyDe(texto) {
  const m = /GGKEY:[A-Z0-9]{6,20}/.exec(String(texto || ''));
  return m ? m[0] : null;
}

/**
 * Pagina publica do livro. O id publico NAO e o GGKEY: so vale o link que a
 * propria loja mostra quando o livro fica no ar. Pura.
 */
const URL_PUBLICA = /^https:\/\/play\.google\.com\/store\/books\/details\?id=([A-Za-z0-9_-]{6,40})(?:&.*)?$/;
function urlPublicaDe(href) {
  const m = URL_PUBLICA.exec(String(href || '').trim());
  return m ? 'https://play.google.com/store/books/details?id=' + m[1] : null;
}

/**
 * Reprovacoes SEGUIDAS no fim do historico (do mais antigo ao mais novo). Um
 * livro aprovado zera a sequencia. Pura.
 */
function reprovacoesSeguidas(resultados) {
  let n = 0;
  for (const r of resultados || []) n = r === 'reprovado' ? n + 1 : r === 'live' ? 0 : n;
  return n;
}

/** A pagina caiu na tela de login/escolha de conta do Google? Pura. */
function pedeLogin(url) {
  return /^https:\/\/accounts\.google\.com\//.test(String(url || ''));
}

/**
 * Estado dos arquivos pela aba Content. O Google processa o PDF depois do
 * envio, e demora: medido em 13/10/2026, 11 minutos depois ainda era "Pending
 * content ... Completed step 5 of 6". Arquivo em processamento NAO e reenviado
 * (seria outra versao do mesmo livro) e o Publish espera o "Processed". Pura.
 */
function estadoDoConteudo(texto) {
  const t = String(texto || '');
  const capa = /_frontcover\.(jpe?g|png)/i.test(t);
  const pend = t.indexOf('Pending content');
  const proc = t.indexOf('Processed content');
  const trecho = (i) => (i < 0 ? '' : t.slice(i, t.indexOf('Cover files', i) > i ? t.indexOf('Cover files', i) : undefined));
  const processado = trecho(proc);
  const pendente = trecho(pend);
  if (/\.pdf\b/i.test(processado) && /\bSuccess\b/.test(processado)) return { pdf: 'processado', capa };
  if (/\.pdf\b/i.test(pendente) && /\b(fail|error|rejected)/i.test(pendente)) return { pdf: 'falhou', capa, detalhe: pendente.slice(0, 200) };
  if (/\.pdf\b/i.test(pendente)) return { pdf: 'processando', capa, detalhe: (/Completed step \d+ of \d+/.exec(pendente) || [''])[0] };
  if (/\.pdf\b/i.test(processado)) return { pdf: 'falhou', capa, detalhe: processado.slice(0, 200) };
  return { pdf: 'ausente', capa };
}

/**
 * O que a rodada faz, antes de abrir qualquer livro. Pura.
 *   parar         — 3 reprovacoes seguidas: ninguem publica ate revisar;
 *   esperar-conta — o livro do portao nao esta no ar (inclui 'desconhecido':
 *                   nao conseguir ler o estado nunca libera);
 *   teto          — o dia ja teve os livros que cabiam;
 *   publicar      — com `vagas` livros.
 * O dry-run percorre ate o Review sem publicar, entao ignora portao e teto —
 * mas nao ignora a parada por reprovacao.
 */
function decidirRodada({ seguidas = 0, portao, seco = false, hoje = 0, teto = TETO_DIA_PADRAO, limite = 1 } = {}) {
  if (seguidas >= MAX_REPROVACOES_SEGUIDAS) return { acao: 'parar', vagas: 0 };
  if (seco) return { acao: 'publicar', vagas: Math.max(0, Number(limite) || 1) };
  if (portao !== 'live') return { acao: 'esperar-conta', vagas: 0 };
  if (!cabeHoje(hoje, teto)) return { acao: 'teto', vagas: 0 };
  return { acao: 'publicar', vagas: Math.max(0, Math.min(Number(limite) || 1, Number(teto) - Number(hoje))) };
}

/**
 * Livro com o mesmo titulo achado na LISTA da conta (o banco nao tinha o
 * GGKEY). So rascunho e adotado para continuar; livro ja enviado ou no ar NUNCA
 * e editado de novo — so tem o estado registrado. Estado ilegivel nao e tocado.
 * Pura: devolve { acao: 'adotar' | 'registrar' | 'ignorar', estado }.
 */
function oQueFazerComAchado(status) {
  const estado = estadoNaLista(status);
  if (estado === 'rascunho') return { acao: 'adotar', estado };
  if (estado === 'desconhecido') return { acao: 'ignorar', estado };
  return { acao: 'registrar', estado: estado === 'em-revisao' ? 'enviado' : estado };
}

module.exports = {
  pedeLogin, estadoDoConteudo, decidirRodada, oQueFazerComAchado,
  TETO_DIA_PADRAO, PRECO_PADRAO, MINIMO_DESCRICAO, MAX_REPROVACOES_SEGUIDAS, IDIOMAS, BISAC, REGRAS_BISAC,
  idiomaGoogle, generosDoLivro, opcaoDoGenero, ALEGACAO_DESCRICAO, limparDescricao, tituloComPromessa,
  motivoParaNaoPublicar, ordenarFila, cabeHoje, diaDoNegocio, estadoNaRevisao, estadoNaLista, ggkeyDe,
  urlPublicaDe, reprovacoesSeguidas,
};
