'use strict';
/**
 * combo.js — o produto "livro + plano de acao".
 *
 * Decisao do dono (30/09/2026): o combo e um e-book a R$ 19,90 cujo PDF traz,
 * logo depois da folha de rosto, a pagina de acesso ao plano de acao
 * interativo. Na Hotmart, produto no formato e-book nao tem area de membros;
 * o link dentro do livro e a entrega possivel sem montar um curso.
 *
 * O link tem a mesma protecao do proprio livro: vai para quem tem o arquivo.
 *
 * Tudo aqui e puro, exceto `montarPdfDoCombo`, que so transforma bytes.
 */

const PRECO_COMBO = 19.9;
const SUFIXO = ' + Plano de Ação';

/**
 * Titulo + sufixo dentro do limite da loja: corta o TITULO, nunca o sufixo —
 * o sufixo e o que diferencia o produto do livro avulso na mesma loja. Pura.
 */
function tituloComSufixo(titulo, sufixo, max = 120) {
  const base = String(titulo == null ? '' : titulo).replace(/\s+/g, ' ').trim();
  if (!base) return '';
  const cabe = Math.max(0, max - sufixo.length);
  const cortado = base.length > cabe ? base.slice(0, cabe).replace(/[\s:,;.-]+$/, '') : base;
  return cortado + sufixo;
}

/** Nome do combo na loja, respeitando o limite pedido. Pura. */
function tituloDoCombo(titulo, max = 120) {
  return tituloComSufixo(titulo, SUFIXO, max);
}

/**
 * Descricao do combo: a do livro + o que a ferramenta e, sem promessa de
 * resultado (o comprador compra pelo que a pagina diz). Pura.
 */
function descricaoDoCombo(descricao, totalDeAcoes) {
  const base = String(descricao == null ? '' : descricao).replace(/\s+/g, ' ').trim();
  const n = Number(totalDeAcoes) > 0 ? Number(totalDeAcoes) : 0;
  const extra = 'Inclui o Plano de Ação interativo do livro' + (n ? ', com ' + n + ' passos' : '') +
    ' organizados por capítulo, hábitos da semana e espaço para anotações. ' +
    'O progresso fica salvo no seu navegador e o plano pode ser impresso.';
  return base ? base + '\n\n' + extra : extra;
}

/**
 * Deixa o texto dentro do alfabeto que a fonte padrao do PDF codifica
 * (WinAnsi). Titulo com hifen especial ("Micro‑Habitos") ou aspas curvas
 * derrubaria a montagem inteira do combo. Acento portugues passa inteiro. Pura.
 */
function paraWinAnsi(texto) {
  return String(texto == null ? '' : texto)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ')
    .replace(/[^\u0020-\u007e\u00a1-\u00ff]/g, '');
}

/** Texto da pagina de acesso, separado da diagramacao para poder testar. Pura. */
function textoDaPaginaDeAcesso(titulo, url) {
  return {
    cabecalho: 'Seu Plano de Ação',
    linhas: [
      'Este livro vem com um plano de ação interativo: os passos de cada capítulo',
      'para você marcar conforme avança, os hábitos da semana e um espaço de anotações.',
      '',
      'Abra no celular ou no computador:',
    ],
    link: String(url || ''),
    rodape: 'O endereço é exclusivo de quem comprou "' + paraWinAnsi(titulo).slice(0, 70) + '". Guarde este arquivo.',
  };
}

/**
 * Quebra o link em pedacos que cabem na largura. Link quebrado em duas linhas
 * continua clicavel (cada pedaco leva a anotacao do link INTEIRO); link que
 * passa da margem e cortado pelo leitor de PDF e o comprador fica sem o acesso.
 * Pura: recebe a funcao que mede.
 */
function quebrarLink(link, largura, medir) {
  const pedacos = [];
  let atual = '';
  for (const c of String(link)) {
    if (atual && medir(atual + c) > largura) { pedacos.push(atual); atual = ''; }
    atual += c;
  }
  if (atual) pedacos.push(atual);
  return pedacos;
}

/**
 * Quebra uma frase por palavra na largura da pagina. O livro pode ter pagina
 * estreita (formato de bolso) e a frase escrita pensando em A4 sairia cortada
 * na margem. Palavra maior que a linha fica inteira na linha dela. Pura.
 */
function quebrarFrase(frase, largura, medir) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(frase).split(' ')) {
    const tentativa = atual ? atual + ' ' + palavra : palavra;
    if (atual && medir(tentativa) > largura) { linhas.push(atual); atual = palavra; }
    else atual = tentativa;
  }
  linhas.push(atual);
  return linhas;
}

/**
 * Insere a pagina de acesso logo depois da primeira pagina (a folha de rosto)
 * e devolve os bytes do PDF novo. O original nao e tocado.
 *
 * `texto` troca o conteudo da pagina (o audiolivro usa a mesma diagramacao com
 * outro cabecalho); sem ele, e a pagina do plano de acao.
 */
async function montarPdfDoCombo(bytesDoLivro, { titulo, url, texto }) {
  if (!url || !/^https:\/\//.test(url)) throw new Error('COMBO_SEM_LINK: endereço de acesso ausente ou sem https');
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
  const doc = await PDFDocument.load(bytesDoLivro);
  const [w, h] = (() => { const p = doc.getPage(0); const s = p.getSize(); return [s.width, s.height]; })();
  const pagina = doc.insertPage(Math.min(1, doc.getPageCount()), [w, h]);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const t = texto ? { ...texto, link: String(url) } : textoDaPaginaDeAcesso(titulo, url);
  const margem = 56;
  let y = h - 120;
  pagina.drawText(t.cabecalho, { x: margem, y, size: 24, font: negrito, color: rgb(0.1, 0.13, 0.19) });
  y -= 44;
  for (const linha of t.linhas) {
    for (const parte of quebrarFrase(linha, w - 2 * margem, x => normal.widthOfTextAtSize(x, 11.5))) {
      if (parte) pagina.drawText(parte, { x: margem, y, size: 11.5, font: normal, color: rgb(0.2, 0.23, 0.29) });
      y -= 18;
    }
  }
  y -= 10;
  // O link: texto azul sublinhado + anotacao clicavel por cima de cada linha.
  const util = w - 2 * margem;
  // Letra menor antes de quebrar: o link do audiolivro tem ~110 caracteres e,
  // a 9 pt no A4, sobrava UM caractere na segunda linha (medido em 13/10/2026).
  // So abaixo de 7 pt (ilegivel) o link passa a quebrar.
  const emUm = normal.widthOfTextAtSize(t.link, 1);
  const tamLink = util >= emUm * 11 ? 11 : Math.max(7, Math.min(9, Math.floor((util / emUm) * 2) / 2));
  const anotacoes = [];
  for (const pedaco of quebrarLink(t.link, util, s => normal.widthOfTextAtSize(s, tamLink))) {
    const larguraLink = normal.widthOfTextAtSize(pedaco, tamLink);
    pagina.drawText(pedaco, { x: margem, y, size: tamLink, font: normal, color: rgb(0.1, 0.35, 0.75) });
    pagina.drawLine({ start: { x: margem, y: y - 2 }, end: { x: margem + larguraLink, y: y - 2 }, thickness: 0.6, color: rgb(0.1, 0.35, 0.75) });
    anotacoes.push(doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [margem, y - 4, margem + larguraLink, y + tamLink + 2],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(t.link) },
    })));
    y -= tamLink + 5;
  }
  pagina.node.set(PDFName.of('Annots'), doc.context.obj(anotacoes));
  y -= 40 - (tamLink + 5);
  for (const parte of quebrarFrase(t.rodape, w - 2 * margem, x => normal.widthOfTextAtSize(x, 9.5))) {
    pagina.drawText(parte, { x: margem, y, size: 9.5, font: normal, color: rgb(0.4, 0.43, 0.49) });
    y -= 14;
  }
  // Formato classico (sem object streams): o leitor de PDF antigo do nosso
  // controle de qualidade (pdf-parse) nao abre o formato compacto que a
  // pdf-lib grava por padrao — "Invalid PDF structure". Leitor de e-book abre
  // os dois; o classico e o que todo mundo abre.
  return doc.save({ useObjectStreams: false });
}

module.exports = { paraWinAnsi, tituloComSufixo, quebrarLink, quebrarFrase, tituloDoCombo, descricaoDoCombo, textoDaPaginaDeAcesso, montarPdfDoCombo, PRECO_COMBO, SUFIXO };
