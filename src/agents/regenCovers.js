'use strict';
/**
 * regenCovers.js — regera a capa dos produtos cujo PNG a retencao ja apagou.
 *
 * Medido em 01/09/2026: dos 570 produtos ainda sem capa no Hotmart, ZERO tinham
 * a imagem em disco. A retencao (KEEP_COVERS=1000) guarda so as mais recentes,
 * e o passivo e todo anterior a isso. Sem regerar, esses produtos ficam para
 * sempre com o placeholder cinza.
 *
 * A regeracao NAO gasta cota de imagem: o fundo sai do pool do Google FX ja
 * baixado. Só o texto da embalagem passa pelo LLM, e o coverViralAgent tem
 * fallback proprio quando a IA esta fora — capa com texto padrao e melhor que
 * produto sem capa.
 *
 * TRABALHA EM LOTES PEQUENOS DE PROPOSITO: a mesma retencao que apagou essas
 * capas continua rodando. Regerar 570 de uma vez faria as primeiras serem
 * apagadas antes de subir. O ciclo certo e regerar um lote e enviar em seguida.
 *
 * Uso:
 *   node src/agents/regenCovers.js --limite=40
 */
const fs = require('fs');
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('regenCovers'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

const COVERS_DIR = process.env.COVERS_DIR || '/app/data/covers';

/**
 * Produtos publicados no Hotmart que ainda nao receberam capa E cujo arquivo
 * sumiu do disco. Sao exatamente os que o backfill nao consegue atender.
 */
function buscarSemArquivo(db, limite) {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS cover_backfill (' +
    'produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)'
  ).run();

  const cand = db.prepare(
    // Nao existe coluna `category` na tabela: a categoria e DERIVADA do topico
    // pela mesma funcao que o publisher usa (getCategory), entao a capa regerada
    // fica coerente com a categoria em que o produto foi cadastrado.
    'SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.hotmart_product_id AS pid, e.cover_path ' +
    'FROM ebooks e ' +
    "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
    'AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT)) ' +
    'ORDER BY e.rowid DESC LIMIT ?'
  ).all(limite * 4);

  // Só quem NAO tem arquivo: quem tem e trabalho do backfill, que e mais barato.
  return cand.filter(e => !e.cover_path || !fs.existsSync(e.cover_path)).slice(0, limite);
}

/**
 * Modo TODAS: regera a capa mesmo de quem ja tem arquivo.
 *
 * O `buscarSemArquivo` existe para o passivo — quem perdeu o PNG pela retencao.
 * Este aqui e outra coisa: trocar a capa ANTIGA pela viral, inclusive nos que
 * ja estao no ar. Sao objetivos opostos, entao sao consultas separadas em vez
 * de um parametro que muda o sentido da primeira.
 *
 * O controle de "ja passou" nao pode ser a existencia do arquivo (todos tem) —
 * e uma tabela propria. Sem ela, uma segunda execucao regeraria as mesmas de
 * novo e o passe nunca terminaria.
 */
// Depois de tantas tentativas sem gancho, a capa sai com o titulo do proprio
// livro. Cada tentativa cai num ciclo diferente, e as cotas renovam (Gemini de
// madrugada, Groq em janela deslizante): 12 cobre mais de um dia de renovacoes.
// Sem este teto, livro que nunca ganha gancho — tema de saude que o filtro de
// alegacao sempre recusa, por exemplo — impediria o passe de terminar.
const MAX_TENTATIVAS_GANCHO = parseInt(process.env.MAX_TENTATIVAS_GANCHO || '12', 10);

function garantirTabelas(db) {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS cover_viral_v2 (' +
    'ebook_id TEXT PRIMARY KEY, quando INTEGER NOT NULL)'
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS cover_viral_tentativas (' +
    'ebook_id TEXT PRIMARY KEY, n INTEGER NOT NULL, ultimo INTEGER NOT NULL)'
  ).run();
}

/**
 * Menos tentado primeiro.
 *
 * A ordem era so por rowid: o item sem gancho nao era marcado e voltava no
 * ciclo seguinte, entao os 40 do topo se repetiam e a janela andava apenas
 * pelo que dava certo (~3 por ciclo). Um livro que nunca ganha gancho ficava na
 * frente para sempre, e o resto do catalogo so era alcancado quando a cota
 * sobrava. Ordenando pelo numero de tentativas, todo livro recebe a sua vez.
 */
function buscarTodas(db, limite) {
  garantirTabelas(db);
  return db.prepare(
    'SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.hotmart_product_id AS pid, e.cover_path, ' +
    'COALESCE(t.n, 0) AS tentativas ' +
    'FROM ebooks e ' +
    'LEFT JOIN cover_viral_tentativas t ON t.ebook_id = e.id ' +
    "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
    'AND NOT EXISTS (SELECT 1 FROM cover_viral_v2 v WHERE v.ebook_id = e.id) ' +
    'ORDER BY COALESCE(t.n, 0) ASC, e.rowid DESC LIMIT ?'
  ).all(limite);
}

function contarTentativa(db, ebookId) {
  db.prepare(
    'INSERT INTO cover_viral_tentativas (ebook_id, n, ultimo) VALUES (?, 1, ?) ' +
    'ON CONFLICT(ebook_id) DO UPDATE SET n = n + 1, ultimo = excluded.ultimo'
  ).run(ebookId, Date.now());
}

async function regerar(opts) {
  const o = opts || {};
  const limite = parseInt(o.limite || 20, 10);
  const todas = !!o.todas;
  const { getDb } = require('../core/database');
  const db = getDb();

  const itens = todas ? buscarTodas(db, limite) : buscarSemArquivo(db, limite);
  if (!itens.length) { log.info('nenhuma capa para regerar'); return { total: 0, ok: 0 }; }
  log.info('regerando ' + itens.length + ' capas');

  const { generateViralCover, ultimoTeveGancho } = require('./coverViralAgent');
  const { getCategory } = require('./publisherHotmart');
  const atualiza = db.prepare('UPDATE ebooks SET cover_path = ? WHERE id = ?');

  let ok = 0, semGancho = 0;
  const t0 = Date.now();
  // Espaco entre capas no passe TODAS. Pulando a imagem quando nao ha gancho,
  // quarenta itens passavam em dois minutos — rajada suficiente para estourar o
  // limite POR MINUTO dos provedores gratuitos e prender as chaves. 4 s mantem
  // o ritmo abaixo de 15 chamadas/min, sem pesar no passe (a imagem ja leva ~9 s).
  const PAUSA_MS = parseInt(process.env.REGEN_PAUSA_MS || (todas ? '4000' : '0'), 10);
  let primeiro = true;
  for (const e of itens) {
    if (!primeiro && PAUSA_MS > 0) await new Promise(r => setTimeout(r, PAUSA_MS));
    primeiro = false;
    try {
      const caminho = await generateViralCover(
        e.title, e.subtitle || '', e.topic || e.title,
        (() => { try { return getCategory(e.topic || e.title) || 'Outros'; } catch { return 'Outros'; } })(),
        COVERS_DIR,
        // Idioma do e-book: sem ele a capa de livro em ingles saia com badge e
        // kicker em portugues, contradizendo o proprio livro na primeira olhada.
        e.language || 'pt-BR',
        // No passe TODAS a capa so vale com gancho — sem ele ela voltaria para a
        // fila e a imagem teria sido gerada em vao.
        // Esgotado o teto de tentativas, sai com o titulo do proprio livro:
        // capa com rosto unico e titulo simples ainda e melhor que a antiga.
        { exigirGancho: todas && (e.tentativas || 0) < MAX_TENTATIVAS_GANCHO, exigirImagemUnica: todas }
      );
      if (caminho && fs.existsSync(caminho)) {
        // Gravar o caminho novo: e por ele que o backfill vai encontrar a capa.
        atualiza.run(caminho, e.id);
        // So marca como concluida a capa que saiu COM gancho de IA. Se o
        // provedor estava fora, a capa vale (a imagem e boa) mas o titulo e o
        // comum — deixar sem marca faz o proximo passe refazer com gancho.
        const comGancho = (() => { try { return ultimoTeveGancho(); } catch { return false; } })();
        if (!comGancho) semGancho++;
        const porTeto = todas && !comGancho && (e.tentativas || 0) >= MAX_TENTATIVAS_GANCHO;
        if (porTeto) log.warn('teto de tentativas: ' + e.pid + ' sai com o titulo do livro');
        if (todas && (comGancho || porTeto)) {
          db.prepare('INSERT OR REPLACE INTO cover_viral_v2 (ebook_id, quando) VALUES (?,?)').run(e.id, Date.now());
          // Reabrir para upload: sem isso o aplicador pula o produto por ja
          // constar como feito, e a capa nova ficaria so no disco do VPS.
          try { db.prepare('DELETE FROM cover_backfill WHERE produto = ?').run(String(e.pid)); } catch {}
        }
        ok++;
        log.info('OK  ' + e.pid + ' ' + String(e.title).slice(0, 42) + ' -> ' + path.basename(caminho));
      } else {
        // No passe TODAS o gerador devolve null justamente quando pulou por
        // falta de gancho — contar como "sem gancho" e nao como falha do
        // e-book, senao o relatorio esconde que o problema e a IA de texto.
        if (todas) { semGancho++; try { contarTentativa(db, e.id); } catch {} }
        log.warn('FALHA ' + e.pid + ' — gerador nao devolveu arquivo');
      }
    } catch (err) {
      log.warn('FALHA ' + e.pid + ': ' + String(err.message).slice(0, 90));
    }
  }

  const min = ((Date.now() - t0) / 60000).toFixed(1);
  log.info('regeracao: ' + ok + '/' + itens.length + ' em ' + min + ' min' +
    (semGancho ? ' | ' + semGancho + ' sem gancho de IA (serao refeitas)' : ''));
  return { total: itens.length, ok, semGancho, minutos: Number(min) };
}

module.exports = { regerar, buscarSemArquivo, buscarTodas, contarTentativa, garantirTabelas, MAX_TENTATIVAS_GANCHO };

if (require.main === module) {
  regerar({ limite: arg('limite', '20'), todas: process.argv.includes('--todas') })
    .then(r => { log.info('resumo'); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
}
