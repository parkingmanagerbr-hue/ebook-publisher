'use strict';
/**
 * publishBacklog.js — publica e-books JÁ PRONTOS que nunca foram a uma plataforma.
 *
 * A fila publish-ready do autonomousAgent só enxerga `status='ready'`, em lotes
 * de 5 e em série. O backlog real está invisível para ela: milhares de e-books
 * com `status='published'` (foram ao Cakto) mas com `hotmart_url` vazio — nunca
 * publicados lá, de quando o AUTO_PUBLISH_HOTMART ficou desligado. Medido em
 * 25/08/2026: 6.181 sem Hotmart e 438 sem Cakto, todos com PDF em disco.
 *
 * Publicar isso NÃO consome cota de LLM — o e-book já existe. É o único ganho de
 * throughput que não esbarra no teto da IA, que é onde a geração trava hoje.
 *
 * CONCORRÊNCIA POR PLATAFORMA, não global:
 *   Hotmart → paralelo. Usa sessão por cookie; não faz login a cada publicação.
 *   Cakto   → 1 por vez. Quando a sessão expira ele faz login com 2FA, e dois
 *             logins simultâneos disputariam o mesmo código de e-mail.
 *
 * Uso:
 *   node src/agents/publishBacklog.js --plataforma=hotmart --limite=10 --paralelo=3
 *   node src/agents/publishBacklog.js --plataforma=cakto --limite=5
 */
const path = require('path');

let log;
try { log = require('../core/logger').createLogger('publishBacklog'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

/**
 * Reserva um e-book para publicacao, de forma atomica entre processos.
 *
 * Sem isto, dois lotes concorrentes SELECIONAM o mesmo candidato: a marcacao so
 * acontece depois que o publish retorna, e ate la a linha continua elegivel.
 * Aconteceu de verdade — o e-book abaee126 ("Investir em Acoes com R$100") virou
 * DOIS produtos no Hotmart (8419956 e 8419962) porque um lote manual rodou junto
 * com o do cron. Produto duplicado em marketplace nao se desfaz sozinho.
 *
 * O INSERT numa tabela com PRIMARY KEY e a primitiva de exclusao: quem inserir
 * primeiro leva; o segundo recebe violacao de UNIQUE e pula. A reserva expira
 * para nao vazar item quando um lote morre no meio (SIGTERM ja aconteceu aqui).
 */
const RESERVA_MIN = parseInt(process.env.PUBLISH_CLAIM_MINUTES || '30', 10);

function garantirTabela(db) {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS publish_claims (' +
    'chave TEXT PRIMARY KEY, quando INTEGER NOT NULL)'
  ).run();
}

function reservar(db, ebookId, plataforma) {
  const chave = plataforma + ':' + ebookId;
  const agora = Date.now();
  const limite = agora - RESERVA_MIN * 60 * 1000;
  db.prepare('DELETE FROM publish_claims WHERE quando < ?').run(limite);
  try {
    db.prepare('INSERT INTO publish_claims (chave, quando) VALUES (?, ?)').run(chave, agora);
    return true;
  } catch (e) {
    return false;   // outro lote pegou primeiro
  }
}

function liberar(db, ebookId, plataforma) {
  try { db.prepare('DELETE FROM publish_claims WHERE chave = ?').run(plataforma + ':' + ebookId); }
  catch { /* reserva expira sozinha */ }
}

/** Busca e-books com PDF em disco e sem URL na plataforma alvo. */
function buscarPendentes(plataforma, limite) {
  const fs = require('fs');
  const { getDb } = require('../core/database');
  const db = getDb();
  const coluna = plataforma === 'hotmart' ? 'hotmart_url' : 'cakto_url';

  // Pega mais que o limite: parte tem PDF registrado mas sumido do disco
  // (retencao de artefatos apaga PDF antigo), e esses nao servem.
  const cand = db.prepare(
    'SELECT id, title, subtitle, topic, description, pdf_path, cover_path, price, language ' +
    'FROM ebooks WHERE (' + coluna + ' IS NULL OR ' + coluna + " = '') " +
    // ORDER BY rowid, nao por id: o id e UUID, entao ordenar por ele e ordem
    // ALFABETICA, nao cronologica. Com id DESC eu pescava e-books antigos, cujo
    // PDF a retencao ja apagou — 18 de 20 candidatos vinham sem arquivo e o
    // backlog parecia impublicavel. rowid DESC traz os mais recentes, que sao
    // justamente os que ainda tem PDF em disco.
    'AND pdf_path IS NOT NULL ORDER BY rowid DESC LIMIT ?'
  ).all(limite * 4);

  garantirTabela(db);
  const validos = [];
  let semArquivo = 0, reservados = 0;
  for (const e of cand) {
    if (validos.length >= limite) break;
    if (!e.pdf_path || !fs.existsSync(e.pdf_path)) { semArquivo++; continue; }
    if (!reservar(db, e.id, plataforma)) { reservados++; continue; }
    validos.push(e);
  }
  if (semArquivo) log.info('ignorados ' + semArquivo + ' sem PDF em disco (retencao ja apagou)');
  if (reservados) log.info('ignorados ' + reservados + ' ja reservados por outro lote');
  return validos;
}

/**
 * A sessao esta morta a ponto de nao adiantar tentar os proximos itens?
 *
 * O publisher tem uma sonda de sessao (sessaoHotmartViva) que consulta o CAS.
 * Ela deu FALSO POSITIVO: o TGT era valido, o CAS devolvia ST 200, e mesmo
 * assim o wizard caia em sso.hotmart.com/login. A sonda respondia `true`, cada
 * item gastava 90s esperando uma tela que nunca renderiza, e o lote inteiro
 * levava 13 minutos para publicar zero.
 *
 * O erro do proprio wizard e o sinal confiavel, porque vem de onde o trabalho
 * de fato acontece: se a pagina parou no SSO, nenhum item do lote vai passar.
 * Melhor abortar em ~1 min com motivo claro do que insistir 12 vezes.
 */
function sessaoMorta(motivo) {
  const m = String(motivo || '');
  return /sso\.hotmart\.com\/login/i.test(m)
    || /wizard not rendered/i.test(m)
    || /SESSAO_EXPIRADA/i.test(m);
}

async function publicarUm(ebook, plataforma) {
  const { updateEbookStatus } = require('../core/database');
  const dados = {
    title: ebook.title,
    subtitle: ebook.subtitle,
    topic: ebook.topic,
    description: ebook.description,
    pdfPath: ebook.pdf_path,
    coverPath: ebook.cover_path,
    price: ebook.price,
    language: ebook.language,
  };

  if (plataforma === 'hotmart') {
    const { publishToHotmart } = require('./publisherHotmart');
    const r = await publishToHotmart(dados);
    if (r && r.url) {
      updateEbookStatus(ebook.id, 'published', { hotmartUrl: r.url, hotmartProductId: r.hotmartProductId });
      return { ok: true, url: r.url };
    }
    // Produto criado mas nao finalizado ainda conta: o finalizeAgent aprova
    // depois, e sem gravar o id o proximo lote tentaria criar de novo (duplicata).
    if (r && r.hotmartProductId) {
      updateEbookStatus(ebook.id, 'published', { hotmartProductId: r.hotmartProductId });
      return { ok: false, motivo: 'rascunho criado (id=' + r.hotmartProductId + '), aguardando finalizacao' };
    }
    return { ok: false, motivo: (r && r.error) || 'sem url' };
  }

  const { publishToCakto } = require('./publisherCakto');
  const r = await publishToCakto(dados);
  if (r && r.url) {
    updateEbookStatus(ebook.id, 'published', { caktoUrl: r.url, caktoProductId: r.caktoProductId });
    return { ok: true, url: r.url };
  }
  return { ok: false, motivo: (r && r.error) || 'sem url' };
}

/** Executa `tarefas` com no maximo `n` simultaneas. */
async function comLimite(itens, n, fn) {
  const resultados = [];
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) {
      const idx = i++;
      try { resultados[idx] = await fn(itens[idx], idx); }
      catch (e) { resultados[idx] = { ok: false, motivo: e.message.slice(0, 100) }; }
    }
  });
  await Promise.all(trabalhadores);
  return resultados;
}

async function publicarBacklog(opts) {
  const o = opts || {};
  const plataforma = (o.plataforma || 'hotmart').toLowerCase();
  const limite = parseInt(o.limite || 10, 10);
  // Cakto trava em 1: login com 2FA nao suporta concorrencia.
  const paralelo = plataforma === 'cakto' ? 1 : Math.max(1, parseInt(o.paralelo || 3, 10));

  const pendentes = buscarPendentes(plataforma, limite);
  if (!pendentes.length) { log.info('nada pendente para ' + plataforma); return { total: 0, ok: 0 }; }

  log.info('backlog ' + plataforma + ': ' + pendentes.length + ' e-books, ' + paralelo + ' em paralelo');
  const t0 = Date.now();

  const { getDb } = require('../core/database');
  let abortado = null;

  const res = await comLimite(pendentes, paralelo, async (eb) => {
    // Sessao ja provada morta por um item anterior: os proximos so gastariam
    // 90s cada para falhar igual.
    if (abortado) return { ok: false, motivo: 'abortado: ' + abortado };

    let r;
    try {
      r = await publicarUm(eb, plataforma);
    } catch (e) {
      // O publisher LANCA em vez de devolver erro. Antes a excecao subia direto
      // para o comLimite e a linha de log abaixo nunca rodava: o lote fechava
      // "0/12" sem uma unica linha dizendo por que. Foi o que impediu o
      // diagnostico pelo log durante horas.
      r = { ok: false, motivo: (e && e.message ? e.message : String(e)).slice(0, 120) };
    }

    if (!r.ok) { try { liberar(getDb(), eb.id, plataforma); } catch {} }
    if (!r.ok && sessaoMorta(r.motivo)) abortado = r.motivo.slice(0, 60);

    log.info((r.ok ? 'OK  ' : 'FALHA ') + '[' + eb.id + '] ' + String(eb.title).slice(0, 45) + (r.ok ? ' -> ' + r.url : ' :: ' + r.motivo));
    return r;
  });

  if (abortado) log.warn('lote abortado — sessao inutilizavel: ' + abortado);

  const ok = res.filter(r => r && r.ok).length;
  const min = ((Date.now() - t0) / 60000).toFixed(1);
  log.info('backlog ' + plataforma + ': ' + ok + '/' + pendentes.length + ' publicados em ' + min + ' min');
  return { total: pendentes.length, ok, minutos: Number(min) };
}

module.exports = { publicarBacklog, buscarPendentes, sessaoMorta, comLimite, reservar, liberar, garantirTabela };

if (require.main === module) {
  publicarBacklog({
    plataforma: arg('plataforma', 'hotmart'),
    limite: arg('limite', '10'),
    paralelo: arg('paralelo', '3'),
  })
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
