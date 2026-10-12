'use strict';
/**
 * regerarPdfCakto.js — devolve o arquivo dos produtos Cakto que estao pausados
 * por nao ter o que entregar.
 *
 * Medido em 18/09/2026: dos 7.287 produtos Cakto, so 1.440 ainda tinham o PDF
 * em disco. A retencao antiga apagou o resto e o entregaCakto pausou 5.843
 * ("Ajustar para vender" no painel). Regerar todos custaria semanas de cota de
 * IA, entao aqui vai POUCO por vez e na ordem que rende venda: primeiro quem
 * ja tem capa (nao gasta imagem), depois portugues, depois o mais novo.
 *
 * Quem reativa e o entregaCakto: assim que o PDF volta, o produto sai de
 * waiting_config e volta a vender (scripts/entregaCakto.js, alvo()).
 *
 * Uso (no container): node scripts/regerarPdfCakto.js --limite=1
 */
const fs = require('fs');

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/** Pontua o candidato: capa em disco, portugues e mais recente primeiro. Pura. */
function nota(e, existe = fs.existsSync) {
  const capa = e.cover_path && existe(e.cover_path) ? 1 : 0;
  const pt = String(e.language || '').toLowerCase().startsWith('pt') ? 1 : 0;
  return capa * 1000 + pt * 100 + (Number(e.ordem) || 0) / 1e9;
}

/** Fila de regeracao: produto Cakto pausado por falta de PDF. */
function pendentes(db, limite, existe = fs.existsSync) {
  let linhas = [];
  try {
    garantirFalhas(db);
    linhas = db.prepare(
      'SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.cover_path, e.pdf_path, e.rowid AS ordem, c.produto ' +
      'FROM cakto_entrega c JOIN ebooks e ON e.id = c.ebook_id ' +
      "WHERE c.resultado = 'pausado-sem-pdf' " +
      'AND e.id NOT IN (SELECT ebook_id FROM regerar_falha WHERE tentativas >= ' + TETO_TENTATIVAS + ')'
    ).all();
  } catch { return []; }
  return linhas
    .filter(e => !e.pdf_path || !existe(e.pdf_path))
    .sort((a, b) => nota(b, existe) - nota(a, existe))
    .slice(0, limite);
}

/**
 * Teto de tentativas por livro. 12/10/2026: sem ele, o mesmo livro falhava em
 * toda rodada (313 vezes um, 203 outro) e ocupava as vagas dos ~2.000 que esperam.
 */
const TETO_TENTATIVAS = 3;

function garantirFalhas(db) {
  db.prepare('CREATE TABLE IF NOT EXISTS regerar_falha (ebook_id TEXT PRIMARY KEY, tentativas INTEGER NOT NULL, ultimo_erro TEXT, quando INTEGER)').run();
}

/**
 * O que a falha significa. Pura.
 *  - 'sem-ia': nenhuma IA respondeu (cota do dia). Vale para TODOS: para a rodada
 *    e nao conta contra o livro.
 *  - 'qa': o texto foi reprovado (capitulo vazio, curto). Conta, e o texto
 *    guardado e descartado para a proxima tentativa reescrever.
 *  - 'outra': conta.
 */
function classificarFalha(mensagem) {
  const m = String(mensagem || '');
  if (/Todos os providers|sem chave livre/i.test(m)) return 'sem-ia';
  if (/reprovado no QA/i.test(m)) return 'qa';
  return 'outra';
}

/** Soma uma tentativa e devolve o total. */
function registrarFalha(db, ebookId, mensagem, agora = Date.now()) {
  garantirFalhas(db);
  db.prepare('INSERT INTO regerar_falha (ebook_id, tentativas, ultimo_erro, quando) VALUES (?, 1, ?, ?) ' +
    'ON CONFLICT(ebook_id) DO UPDATE SET tentativas = tentativas + 1, ultimo_erro = excluded.ultimo_erro, quando = excluded.quando')
    .run(ebookId, String(mensagem || '').slice(0, 200), agora);
  return db.prepare('SELECT tentativas FROM regerar_falha WHERE ebook_id = ?').get(ebookId).tentativas;
}

/**
 * Livro com o PDF refeito volta para a fila da entrega SEM perder a marca de
 * "pausado por nos". 09/10/2026: aqui havia um DELETE dessa marca — e e ela que
 * autoriza o entregaCakto a reativar. Sem ela, a entrega gravava o link e o
 * produto ficava em waiting_config para sempre: 3.568 livros com PDF pronto e
 * checkout fora do ar, ~250 por dia (o ritmo da regeneracao).
 */
function reabrir(db, ebookId) {
  return db.prepare("UPDATE cakto_entrega SET resultado = 'pdf-regerado', quando = ? WHERE ebook_id = ? AND resultado = 'pausado-sem-pdf'")
    .run(Date.now(), ebookId).changes;
}

async function main() {
  const limite = parseInt(arg('limite', '1'), 10);
  const db = require('../src/core/database').getDb();
  const fila = pendentes(db, limite);
  if (!fila.length) { console.log(JSON.stringify({ pendentes: 0 })); return; }

  const { generateFullEbook } = require('../src/agents/writerAgent');
  const { salvarConteudo, carregarConteudo, descartarConteudo, quantosGuardados } = require('../src/core/conteudoEbook');
  const { generatePDF } = require('../src/agents/pdfAgent');
  const { sanearLivro } = require('../src/core/textoDegenerado');
  const grava = db.prepare('UPDATE ebooks SET pdf_path = ? WHERE id = ?');
  let ok = 0, falha = 0;
  for (const e of fila) {
    try {
      // Se o texto ja foi guardado, refazer o PDF nao custa IA nenhuma
      // (medido em 23/09/2026: 113 s e ~10 chamadas por livro reescrito).
      const guardado = carregarConteudo(db, e.id);
      const bruto = guardado || await generateFullEbook(e.topic || e.title, e.language || 'pt-BR');
      // Texto em laco (01/10/2026: 145 mil hifens) e GUARDADO voltava a cada
      // rodada e derrubava o processo no PDF. Guarda a versao saneada.
      const { livro: novo, defeitos } = sanearLivro(bruto);
      if (defeitos.length) console.log('SANEADO ' + e.id.slice(0, 8) + ': ' + defeitos.join('; ').slice(0, 200));
      if (!guardado || defeitos.length) salvarConteudo(db, e.id, novo);
      const capa = e.cover_path && fs.existsSync(e.cover_path) ? e.cover_path : null;
      const caminho = await generatePDF({ ...novo, title: e.title, subtitle: e.subtitle || novo.subtitle, id: e.id, language: e.language || 'pt-BR' }, capa);
      grava.run(caminho, e.id);
      reabrir(db, e.id); // sai da fila de regerar e o entregaCakto reativa
      ok++;
      console.log('OK ' + e.id.slice(0, 8) + ' ' + (guardado ? '(texto guardado) ' : '(reescrito) ') + String(e.title).slice(0, 50) + ' -> ' + caminho);
    } catch (err) {
      falha++;
      const msg = String(err && err.message);
      console.log('FALHA ' + e.id.slice(0, 8) + ': ' + msg.slice(0, 120));
      const tipo = classificarFalha(msg);
      // Sem IA para ninguem: os proximos falhariam igual — para a rodada.
      if (tipo === 'sem-ia') { console.log('sem IA disponivel agora — rodada interrompida, nada contado contra o livro'); break; }
      if (tipo === 'qa') descartarConteudo(db, e.id);
      const n = registrarFalha(db, e.id, msg);
      if (n >= TETO_TENTATIVAS) console.log('DESISTIU ' + e.id.slice(0, 8) + ' apos ' + n + ' tentativas — fica pausado, fora da fila: ' + String(e.title).slice(0, 50));
    }
  }
  console.log(JSON.stringify({ fila: fila.length, ok, falha, textosGuardados: quantosGuardados(db) }));
}

module.exports = { pendentes, nota, reabrir, classificarFalha, registrarFalha, TETO_TENTATIVAS };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
