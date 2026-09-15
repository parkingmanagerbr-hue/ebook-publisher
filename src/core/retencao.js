'use strict';
/**
 * retencao.js — o que a limpeza de disco pode apagar.
 *
 * A retencao mantinha so os 1000 PDFs mais novos, supondo que "PDF e capa sao
 * enviados no upload e viram lixo local". Na Cakto isso nunca foi verdade: o
 * arquivo nunca subiu, a entrega depende do PDF daqui. Medido em 15/09/2026:
 * 874 de 6729 produtos Cakto ainda tinham PDF — os outros 5855 cobravam do
 * comprador sem ter o que entregar.
 *
 * Regra nova: arquivo de livro PUBLICADO (Hotmart ou Cakto) nao sai. O teto so
 * vale para o resto (rascunho, teste, falha). Cabe: ~3 MB por PDF, 86 GB livres.
 */
const path = require('path');

/** Caminhos (absolutos, normalizados) que a limpeza nunca pode apagar. */
function arquivosProtegidos(db) {
  const linhas = db.prepare(
    "SELECT pdf_path, cover_path FROM ebooks WHERE (cakto_url IS NOT NULL AND cakto_url <> '') " +
    "OR (hotmart_url IS NOT NULL AND hotmart_url <> '') OR (hotmart_product_id IS NOT NULL AND hotmart_product_id <> '')"
  ).all();
  const s = new Set();
  for (const l of linhas) for (const p of [l.pdf_path, l.cover_path]) if (p) s.add(path.resolve(p));
  return s;
}

/**
 * Escolhe o que apagar: mais novos ficam ate o teto, protegidos ficam sempre e
 * nao ocupam vaga do teto (senao o catalogo publicado empurraria para fora os
 * rascunhos recentes que ainda vao ser publicados).
 * @param {{full:string, mtime:number}[]} arquivos
 */
function escolherExcedente(arquivos, manter, protegidos) {
  const livres = arquivos
    .filter(a => !protegidos.has(path.resolve(a.full)))
    .sort((a, b) => b.mtime - a.mtime);
  return livres.slice(manter);
}

module.exports = { arquivosProtegidos, escolherExcedente };
