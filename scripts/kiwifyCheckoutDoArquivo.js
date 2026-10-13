'use strict';
/**
 * kiwifyCheckoutDoArquivo.js — leva o link de compra PUBLICO da Kiwify para o
 * banco, a partir do arquivo da auditoria (somente leitura) da conta.
 *
 * Por que: `kiwify_url` guarda o endereco do PAINEL do vendedor; a vitrine nao
 * tinha como mandar o visitante para a Kiwify (dry-run de 13/10/2026: "por loja
 * {hotmart: 7951}", zero Kiwify em 1.419 produtos). O checkout publico e
 * pay.kiwify.com.br/<id do plano ativo>, e a auditoria mediu um por produto.
 *
 * Entra so o produto que o comprador consegue comprar E receber: status
 * active, sem soft_ban, entrega "ok" e checkout no formato. Produto ativo com
 * entrega vazia (achado na mesma auditoria) NAO vai para a vitrine — mandar o
 * visitante pagar por algo que nao chega e o pior link possivel. Quando a
 * linha do arquivo diz que o produto deixou de servir, o checkout gravado e
 * LIMPO, e o livro so e tocado se `kid` for o produto ligado a ele no banco.
 *
 * Uso (no container):
 *   node scripts/kiwifyCheckoutDoArquivo.js [--arquivo=/app/data/kiwify_auditoria.jsonl] [--dry-run]
 */
const fs = require('fs');
const { CHECKOUT_KIWIFY } = require('../src/agents/kiwifyRegras');

let log;
try { log = require('../src/core/logger').createLogger('kiwifyCheckout'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : p; };

/**
 * Decide o que uma linha da auditoria faz com o livro. Pura.
 * { acao: 'gravar', checkout } | { acao: 'limpar', motivo } | { acao: 'ignorar', motivo }
 */
function decidirLinha(l) {
  if (!l || typeof l !== 'object' || !l.ebook || !l.kid) return { acao: 'ignorar', motivo: 'linha-incompleta' };
  if (l.http !== 200) return { acao: 'ignorar', motivo: 'leitura-falhou' };   // nao mediu: nao conclui nada
  if (l.status !== 'active') return { acao: 'limpar', motivo: 'inativo' };
  if (l.soft_ban !== false) return { acao: 'limpar', motivo: 'soft-ban' };
  if (l.entrega !== 'ok') return { acao: 'limpar', motivo: 'sem-entrega' };
  if (!CHECKOUT_KIWIFY.test(String(l.checkout || ''))) return { acao: 'limpar', motivo: 'checkout-fora-do-formato' };
  return { acao: 'gravar', checkout: l.checkout };
}

/** Le o jsonl; linha que nao e JSON e contada, nunca derruba a importacao. */
function lerArquivo(texto) {
  const linhas = [];
  let ilegiveis = 0;
  for (const bruta of String(texto).split(/\r?\n/)) {
    if (!bruta.trim()) continue;
    try { linhas.push(JSON.parse(bruta)); } catch (_) { ilegiveis++; }
  }
  return { linhas, ilegiveis };
}

function prepararBanco(db) {
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  for (const c of ['kiwify_product_id', 'kiwify_checkout']) {
    if (!cols.includes(c)) db.prepare('ALTER TABLE ebooks ADD COLUMN ' + c + ' TEXT').run();
  }
}

function importar(db, texto, { seco = false } = {}) {
  prepararBanco(db);
  const { linhas, ilegiveis } = lerArquivo(texto);
  const resumo = { linhas: linhas.length, ilegiveis, gravados: 0, limpos: 0, ignorados: 0, produtoNaoConfere: 0, motivos: {} };
  // Ultima linha de cada livro vale (a auditoria pode ter medido duas vezes).
  const porLivro = new Map();
  for (const l of linhas) porLivro.set(l && l.ebook, l);
  const ligado = db.prepare('SELECT kiwify_product_id FROM ebooks WHERE id = ?');
  const grava = db.prepare('UPDATE ebooks SET kiwify_checkout = ? WHERE id = ?');
  const aplicar = db.transaction(() => {
    for (const l of porLivro.values()) {
      const d = decidirLinha(l);
      if (d.acao === 'ignorar') { resumo.ignorados++; resumo.motivos[d.motivo] = (resumo.motivos[d.motivo] || 0) + 1; continue; }
      const atual = ligado.get(String(l.ebook));
      if (!atual || String(atual.kiwify_product_id || '') !== String(l.kid)) { resumo.produtoNaoConfere++; continue; }
      if (d.acao === 'gravar') { if (!seco) grava.run(d.checkout, String(l.ebook)); resumo.gravados++; }
      else { if (!seco) grava.run(null, String(l.ebook)); resumo.limpos++; resumo.motivos[d.motivo] = (resumo.motivos[d.motivo] || 0) + 1; }
    }
  });
  aplicar();
  return resumo;
}

if (require.main === module) {
  try {
    const arquivo = arg('arquivo', '/app/data/kiwify_auditoria.jsonl');
    const seco = process.argv.includes('--dry-run');
    const db = require('../src/core/database').getDb();
    const r = importar(db, fs.readFileSync(arquivo, 'utf8'), { seco });
    log.info('importacao do checkout da Kiwify' + (seco ? ' (dry-run)' : '') + ': ' + JSON.stringify(r));
    console.log(JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    log.error('ERRO: ' + String(e && e.message).replace(/[\r\n]+/g, ' ').slice(0, 200));
    console.error('ERRO: ' + String(e && e.message).slice(0, 200));
    process.exit(1);
  }
}

module.exports = { decidirLinha, lerArquivo, importar, prepararBanco };
