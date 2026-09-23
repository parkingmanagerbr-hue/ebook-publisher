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
];
function errosQueImportam(lista) {
  return (lista || [])
    .map(t => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(t => !RUIDO.some(r => r.test(t)));
}

module.exports = { ehBotaoDeCategoria, melhorBotaoDeCategoria, errosQueImportam };
