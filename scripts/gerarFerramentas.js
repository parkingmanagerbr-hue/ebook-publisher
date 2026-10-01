'use strict';
/**
 * gerarFerramentas.js — cria a ferramenta (plano de acao) dos livros do piloto.
 *
 * Piloto decidido pelo dono em 30/09/2026: os 20 livros em destaque ganham uma
 * ferramenta, acessada pela area de membros da loja e vendida em combo.
 *
 * Por livro:
 *   1. pega o texto (guardado no banco; senao extrai do PDF e GUARDA — a fonte
 *      vale mais que o derivado, licao de 23/09/2026);
 *   2. pede o plano a IA UMA vez (duas tentativas no maximo);
 *   3. a resposta passa por `lerEspecificacao`: promessa de resultado, numero
 *      inventado ou "gerado por IA" derrubam a ferramenta;
 *   4. grava a pagina em /ferramentas/<token>/, com token aleatorio — o
 *      endereco nao e adivinhavel e a pagina e noindex.
 *
 * Idempotente: livro que ja tem ferramenta e pulado (--refazer forca).
 *
 * Uso (no container):
 *   node scripts/gerarFerramentas.js --ebook=<id>
 *   node scripts/gerarFerramentas.js --destaques --limite=20
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { montarPedido, lerEspecificacao, totalDeAcoes } = require('../src/ferramentas/especificacao');
const { paginaDaFerramenta } = require('../src/ferramentas/pagina');

let log;
try { log = require('../src/core/logger').createLogger('ferramentas'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const SITE = process.env.SITE_ROOT || '/app/landing_pages';
const BASE_URL = 'https://veloxisit.com.br/ferramentas/';
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const temFlag = n => process.argv.includes('--' + n);
const umaLinha = (s, n = 70) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

function prepararBanco(db) {
  db.prepare('CREATE TABLE IF NOT EXISTS ferramentas (ebook_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, especificacao TEXT NOT NULL, criado_em INTEGER NOT NULL)').run();
}

/** O texto do livro: do banco, ou extraido do PDF (e entao guardado). */
async function textoDoLivro(db, e) {
  const guardado = db.prepare('SELECT conteudo FROM ebook_conteudo WHERE ebook_id = ?').get(e.id);
  if (guardado && String(guardado.conteudo || '').length > 2000) return { texto: guardado.conteudo, origem: 'banco' };
  const { lerPdf } = require('../src/agents/qualityAgent');
  const dados = await lerPdf(fs.readFileSync(e.pdf_path));
  const texto = String(dados.text || '');
  if (texto.length < 2000) throw new Error('PDF com texto insuficiente (' + texto.length + ' caracteres)');
  const palavras = texto.split(/\s+/).filter(Boolean).length;
  db.prepare('INSERT OR IGNORE INTO ebook_conteudo (ebook_id, conteudo, palavras, quando) VALUES (?, ?, ?, ?)')
    .run(e.id, texto, palavras, Date.now());
  return { texto, origem: 'pdf (guardado agora)' };
}

function gravarPagina(token, esp) {
  const dir = path.join(SITE, 'ferramentas', token);
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'index.html');
  const tmp = destino + '.tmp' + process.pid;
  fs.writeFileSync(tmp, paginaDaFerramenta(esp, { chave: token.slice(0, 12) }));
  fs.renameSync(tmp, destino);
  return BASE_URL + token + '/';
}

async function gerarUma(db, e, { refazer = false, gerar } = {}) {
  const ja = db.prepare('SELECT token FROM ferramentas WHERE ebook_id = ?').get(e.id);
  if (ja && !refazer) return { estado: 'ja-existe', url: BASE_URL + ja.token + '/' };

  const { texto, origem } = await textoDoLivro(db, e);
  const pedido = montarPedido(e, texto);
  let motivos = [];
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const extra = motivos.length ? '\n\nA resposta anterior foi recusada por: ' + motivos.join('; ') + '. Corrija.' : '';
    const r = await gerar(pedido + extra, 'Você organiza livros práticos em planos de ação. Responda só JSON.', { maxTokens: 3500 });
    const lido = lerEspecificacao(r && r.text, e);
    if (lido.ok) {
      const token = ja ? ja.token : crypto.randomBytes(12).toString('hex');
      const url = gravarPagina(token, lido.especificacao);
      db.prepare('INSERT OR REPLACE INTO ferramentas (ebook_id, token, especificacao, criado_em) VALUES (?, ?, ?, ?)')
        .run(e.id, token, JSON.stringify(lido.especificacao), Date.now());
      return {
        estado: 'criada', url, origem, tentativas: tentativa, provedor: r && r.provider,
        capitulos: lido.especificacao.capitulos.length, acoes: totalDeAcoes(lido.especificacao),
        aviso: !!lido.especificacao.aviso,
      };
    }
    motivos = lido.motivos;
    log.warn('recusada (tentativa ' + tentativa + ') "' + umaLinha(e.title, 50) + '": ' + umaLinha(motivos.join('; '), 160));
  }
  return { estado: 'recusada', motivos };
}

/**
 * Proximos livros para ganhar ferramenta, depois do piloto (01/10/2026).
 *
 * Os 20 "destaques" do piloto acabaram. O ml_score esta zerado em todos os
 * livros, entao a ordem vem da demanda do TEMA. So entra livro que ja esta nas
 * duas lojas (o combo sobe onde o livro vende), em portugues, com o PDF de
 * VERDADE no disco (o campo preenchido nao basta: metade do catalogo perdeu o
 * arquivo) e que ainda nao tem ferramenta nem e ele proprio um combo.
 */
function proximosCandidatos(db, limite, existe = fs.existsSync) {
  const linhas = db.prepare(
    "SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.pdf_path FROM ebooks e " +
    "LEFT JOIN topics t ON t.topic = e.topic " +
    "LEFT JOIN ferramentas f ON f.ebook_id = e.id " +
    "WHERE f.ebook_id IS NULL AND (e.combo_de IS NULL OR e.combo_de = '') " +
    "AND LOWER(COALESCE(e.language, '')) LIKE 'pt%' " +
    "AND COALESCE(e.hotmart_product_id, '') <> '' AND COALESCE(e.cakto_product_id, '') <> '' " +
    "ORDER BY COALESCE(t.demand_score, 0) DESC, e.rowid DESC"
  ).all();
  // Um livro por TEMA: o catalogo tem o mesmo tema gerado varias vezes
  // ("Devocional Diario: 365 Dias com Deus" quatro vezes), e sem isto o lote
  // virava combos repetidos do mesmo assunto. Tema que ja ganhou ferramenta
  // tambem fica de fora.
  const tema = (t) => String(t || '').trim().toLowerCase();
  const vistos = new Set(db.prepare(
    'SELECT e.topic FROM ferramentas f JOIN ebooks e ON e.id = f.ebook_id'
  ).all().map((r) => tema(r.topic)));
  const saida = [];
  for (const l of linhas) {
    if (saida.length >= limite) break;
    const t = tema(l.topic);
    if (t && vistos.has(t)) continue;
    if (!(l.pdf_path && existe(l.pdf_path))) continue;
    if (t) vistos.add(t);
    saida.push(l);
  }
  return saida;
}

async function principal() {
  const db = require('../src/core/database').getDb();
  prepararBanco(db);
  const limite = Number(arg('limite', '1')) || 1;
  const um = arg('ebook', null);
  const sql = um
    ? "SELECT id, title, subtitle, topic, language, pdf_path FROM ebooks WHERE id = ?"
    : "SELECT e.id, e.title, e.subtitle, e.topic, e.language, e.pdf_path FROM afiliacao_hotmart a " +
      "JOIN ebooks e ON CAST(e.hotmart_product_id AS TEXT) = a.produto WHERE a.destaque = 1 ORDER BY a.quando ASC";
  const livros = temFlag('proximos')
    ? proximosCandidatos(db, limite)
    : (um ? db.prepare(sql).all(um) : db.prepare(sql).all()).slice(0, limite);
  if (!livros.length) { log.warn('nenhum livro para gerar'); return { criadas: 0 }; }

  const { generate } = require('../src/core/aiClient');
  const resumo = { criadas: 0, jaExistiam: 0, recusadas: 0, falhas: 0, urls: [] };
  for (const e of livros) {
    try {
      const r = await gerarUma(db, e, { refazer: temFlag('refazer'), gerar: generate });
      if (r.estado === 'criada') {
        resumo.criadas++; resumo.urls.push(r.url);
        log.info('criada "' + umaLinha(e.title, 50) + '" | ' + r.capitulos + ' capitulos, ' + r.acoes + ' acoes' +
          (r.aviso ? ', com aviso' : '') + ' | texto: ' + r.origem + ' | ' + r.provedor + ' | ' + r.url);
      } else if (r.estado === 'ja-existe') {
        resumo.jaExistiam++; resumo.urls.push(r.url);
      } else {
        resumo.recusadas++;
        log.warn('SEM ferramenta "' + umaLinha(e.title, 50) + '": ' + umaLinha((r.motivos || []).join('; '), 160));
      }
    } catch (err) {
      resumo.falhas++;
      log.error('falha "' + umaLinha(e.title, 50) + '": ' + umaLinha(err && err.message, 160));
    }
  }
  return resumo;
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r).slice(0, 600)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal, gerarUma, textoDoLivro, prepararBanco, proximosCandidatos };
