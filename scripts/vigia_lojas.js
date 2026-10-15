'use strict';
/**
 * vigia_lojas.js — ORQUESTRADOR do vigia de publicação. Mede os FATOS reais
 * (backlog, token, horas sem publicar por loja, falhas de 24h no log) e chama a
 * regra pura (src/vigia-lojas.logic). Imprime UMA linha por problema:
 *
 *     <item>\t<texto>\t<acao>
 *
 * Nada quando está tudo bem. O relay (vigia_lojas.sh) é quem deduplica e manda
 * e-mail — este script só DECIDE o que é problema (o produto decide; o canal
 * repassa, padrão do CLAUDE.md).
 *
 * Roda DENTRO do container (tem metrics.db, a sessão e os logs). I/O de verdade,
 * então fica fora do gate de cobertura — a regra testável está no .logic.js.
 */
const fs = require('fs');
const path = require('path');
const { detectarProblemas, LOJAS_ATIVAS } = require('../src/vigia-lojas.logic');

const DB = process.env.METRICS_DB || '/app/data/metrics.db';
const SESSAO = process.env.HOTMART_SESSION_FILE || '/app/data/sessions/hotmart.json';
const LOG_DIR = process.env.LOG_DIR || '/app/logs';

function minutosDoToken() {
  const t = process.env.HOTMART_ACCESS_TOKEN || '';
  const parte = t.split('.')[1];
  if (!parte) return null; // sem JWT utilizável = tratado como ausente
  try {
    const p = JSON.parse(Buffer.from(parte, 'base64').toString());
    if (!p.exp) return null;
    return Math.round((p.exp - Date.now() / 1000) / 60);
  } catch (_) { return null; }
}

function temHmSsoExp() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSAO, 'utf8'));
    return (s.cookies || []).some(c => c.name === 'hmSsoExp');
  } catch (_) { return false; }
}

function medirBanco() {
  const Database = require('better-sqlite3');
  const db = new Database(DB, { readonly: true });
  try {
    const ready = db.prepare("SELECT count(*) total, COALESCE(MAX((julianday('now')-julianday(created_at))),0) dias FROM ebooks WHERE status='ready'").get();
    const lojas = {};
    const col = { hotmart: 'hotmart_product_id', cakto: 'cakto_product_id', kiwify: 'kiwify_product_id' };
    for (const loja of LOJAS_ATIVAS) {
      const c = col[loja];
      const r = db.prepare(`SELECT (julianday('now')-julianday(MAX(created_at)))*24 h FROM ebooks WHERE ${c} IS NOT NULL AND ${c} <> ''`).get();
      lojas[loja] = { horasSemPublicar: r && r.h != null ? Math.round(r.h) : null };
    }
    return { ready: { total: ready.total, diasMaisAntigo: Math.round(ready.dias) }, lojas };
  } finally { db.close(); }
}

function falhas24h() {
  // conta no log de HOJE (combined mais recente). Proxy honesto de 24h.
  let txt = '';
  try {
    const arqs = fs.readdirSync(LOG_DIR).filter(f => /^combined-.*\.log$/.test(f)).sort();
    if (arqs.length) txt = fs.readFileSync(path.join(LOG_DIR, arqs[arqs.length - 1]), 'utf8');
  } catch (_) {}
  const conta = re => (txt.match(re) || []).length;
  return {
    kiwifySemEntrega: conta(/SEM_ENTREGA na Kiwify/gi),
    caktoWizard: conta(/no_pdf_input|Cover file input not found|PDF file input not found/gi),
  };
}

function main() {
  let fatos;
  try {
    const banco = medirBanco();
    fatos = {
      ready: banco.ready,
      token: { hotmartExpiraMin: minutosDoToken(), hotmartTemHmSsoExp: temHmSsoExp() },
      lojas: banco.lojas,
      falhas24h: falhas24h(),
    };
  } catch (e) {
    // não conseguir medir é problema em si — e precisa deixar rastro, não liberar.
    process.stdout.write(`vigia-erro\tvigia das lojas não conseguiu medir: ${String(e.message).slice(0, 120)}\tChecar o container do ebook-publisher e o metrics.db.\n`);
    process.exit(0);
  }
  // loja ativa = não explicitamente desligada por AUTO_PUBLISH_<LOJA>=false.
  // (Hotmart ficou false apos a conta ser encerrada; Kiwify nao tem flag -> ativa.)
  const ativas = LOJAS_ATIVAS.filter(l => process.env['AUTO_PUBLISH_' + l.toUpperCase()] !== 'false');
  for (const p of detectarProblemas(fatos, { lojasAtivas: ativas })) {
    process.stdout.write(`${p.item}\t${p.texto}\t${p.acao}\n`);
  }
}

main();
