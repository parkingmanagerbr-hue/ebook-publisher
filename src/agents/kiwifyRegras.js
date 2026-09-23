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

const REGRAS_CATEGORIA = [
  [CATEGORIAS.financas, /financ|dinheiro|investi|renda|divida|d[ií]vida|or[çc]amento|aposentad|cr[ée]dito|econom/i],
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

/** Categoria da Kiwify a partir do titulo e do tema. "Outros" quando nada casa. Pura. */
function categoriaKiwify(titulo, tema) {
  const texto = String(titulo || '') + ' ' + String(tema || '');
  for (const [id, regra] of REGRAS_CATEGORIA) if (regra.test(texto)) return id;
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
    approved_url: b.approved_url || '',
    boleto_url: b.boleto_url || '',
    pixels: Array.isArray(b.pixels) ? b.pixels : [],
  };
}

module.exports = {
  CATEGORIAS, categoriaKiwify, precoCentavos, moedaPorIdioma, descricaoKiwify,
  descritorFatura, corpoDeCriacao, corpoDeAtualizacao, mesmoProdutoKiwify,
};
