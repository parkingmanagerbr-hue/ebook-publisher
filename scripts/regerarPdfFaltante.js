'use strict';
/**
 * regerarPdfFaltante.js — refaz o PDF de produto que esta a venda sem arquivo.
 *
 * A varredura de 15/09/2026 achou 24 produtos Hotmart sem conteudo; 2 ainda
 * tinham o PDF em disco (reanexados), e 22 nao — a retencao antiga apagou o
 * arquivo e o texto do livro nunca foi guardado no banco. Sem regerar, esses
 * produtos continuam cobrando sem ter o que entregar.
 *
 * Roda no container (tem a IA e as fontes). Gera conteudo novo para o MESMO
 * titulo e idioma, monta o PDF e grava o caminho no e-book. O envio para a
 * Hotmart e local (scripts/reanexarPdfHotmart.js), porque a sessao da Hotmart
 * esta presa a maquina que fez o login.
 *
 * De proposito processa POUCOS por vez: a cota de IA gratuita esta reservada
 * para o passe de capas.
 *
 * Uso: node scripts/regerarPdfFaltante.js --limite=2
 */
const fs = require('fs');

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

function pendentes(db, limite) {
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
  return db.prepare(
    // pdf_path vem no SELECT: sem ele o filtro abaixo achava que ninguem tem
    // arquivo e o livro ja resolvido voltaria a gastar IA.
    'SELECT s.produto, e.id, e.title, e.topic, e.language, e.subtitle, e.cover_path, e.pdf_path ' +
    'FROM hotmart_sem_arquivo s JOIN ebooks e ON e.id = s.ebook_id ' +
    'ORDER BY s.quando ASC LIMIT ?'
  ).all(limite).filter(e => !e.pdf_path || !fs.existsSync(e.pdf_path));
}

async function main() {
  const limite = parseInt(arg('limite', '1'), 10);
  const { getDb } = require('../src/core/database');
  const db = getDb();
  const fila = pendentes(db, limite);
  if (!fila.length) { console.log(JSON.stringify({ pendentes: 0 })); return; }

  const { generateFullEbook } = require('../src/agents/writerAgent');
  const { generatePDF } = require('../src/agents/pdfAgent');
  const grava = db.prepare('UPDATE ebooks SET pdf_path = ? WHERE id = ?');
  const saida = [];
  for (const e of fila) {
    try {
      const novo = await generateFullEbook(e.topic || e.title, e.language || 'pt-BR');
      // Titulo e capa do produto que ja esta no ar: o comprador tem de receber
      // o livro que a pagina promete, com o mesmo nome.
      const capa = e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
      const caminho = await generatePDF({ ...novo, title: e.title, subtitle: e.subtitle || novo.subtitle, id: e.id, language: e.language || 'pt-BR' }, capa);
      grava.run(caminho, e.id);
      saida.push({ produto: e.produto, ok: true, pdf: caminho });
      console.log('OK ' + e.produto + ' -> ' + caminho);
    } catch (err) {
      saida.push({ produto: e.produto, ok: false, erro: String(err.message).slice(0, 120) });
      console.log('FALHA ' + e.produto + ': ' + String(err.message).slice(0, 140));
    }
  }
  console.log(JSON.stringify({ processados: saida.length, ok: saida.filter(s => s.ok).length }));
}

module.exports = { pendentes };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
