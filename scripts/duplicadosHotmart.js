'use strict';
/**
 * duplicadosHotmart.js — tira de venda as copias duplicadas da Hotmart.
 *
 * Em 16/09/2026 havia 214 copias (160 titulos). Para cada titulo repetido fica
 * UM produto com arquivo confirmado (ver hotmartCatalogo.decidirGrupo) e as
 * copias tem as vendas desligadas — o mesmo botao "Vendas ativas" do painel
 * (PUT .../sales?salesEnable=false), reversivel com salesEnable=true. Nada e
 * excluido: produto com venda nao pode ser apagado e o historico fica.
 *
 * A copia vai para hotmart_copias; sincronizarVendas passa a contar venda dela
 * no produto que ficou.
 *
 * Uso (no container):
 *   node scripts/duplicadosHotmart.js              # relatorio
 *   node scripts/duplicadosHotmart.js --aplicar
 *   node scripts/duplicadosHotmart.js --reativar=8487806   # desfaz uma copia
 */
const fs = require('fs');
const cat = require('../src/agents/hotmartCatalogo');
const { consultarConteudo } = require('../src/agents/hotmartConteudo');

const API = 'https://api-product.vulcano.hotmart.com/product/v1/product/';
const PAUSA_MS = parseInt(process.env.DUP_PAUSA_MS || '1200', 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function vendasAtivas(id, ativo, token) {
  const r = await fetch(API + id + '/sales?salesEnable=' + (ativo ? 'true' : 'false') + '&notifyAffiliateSalesStatus=false', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json', 'x-app-name': 'app-product' },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const reativar = (process.argv.find(a => a.startsWith('--reativar=')) || '').split('=')[1];
  const token = fs.readFileSync(process.env.HOTMART_TOKEN_FILE || '/app/data/hotmart_access_token.txt', 'utf8').trim();
  const db = require('../src/core/database').getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS hotmart_copias (copia TEXT PRIMARY KEY, canonico TEXT NOT NULL, titulo TEXT, pausada INTEGER, quando INTEGER)').run();

  if (reativar) {
    await vendasAtivas(reativar, true, token);
    db.prepare('DELETE FROM hotmart_copias WHERE copia = ?').run(String(reativar));
    console.log('vendas reativadas em ' + reativar);
    return;
  }

  const catalogo = await cat.baixarCatalogo(token);
  const grupos = cat.agruparDuplicados(catalogo);
  const conj = sql => { try { return new Set(db.prepare(sql).all().map(r => String(r.p))); } catch { return new Set(); } };
  const info = {
    noBanco: conj("SELECT hotmart_product_id p FROM ebooks WHERE hotmart_product_id IS NOT NULL AND hotmart_product_id <> ''"),
    destaques: conj('SELECT produto p FROM afiliacao_hotmart WHERE destaque = 1'),
    semArquivo: conj('SELECT produto p FROM hotmart_sem_arquivo'),
    vendas: new Map(),
  };
  try { for (const r of db.prepare('SELECT produto_id p, COUNT(*) n FROM vendas_hotmart GROUP BY 1').all()) info.vendas.set(String(r.p), r.n); } catch { /* sem vendas */ }

  const jaFeitas = new Set(db.prepare('SELECT copia FROM hotmart_copias WHERE pausada = 1').all().map(r => r.copia));
  const grava = db.prepare('INSERT INTO hotmart_copias VALUES (?,?,?,?,?) ON CONFLICT(copia) DO UPDATE SET canonico = excluded.canonico, pausada = excluded.pausada, quando = excluded.quando');
  const cont = { grupos: grupos.length, copias: 0, pausadas: 0, jaPausadas: 0, semDecisao: 0, erros: 0 };
  const cacheArquivo = new Map();
  const temArquivo = async id => {
    if (!cacheArquivo.has(id)) { cacheArquivo.set(id, await consultarConteudo(id, { token })); await dormir(300); }
    return cacheArquivo.get(id);
  };

  for (const g of grupos) {
    const d = await cat.decidirGrupo(g, info, temArquivo);
    if (!d) { cont.semDecisao++; console.log('sem copia com arquivo confirmado: ' + g.map(p => p.id).join(',') + ' ' + String(g[0].name).slice(0, 50)); continue; }
    for (const copia of d.copias) {
      cont.copias++;
      if (jaFeitas.has(copia)) { cont.jaPausadas++; continue; }
      if (!aplicar) { grava.run(copia, d.fica, g[0].name, 0, Date.now()); continue; }
      try {
        await vendasAtivas(copia, false, token);
        grava.run(copia, d.fica, g[0].name, 1, Date.now());
        cont.pausadas++;
      } catch (e) {
        cont.erros++;
        console.log('erro ' + copia + ': ' + e.message);
        if (/HTTP 40[13]/.test(e.message)) { console.log('token recusado — parando'); break; }
      }
      await dormir(PAUSA_MS);
    }
  }
  console.log(JSON.stringify(cont));
}

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
