'use strict';
/**
 * gplayArquivos.js — o PDF que sobe para o Google Play Livros.
 *
 * A pagina 1 dos nossos PDFs e a capa antiga em IMAGEM, com o titulo-gancho
 * das outras lojas, diferente do titulo do cadastro. O Google compara capa e
 * titulo, e a capa de verdade sobe como arquivo proprio (_frontcover.jpg).
 * Entao: a pagina 1 sai quando nao pode ter texto, e o titulo do metadado
 * passa a ser o do cadastro. Folha de rosto escrita fica.
 *
 * "Nao pode ter texto" = a pagina nao tem FONTE nenhuma nos recursos: sem fonte
 * o PDF nao desenha letra. Medido em 13/10/2026 em seis PDFs do catalogo:
 * pagina 1 com 0 fontes e 1 imagem; pagina 2 com 2 fontes. O extrator de texto
 * (pdf-parse) concordava nos reais e falhava ("bad XRef entry") em pagina so
 * com desenho — criterio que depende do extrator e criterio que falha calado.
 *
 * So transforma bytes; quem le e grava disco e o script.
 */

/** A pagina tem alguma fonte nos recursos? */
function temFonte(pagina) {
  const { PDFName } = require('pdf-lib');
  const res = pagina.node.Resources();
  const fontes = res && res.lookup(PDFName.of('Font'));
  return !!(fontes && fontes.keys().length);
}

/** Devolve { bytes, paginas, tirouPrimeira }. */
async function prepararPdf(bytesDoLivro, { titulo, autor = 'Veloxis Editorial' } = {}) {
  const { PDFDocument } = require('pdf-lib');
  const orig = await PDFDocument.load(bytesDoLivro);
  // Livro de uma pagina nunca fica vazio.
  const tirouPrimeira = orig.getPageCount() > 1 && !temFonte(orig.getPage(0));
  // Documento NOVO com as paginas que ficam: removePage deixa a imagem da capa
  // antiga orfa dentro do arquivo (peso a toa, e o leitor antigo tropeca nela).
  const doc = await PDFDocument.create();
  const indices = orig.getPageIndices().slice(tirouPrimeira ? 1 : 0);
  for (const p of await doc.copyPages(orig, indices)) doc.addPage(p);
  if (!titulo && orig.getTitle()) doc.setTitle(orig.getTitle());
  if (titulo) doc.setTitle(String(titulo));
  doc.setAuthor(autor);
  doc.setProducer(autor);
  doc.setCreator(autor);
  // Formato classico: o mesmo motivo de combo.js (leitor antigo nao abre o compacto).
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, paginas: doc.getPageCount(), tirouPrimeira };
}

module.exports = { prepararPdf, temFonte };
