'use strict';
/**
 * conteudoEbook.js — guarda o TEXTO do livro, nao so o PDF.
 *
 * Em 23/09/2026 a auditoria da Cakto achou 5.795 produtos pausados porque o PDF
 * tinha sido apagado do disco. O texto nunca foi salvo em lugar nenhum, entao
 * cada arquivo perdido custa uma geracao de IA inteira (medido: 113 s e ~10
 * chamadas por livro). Com o texto guardado, refazer o PDF é instantaneo e de
 * graca — e da para gerar EPUB, audiobook ou outra diagramacao depois.
 *
 * Guardado como JSON: {sections:[{title, content}], subtitle, intro, ...} — o
 * que o gerador de PDF ja consome.
 */

const TABELA = 'ebook_conteudo';

function garantirTabela(db) {
  db.prepare('CREATE TABLE IF NOT EXISTS ' + TABELA + ' (' +
    'ebook_id TEXT PRIMARY KEY, conteudo TEXT NOT NULL, palavras INTEGER, quando INTEGER)').run();
}

/** Quantas palavras o conteudo tem — serve de sinal de qualidade. Pura. */
function contarPalavras(conteudo) {
  const partes = [];
  const visitar = v => {
    if (typeof v === 'string') partes.push(v);
    else if (Array.isArray(v)) v.forEach(visitar);
    else if (v && typeof v === 'object') Object.values(v).forEach(visitar);
  };
  visitar(conteudo);
  return partes.join(' ').trim().split(/\s+/).filter(Boolean).length;
}

/** Conteudo bom o bastante para guardar? Pura. */
function vale(conteudo, minimoPalavras = 300) {
  if (!conteudo || typeof conteudo !== 'object') return false;
  return contarPalavras(conteudo) >= minimoPalavras;
}

/** Guarda o texto do livro. Devolve false quando o conteudo nao vale. */
function salvarConteudo(db, ebookId, conteudo, agora = Date.now()) {
  if (!ebookId || !vale(conteudo)) return false;
  garantirTabela(db);
  db.prepare('INSERT OR REPLACE INTO ' + TABELA + ' (ebook_id, conteudo, palavras, quando) VALUES (?,?,?,?)')
    .run(String(ebookId), JSON.stringify(conteudo), contarPalavras(conteudo), agora);
  return true;
}

/** Devolve o texto guardado, ou null. Nunca lanca: sem texto, quem chama gera de novo. */
function carregarConteudo(db, ebookId) {
  try {
    garantirTabela(db);
    const linha = db.prepare('SELECT conteudo FROM ' + TABELA + ' WHERE ebook_id = ?').get(String(ebookId));
    if (!linha || !linha.conteudo) return null;
    const c = JSON.parse(linha.conteudo);
    return vale(c) ? c : null;
  } catch (_) { return null; }
}

/** Quantos livros ja tem texto guardado (para o log da rodada). */
function quantosGuardados(db) {
  try {
    garantirTabela(db);
    return db.prepare('SELECT COUNT(*) AS n FROM ' + TABELA).get().n;
  } catch (_) { return 0; }
}

module.exports = { salvarConteudo, carregarConteudo, quantosGuardados, contarPalavras, vale, TABELA };
