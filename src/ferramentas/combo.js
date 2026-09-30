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

/** Nome do combo na loja, respeitando o limite pedido. Pura. */
function tituloDoCombo(titulo, max = 120) {
  const base = String(titulo == null ? '' : titulo).replace(/\s+/g, ' ').trim();
  if (!base) return '';
  const cabe = Math.max(0, max - SUFIXO.length);
  const cortado = base.length > cabe ? base.slice(0, cabe).replace(/[\s:,;.-]+$/, '') : base;
  return cortado + SUFIXO;
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
 * Insere a pagina de acesso logo depois da primeira pagina (a folha de rosto)
 * e devolve os bytes do PDF novo. O original nao e tocado.
 */
async function montarPdfDoCombo(bytesDoLivro, { titulo, url }) {
  if (!url || !/^https:\/\//.test(url)) throw new Error('COMBO_SEM_LINK: endereço da ferramenta ausente ou sem https');
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
  const doc = await PDFDocument.load(bytesDoLivro);
  const [w, h] = (() => { const p = doc.getPage(0); const s = p.getSize(); return [s.width, s.height]; })();
  const pagina = doc.insertPage(Math.min(1, doc.getPageCount()), [w, h]);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const t = textoDaPaginaDeAcesso(titulo, url);
  const margem = 56;
  let y = h - 120;
  pagina.drawText(t.cabecalho, { x: margem, y, size: 24, font: negrito, color: rgb(0.1, 0.13, 0.19) });
  y -= 44;
  for (const linha of t.linhas) {
    if (linha) pagina.drawText(linha, { x: margem, y, size: 11.5, font: normal, color: rgb(0.2, 0.23, 0.29) });
    y -= 18;
  }
  y -= 10;
  // O link: texto azul sublinhado + anotacao clicavel por cima.
  const tamLink = w - 2 * margem < normal.widthOfTextAtSize(t.link, 11) ? 9 : 11;
  const larguraLink = normal.widthOfTextAtSize(t.link, tamLink);
  pagina.drawText(t.link, { x: margem, y, size: tamLink, font: normal, color: rgb(0.1, 0.35, 0.75) });
  pagina.drawLine({ start: { x: margem, y: y - 2 }, end: { x: margem + larguraLink, y: y - 2 }, thickness: 0.6, color: rgb(0.1, 0.35, 0.75) });
  const anotacao = doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [margem, y - 4, margem + larguraLink, y + tamLink + 2],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(t.link) },
  });
  pagina.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(anotacao)]));
  y -= 40;
  pagina.drawText(t.rodape, { x: margem, y, size: 9.5, font: normal, color: rgb(0.4, 0.43, 0.49) });
  // Formato classico (sem object streams): o leitor de PDF antigo do nosso
  // controle de qualidade (pdf-parse) nao abre o formato compacto que a
  // pdf-lib grava por padrao — "Invalid PDF structure". Leitor de e-book abre
  // os dois; o classico e o que todo mundo abre.
  return doc.save({ useObjectStreams: false });
}

module.exports = { paraWinAnsi, tituloDoCombo, descricaoDoCombo, textoDaPaginaDeAcesso, montarPdfDoCombo, PRECO_COMBO, SUFIXO };
