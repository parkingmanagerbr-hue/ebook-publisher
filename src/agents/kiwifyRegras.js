'use strict';
/**
 * kiwifyRegras.js — decisoes puras da publicacao na Kiwify.
 *
 * Medido na conta real em 22/09/2026 (ver docs/kiwify.md): a API do painel e
 * `admin-api.kiwify.com.br`, o produto nasce com
 * `POST /v1/products {name, price, payment_type:'charge', type:'club', currency}`
 * e o preco vai em CENTAVOS. Aqui fica so o que da para decidir sem rede.
 */

/** Categorias do painel (valor do <select>), lidas da propria tela. */
const CATEGORIAS = {
  saude: 0, financas: 1, relacionamentos: 2, negocios: 3, espiritualidade: 4,
  sexualidade: 5, entretenimento: 6, culinaria: 7, idiomas: 8, direito: 9,
  apps: 10, literatura: 11, casa: 12, desenvolvimento: 13, moda: 14,
  animais: 15, educacional: 16, hobbies: 17, internet: 18, ecologia: 19,
  musica: 20, ti: 21, empreendedorismo: 22, outros: 23,
};

/**
 * Nome de cada categoria como o painel mostra (o mesmo texto da Cakto, o que
 * deixa a mesma regra servir as duas lojas pelo nome).
 */
const NOMES_CATEGORIA = {
  0: 'Saúde e Esportes', 1: 'Finanças e Investimentos', 2: 'Relacionamentos', 3: 'Negócios e Carreira',
  4: 'Espiritualidade', 5: 'Sexualidade', 6: 'Entretenimento', 7: 'Culinária e Gastronomia', 8: 'Idiomas',
  9: 'Direito', 10: 'Apps & Software', 11: 'Literatura', 12: 'Casa e Construção', 13: 'Desenvolvimento Pessoal',
  14: 'Moda e Beleza', 15: 'Animais e Plantas', 16: 'Educacional', 17: 'Hobbies', 18: 'Internet',
  19: 'Ecologia e Meio Ambiente', 20: 'Música e Artes', 21: 'Tecnologia da Informação', 22: 'Empreendedorismo Digital', 23: 'Outros',
};

const REGRAS_CATEGORIA = [
  [CATEGORIAS.financas, /finan[cç]|cripto|bitcoin|patrimon|dinheiro|investi|renda|divida|d[ií]vida|or[çc]amento|aposentad|cr[ée]dito|econom/i],
  [CATEGORIAS.saude, /sa[úu]de|sono|dieta|alimenta|nutri|emagrec|fitness|exerc[íi]cio|muscula|ansiedade|depress|medita|yoga|bem[- ]estar|mindfulness/i],
  [CATEGORIAS.ti, /programa|c[óo]digo|python|javascript|docker|linux|devops|banco de dados|algoritmo|intelig[êe]ncia artificial|\bia\b|machine learning|data science/i],
  [CATEGORIAS.apps, /aplicativo|software|\bapp\b|saas|no[- ]code|planilha|excel|notion/i],
  [CATEGORIAS.internet, /marketing digital|redes sociais|instagram|tiktok|youtube|seo|tr[áa]fego|an[úu]ncio/i],
  [CATEGORIAS.empreendedorismo, /empreend|neg[óo]cio pr[óo]prio|startup|franquia|loja virtual|e-?commerce|infoproduto/i],
  [CATEGORIAS.negocios, /neg[óo]cio|carreira|gest[ãa]o|lideran|vendas|produtiv|equipe|rh\b|recrutamento|clientes?/i],
  [CATEGORIAS.culinaria, /receita|culin[áa]ria|cozinha|card[áa]pio|gastronom|confeitar|p[ãa]o\b/i],
  [CATEGORIAS.animais, /pet\b|c[ãa]o|cachorro|gato|planta|jardim|horta|aqu[áa]rio/i],
  [CATEGORIAS.casa, /reforma|constru|decora|marcenaria|el[ée]trica|hidr[áa]ulica|casa pr[óo]pria/i],
  [CATEGORIAS.idiomas, /ingl[êe]s|espanhol|franc[êe]s|alem[ãa]o|idioma|gram[áa]tica|vocabul/i],
  [CATEGORIAS.direito, /direito|jur[íi]dic|advog|lei\b|contrato|tribut[áa]ri/i],
  [CATEGORIAS.educacional, /professor|sala de aula|escola|ensino|aprendiz|estudo|concurso|vestibular/i],
  [CATEGORIAS.ecologia, /sustentab|ambient|reciclag|ecolog|clim[áa]tic|energia solar/i],
  [CATEGORIAS.musica, /m[úu]sica|viol[ãa]o|piano|canto|desenho|pintura|fotografia|\bartes?\b/i],
  [CATEGORIAS.moda, /moda|beleza|maquiagem|cabelo|estilo|guarda-roupa/i],
  [CATEGORIAS.relacionamentos, /relacionament|casamento|namoro|fam[íi]lia|filhos|maternidade|paternidade/i],
  [CATEGORIAS.espiritualidade, /espiritual|f[ée]\b|or[aá][çc][ãa]o|b[íi]blic|budis|tar[ôo]/i],
  [CATEGORIAS.hobbies, /hobby|viagem|viajar|jogo|xadrez|pesca|colecion/i],
  [CATEGORIAS.literatura, /romance|conto|poesia|literatura|fic[çc][ãa]o/i],
  [CATEGORIAS.desenvolvimento, /h[áa]bito|foco|disciplina|autoestima|organiza|rotina|prop[óo]sito|desenvolvimento pessoal/i],
];

/**
 * Segunda rodada, so para o que a primeira nao reconhece. 06/10/2026: 178 de
 * 783 livros da Kiwify (23%) caiam em "Outros" e o dono via como "sem
 * categoria". Ficam DEPOIS para nao mudar a categoria de quem ja tinha uma.
 * O tema esta em portugues em todos os livros, inclusive os estrangeiros.
 */
const REGRAS_CATEGORIA_2 = [
  [CATEGORIAS.culinaria, /refei[çc]/i],
  [CATEGORIAS.saude, /suplement|atleta|triatl|corredor|corrida|les[õo]es|les[ãa]o|pele|dermat|respira|press[ãa]o arterial|hipertens|cardio|fisioterap|postura|ergonom|odontol|cl[íi]nica|m[ée]dic|terapia|gravidez|gestante|idos/i],
  [CATEGORIAS.ti, /wordpress|\bsites?\b|realidade (aumentada|virtual)|ciberseg|seguran[çc]a digital|prote[çc][ãa]o de dados|automa[çc][ãa]o|dispositivos?|\bti\b|tecnologia|blockchain|chatbot|aws|microsservi|serverless|sem servidor|nuvem|migra[çc][ãa]o de dados|drones?|\bapis?\b|seguran[çc]a cibern[ée]tica/i],
  [CATEGORIAS.internet, /copywrit|escrita persuasiva|marketing|conte[úu]do|blog|podcast|discord|criadores?|influenci|branding|marca pessoal|e-?mail|comunidade/i],
  [CATEGORIAS.negocios, /negocia|custos?|consultoria|corporativ|executiv|treinamento|salari|empresa|ind[úu]stria|f[áa]brica|varejo|freelanc|aut[ôo]nom|log[íi]stica|atendimento|portf[óo]lio|designers?|restaurantes?|servi[çc]o de/i],
  [CATEGORIAS.educacional, /e-?learning|cursos?\b|gamifica|did[áa]tic|alfabetiza|universit/i],
  [CATEGORIAS.direito, /propriedade intelectual|dados pessoais|lgpd|patente|compliance|loca[çc][ãa]o|cidadania|documentos|expatriad|visto/i],
  [CATEGORIAS.ecologia, /solar|pain[ée]is|circular|verde|ecol[óo]gic|fazenda vertical|carbono|zero res[íi]duo|compost|desperd[íi]cio|org[âa]nic/i],
  [CATEGORIAS.relacionamentos, /casais|\bpais\b|crian[çc]as?|adolescen|comunica[çc][ãa]o/i],
  [CATEGORIAS.animais, /c[ãa]es|tutores/i],
  [CATEGORIAS.hobbies, /artesana|viage(m|ns)|mochila|turismo|destinos?|artesanato|n[ôo]made|camping|trilha/i],
  [CATEGORIAS.moda, /roupa|cole[çc][ãa]o|cosm[ée]tic|skincare/i],
  [CATEGORIAS.desenvolvimento, /tempo|produtividade pessoal|motiva|resili[êe]ncia|mentalidade|minimalis|autocuidado|intelig[êe]ncia emocional|gratid[ãa]o|desconex[ãa]o|ritua/i],
];

/** Categoria da Kiwify a partir do titulo e do tema. "Outros" quando nada casa. Pura. */
function categoriaKiwify(titulo, tema) {
  // Hifen tipografico (U+2010 a U+2015: 'e‑commerce', 'low‑carb') nao casa com o hifen das regras.
  const texto = (String(titulo || '') + ' ' + String(tema || '')).replace(/[‐-―]/g, '-');
  for (const [id, regra] of REGRAS_CATEGORIA) if (regra.test(texto)) return id;
  for (const [id, regra] of REGRAS_CATEGORIA_2) if (regra.test(texto)) return id;
  return CATEGORIAS.outros;
}

/** Preco em centavos, como a API exige. Abaixo do minimo da Kiwify (R$ 5) nao vende. Pura. */
function precoCentavos(reais, minimo = 500) {
  const n = Number(String(reais == null ? '' : reais).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return minimo;
  return Math.max(minimo, Math.round(n * 100));
}

/** Moeda pelo idioma do livro — e assim o catalogo vende fora do Brasil. Pura. */
const MOEDAS = { pt: 'BRL', en: 'USD', es: 'USD', fr: 'EUR', de: 'EUR', it: 'EUR', nl: 'EUR', ja: 'JPY', ar: 'AED' };
function moedaPorIdioma(idioma, aceitas = ['AED', 'ARS', 'AUD', 'BRL', 'CAD', 'CLP', 'COP', 'EUR', 'GBP', 'JPY', 'MXN', 'PEN', 'USD']) {
  const base = String(idioma || '').toLowerCase().slice(0, 2);
  const m = MOEDAS[base] || 'USD';
  return aceitas.includes(m) ? m : 'BRL';
}

/** Descricao no limite do campo (500) sem cortar palavra no meio. Pura. */
function descricaoKiwify(descricao, limite = 500) {
  const t = String(descricao || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limite) return t;
  const corte = t.slice(0, limite);
  const espaco = corte.lastIndexOf(' ');
  return (espaco > limite * 0.6 ? corte.slice(0, espaco) : corte).replace(/[,;:\-–—\s]+$/, '') + '.';
}

/** Texto que aparece na fatura do cartao: 10 caracteres, so letra e numero. Pura. */
function descritorFatura(titulo) {
  const s = String(titulo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '');
  return (s.slice(0, 10) || 'Ebook').padEnd(3, 'x');
}

/** Corpo do POST que cria o produto. Pura — o publisher so manda. */
function corpoDeCriacao(livro) {
  return {
    name: String(livro.title || '').slice(0, 100),
    price: precoCentavos(livro.preco),
    payment_type: 'charge',
    sales_page_url: livro.paginaDeVendas || '',
    type: 'club',
    description: descricaoKiwify(livro.description),
    currency: moedaPorIdioma(livro.language),
    club_id: null,
  };
}

/**
 * Recusa do filtro de conteudo da Kiwify: `{"error":"ProductNotAllowed",
 * "keyword":"casino"}`. Devolve a palavra acusada (ou 'desconhecida'), ou null
 * quando a falha foi outra. Medido em 23/09/2026 num livro sobre bem-estar
 * escolar, cujo texto nao tem a palavra — falso positivo do lado deles. Sem
 * isso o livro voltava para a fila a cada rodada, para sempre. Pura.
 */
function motivoRecusa(textoDaApi) {
  const t = String(textoDaApi || '');
  if (!/ProductNotAllowed/i.test(t)) return null;
  const m = t.match(/"keyword"\s*:\s*"([^"]{1,40})"/i);
  return m ? m[1] : 'desconhecida';
}

/**
 * A Kiwify limita o ritmo: em 23/09/2026 um lote de 60 publicou 3 e levou 57
 * respostas `429 Rate limit exceeded` em segundos. Pura.
 */
function ehLimiteDeTaxa(status, texto) {
  return Number(status) === 429 || /rate limit/i.test(String(texto || ''));
}

/** Espera antes da proxima tentativa: 5s, 15s, 45s (teto 2 min). Pura. */
function esperaPorTentativa(tentativa, base = 5000, teto = 120000) {
  const n = Math.max(1, Math.floor(Number(tentativa) || 1));
  return Math.min(teto, base * Math.pow(3, n - 1));
}

/** O produto aberto e o livro certo? Mesmo cuidado da Hotmart. Pura. */
function mesmoProdutoKiwify(nomeNaKiwify, titulo) {
  const n = t => String(t == null ? '' : t).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = n(nomeNaKiwify);
  if (!a) return true;
  return a === n(titulo);
}

/**
 * Campos que o PUT aceita. Medido em 22/09/2026: mandar o objeto do GET de
 * volta da 400 — a API recusa `id`, `created_at`, `club`, `gateway_type` e
 * exige `type` como "payment"/"membership" (no POST ele e "club"). Entao o
 * corpo e montado do zero, com os mesmos campos que o painel envia. Pura.
 */
function corpoDeAtualizacao(base, livro, categoria) {
  const b = base || {};
  const corpo = corpoDeCriacao(livro);
  return {
    name: corpo.name,
    description: corpo.description,
    currency: corpo.currency,
    price: corpo.price,
    category: Number.isInteger(categoria) ? categoria : categoriaKiwify(livro.title, livro.topic),
    sales_page_url: corpo.sales_page_url,
    soft_descriptor: descritorFatura(livro.title),
    moneyback_guarantee: b.moneyback_guarantee == null ? 7 : b.moneyback_guarantee,
    payment_methods: b.payment_methods == null ? 3 : b.payment_methods,
    days_expiration: b.days_expiration == null ? 2 : b.days_expiration,
    cpf_required: b.cpf_required !== false,
    mobile_required: b.mobile_required !== false,
    email_confirmation_required: b.email_confirmation_required !== false,
    instagram_required: b.instagram_required === true,
    checkout_color: b.checkout_color || '#2353ff',
    checkout_logo: b.checkout_logo || null,
    support_email: b.support_email || null,
    // Entrega: a Kiwify manda o comprador para esta URL depois da aprovacao.
    // E o mesmo link assinado (HMAC) que a Cakto usa desde 15/09/2026 — o PDF
    // sai do nosso servidor, nao vira link publico.
    approved_url: livro.linkDeEntrega || b.approved_url || '',
    boleto_url: b.boleto_url || '',
    pixels: Array.isArray(b.pixels) ? b.pixels : [],
  };
}

/**
 * Vale tentar a Kiwify agora, ou o limite ainda esta de pe?
 *
 * O 429 da Kiwify NAO e ritmo: desde 25/09/2026, com 273 produtos na conta,
 * toda criacao volta "Rate limit exceeded" — inclusive depois da virada do dia
 * e tres dias depois (medido em 28/09). E teto de conta, nao de velocidade.
 *
 * Insistir a cada 30 minutos custa o recurso escasso: o Chrome do dono, que a
 * Hotmart usa para publicar de verdade. Depois de bater no limite, espera-se
 * ESPERA_APOS_LIMITE antes de tentar de novo.
 *
 * `ultimaFalha` e o instante da ultima recusa por limite (ou nulo). Pura.
 */
const ESPERA_APOS_LIMITE_MS = 6 * 60 * 60 * 1000;
function valeTentarKiwify(ultimaFalha, agora = Date.now(), espera = ESPERA_APOS_LIMITE_MS) {
  if (ultimaFalha == null) return true;
  const quando = Number(ultimaFalha);
  if (!Number.isFinite(quando)) return true;
  // Relogio para tras (ou data no futuro) nao pode travar a loja para sempre.
  if (quando > agora) return true;
  return (agora - quando) >= espera;
}

module.exports = {
  valeTentarKiwify, ESPERA_APOS_LIMITE_MS,
  CATEGORIAS, NOMES_CATEGORIA, categoriaKiwify, precoCentavos, moedaPorIdioma, descricaoKiwify,
  descritorFatura, corpoDeCriacao, corpoDeAtualizacao, mesmoProdutoKiwify, motivoRecusa, ehLimiteDeTaxa, esperaPorTentativa,
};
