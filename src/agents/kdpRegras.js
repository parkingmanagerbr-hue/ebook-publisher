'use strict';
/**
 * kdpRegras.js — decisoes puras do cadastro no KDP, fora do navegador.
 *
 * 23/09/2026: o publish parou com "Adicione uma categoria para seu livro" e o
 * log dizia "Category button not found". A Amazon trocou o botao: era
 * "Adicionar categoria", virou "Editar categorias" (id `categories-modal-button`).
 * Como a pagina muda sem aviso, a regra de "qual elemento abre as categorias"
 * fica aqui, testada, em vez de espalhada no meio do Puppeteer.
 */

/** O elemento abre o seletor de categorias? Pura. */
function ehBotaoDeCategoria(elemento) {
  const e = elemento || {};
  const id = String(e.id || '').toLowerCase();
  if (id === 'categories-modal-button' || id === 'category-modal-button') return true;
  const t = String(e.texto || e.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 60) return false;
  // "O que sao categorias?" e um popover de ajuda, nao o botao.
  if (/^o que s[ãa]o|^what are|\?$/.test(t)) return false;
  // "As categorias atuais do seu livro" e rotulo.
  if (/^as categorias|^your book'?s current/.test(t)) return false;
  return /^(editar|adicionar|escolher|escolha|selecionar)\s+(as\s+)?categorias?$/.test(t)
    || /^(edit|add|choose|select)\s+(a\s+)?categor(y|ies)$/.test(t);
}

/**
 * Entre varios candidatos, o melhor botao de categoria. Prefere o que tem id
 * conhecido (a Amazon repete o texto em <span> e <button> aninhados). Pura.
 */
function melhorBotaoDeCategoria(candidatos) {
  const bons = (candidatos || []).filter(ehBotaoDeCategoria);
  if (!bons.length) return null;
  const comId = bons.find(c => /categor/i.test(String(c.id || '')));
  if (comId) return comId;
  // Sem id, o <button> vale mais que o <span> que o embrulha.
  return bons.find(c => String(c.tag || '').toUpperCase() === 'BUTTON') || bons[0];
}

/**
 * O que o KDP devolve como "erro" inclui muito aviso de tela (pre-venda,
 * beta do chines, adiamento). Fica so o que realmente impede publicar. Pura.
 */
const RUIDO = [
  /pr[ée]-?venda/i, /preorder/i, /adiamento/i, /postpone/i, /beta no kdp/i,
  /em andamento\.\.\./i, /n[ãa]o iniciada\.\.\./i, /saiba mais/i, /learn more/i,
  /agora voc[êe] pode definir datas/i, /alterar o t[íi]tulo do seu livro pode afetar/i,
  /como voc[êe] indicou que este livro cont[ée]m conte[úu]do adulto/i,
  // Textos de AJUDA da tabela de precos: aparecem sempre, com ou sem erro.
  // Em 30/09/2026 eles passavam como "causa" e escondiam o bloqueio real.
  /^conclu[íi]da$/i, /^defina um pre[çc]o sugerido entre/i, /^use um formato de pre[çc]o/i,
  /^o pre[çc]o sugerido deve ser em m[úu]ltiplos/i, /^o tamanho do arquivo do seu livro/i,
];

/**
 * Bloqueio que nao e do livro: o KDP recusa QUALQUER publicacao da conta.
 * Vem primeiro na causa, porque corrigir o livro nao adianta nada. Pura.
 */
const BLOQUEIO_DE_CONTA = [/informa[çc][õo]es de conta incompletas/i, /account information (is )?incomplete/i];
function ehBloqueioDeConta(texto) {
  const t = String(texto == null ? '' : texto);
  return BLOQUEIO_DE_CONTA.some(r => r.test(t));
}
function errosQueImportam(lista) {
  const limpos = (lista || [])
    .map(t => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(t => !RUIDO.some(r => r.test(t)));
  // Bloqueio de conta na frente: e ele que decide, e ele que o dono resolve.
  return limpos.filter(ehBloqueioDeConta).concat(limpos.filter(t => !ehBloqueioDeConta(t)));
}

/**
 * Preco por mercado. O campo do KDP e `data[digital][channels][amazon][XX]
 * [price_vat_inclusive]` (id vazio — por isso a busca antiga preenchia 0 de 13).
 * India e Japao nao aceitam centavos; os demais usam VIRGULA decimal.
 * Fatores tirados da propria tela do KDP (auto-conversao a partir do dolar). Pura.
 */
const FATOR = { US: 1, UK: 1.33, DE: 1.5, FR: 1.5, ES: 1.5, IT: 1.5, NL: 1.5, CA: 2.17, AU: 2.67, BR: 5, MX: 33.1, IN: 83.3, JP: 148 };
const SEM_CENTAVOS = new Set(['IN', 'JP']);

/** Codigo do mercado a partir do name do campo, ou null. Pura. */
function mercadoDoCampo(nome) {
  const m = String(nome || '').match(/channels\]\[amazon\]\[([A-Z]{2})\]/);
  return m ? m[1] : null;
}

/** Valor a digitar naquele mercado, no formato que o KDP aceita. Pura. */
function precoDoMercado(mercado, precoUSD = 2.99) {
  const base = Number(precoUSD);
  const usd = Number.isFinite(base) && base > 0 ? base : 2.99;
  const fator = FATOR[String(mercado || '').toUpperCase()];
  if (!fator) return null;
  const v = usd * fator;
  if (SEM_CENTAVOS.has(String(mercado).toUpperCase())) return String(Math.round(v));
  return v.toFixed(2).replace('.', ',');
}

/**
 * Faixa de royalty: 70% exige preco entre US$ 2,99 e US$ 9,99; fora disso, a
 * Amazon so aceita 35% e recusa a pagina se o radio estiver errado. Pura.
 */
function royaltyPara(precoUSD = 2.99) {
  const v = Number(precoUSD);
  return Number.isFinite(v) && v >= 2.99 && v <= 9.99 ? '70_PERCENT' : '35_PERCENT';
}

/**
 * Este botao PUBLICA de verdade?
 *
 * 29/09/2026: a lista de rotulos do publicador tinha "Publicar e-book Kindle"
 * e o botao real do KDP em portugues e "Publicar seu eBooks Kindle" — nao
 * casava. Como "Salvar e continuar" tambem estava na lista, o robo clicava
 * NESSE, salvava o rascunho e reportava buttonClicked=true. Resultado: livros
 * completos ("Concluida" nas tres etapas) parados como Rascunho, e a Amazon —
 * a unica loja de alcance mundial — sem catalogo.
 *
 * Salvar NAO e publicar: os rotulos de rascunho sao recusados de proposito,
 * senao a falha volta a se disfarcar de sucesso. Pura.
 */
function ehBotaoDePublicar(texto) {
  const t = String(texto == null ? '' : texto).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // Rascunho e etapa intermediaria nunca contam como publicacao.
  if (/salvar como rascunho|save as draft|salvar e continuar|save and continue/.test(t)) return false;
  return /publicar|publish/.test(t);
}

/**
 * O robo pode fazer login sozinho no KDP?
 *
 * NAO, por padrao. 30/09/2026: a conta do KDP passou a ser outra (a nova,
 * logada a mao no Chrome), mas o .env ainda guardava e-mail e senha da ANTIGA.
 * O login automatico, ao ver uma tela de entrada com a conta nova, concluia
 * "conta errada", clicava em "Trocar contas" e entrava na antiga digitando a
 * senha — publicando o catalogo na conta que o dono mandou nao usar.
 *
 * Credencial e do dono: se a sessao cair, o robo para e pede gente, como faz
 * na Hotmart. So liga com KDP_LOGIN_AUTOMATICO=1 escrito de proposito. Pura.
 */
function podeLogarSozinhoNoKdp(env) {
  const e = env || {};
  return String(e.KDP_LOGIN_AUTOMATICO == null ? '' : e.KDP_LOGIN_AUTOMATICO).trim() === '1';
}

module.exports = {
  ehBloqueioDeConta,
  podeLogarSozinhoNoKdp,
  ehBotaoDePublicar,
  ehBotaoDeCategoria, melhorBotaoDeCategoria, errosQueImportam,
  mercadoDoCampo, precoDoMercado, royaltyPara,
};
