'use strict';
/**
 * backfill_capas_local.js — reenvia as capas RODANDO NA MAQUINA DO LOGIN.
 *
 * POR QUE ISTO NAO RODA NO VPS, ao contrario de todo o resto:
 * a Hotmart amarra a sessao a origem. Provado em 01/09/2026 com os MESMOS
 * cookies no MESMO instante — a maquina do usuario abria app.hotmart.com
 * normalmente enquanto o VPS era redirecionado para sso.hotmart.com/login.
 * Nenhum cookie vencido, CAS devolvendo ST 200 e JWT OK: a credencial e valida,
 * o app e que recusa sessao vinda de outra origem. Transplantar sessao para o
 * VPS e tratado como sequestro, e vai continuar quebrando por mais que se
 * ajuste detector, cron ou paralelismo.
 *
 * Aqui o script CONECTA ao Chrome ja aberto e logado (CDP 9223) em vez de subir
 * um navegador proprio — nao ha transplante de cookie nenhum.
 *
 * O banco e os PNGs continuam no VPS: cada capa e copiada sob demanda e apagada
 * depois, e o resultado e gravado la. A maquina local e so o braco que clica.
 *
 * Uso:
 *   node scripts/backfill_capas_local.js --limite=50
 *   node scripts/backfill_capas_local.js --limite=50 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

const TMP = path.join(os.tmpdir(), 'capas-hotmart');

function ssh(comando) {
  return execFileSync('ssh', [VPS, comando], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
}

/** Pergunta ao VPS quais produtos ainda esperam capa. */
function buscarPendentes(limite) {
  // O SELECT vive num arquivo dentro do container: escapar SQL atraves de
  // ssh + docker exec + node -e quebra o quoting de forma imprevisivel (ja
  // custou um diagnostico errado nesta mesma tarefa).
  const consulta = `
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db', { readonly: true });
    const rows = db.prepare(
      "SELECT e.hotmart_product_id AS pid, e.title, e.cover_path FROM ebooks e " +
      "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
      "AND e.cover_path IS NOT NULL AND e.cover_path <> '' " +
      "AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT)) " +
      "ORDER BY e.rowid DESC LIMIT ?"
    ).all(${limite} * 4);
    const ok = rows.filter(r => fs.existsSync(r.cover_path)).slice(0, ${limite});
    console.log(JSON.stringify(ok));
  `;
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'consulta.js');
  fs.writeFileSync(local, consulta);
  execFileSync('scp', [local, `${VPS}:/tmp/consulta.js`], { timeout: 120000 });
  ssh(`docker cp /tmp/consulta.js ${CONTAINER}:/app/consulta.js`);
  const saida = ssh(`docker exec ${CONTAINER} sh -c "cd /app && node consulta.js"`);
  const m = saida.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

function baixarCapa(remoto, destino) {
  ssh(`docker cp ${CONTAINER}:${remoto} /tmp/capa_atual.png`);
  execFileSync('scp', [`${VPS}:/tmp/capa_atual.png`, destino], { timeout: 120000 });
  return fs.existsSync(destino) && fs.statSync(destino).size > 1000;
}

function registrarNoVps(produto, ok) {
  // Gravar no VPS a cada item: a fila e a verdade, e um lote interrompido aqui
  // nao pode fazer o proximo passe reenviar tudo de novo.
  const sql = `INSERT OR REPLACE INTO cover_backfill (produto, quando, ok) VALUES ('${produto}', ${Date.now()}, ${ok ? 1 : 0});`;
  ssh(`docker exec ${CONTAINER} sh -c "cd /app && node -e \\"const D=require('better-sqlite3');const db=new D('/app/data/metrics.db');db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();db.exec(\\\\\\"${sql}\\\\\\");\\""`);
}

async function main() {
  const limite = parseInt(arg('limite', '20'), 10);
  const dryRun = process.argv.includes('--dry-run');

  console.log('consultando a fila no VPS...');
  const itens = buscarPendentes(limite);
  if (!itens.length) { console.log('nenhum produto pendente de capa'); return; }
  console.log(`${itens.length} capas a reenviar`);

  if (dryRun) {
    for (const i of itens) console.log('  [dry-run] ' + i.pid + ' ' + String(i.title).slice(0, 45));
    return;
  }

  const puppeteer = require('puppeteer');
  const { uploadCoverImage } = require('../src/agents/publisherHotmart');

  // CONECTAR, nao lancar: o navegador aberto e a origem autenticada.
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();

  let ok = 0, falhas = 0;
  const t0 = Date.now();
  fs.mkdirSync(TMP, { recursive: true });

  try {
    for (const [i, item] of itens.entries()) {
      const local = path.join(TMP, 'capa_' + item.pid + '.png');
      let sucesso = false;
      try {
        if (!baixarCapa(item.cover_path, local)) throw new Error('capa nao veio do VPS');
        sucesso = await uploadCoverImage(page, String(item.pid), local);
      } catch (e) {
        console.log('  erro: ' + String(e.message).slice(0, 90));
      }
      try { fs.unlinkSync(local); } catch {}

      // Registrar SEMPRE, inclusive falha: sem isso o item volta em todo passe.
      try { registrarNoVps(item.pid, sucesso); } catch (e) { console.log('  (nao gravei no VPS: ' + e.message.slice(0, 50) + ')'); }

      sucesso ? ok++ : falhas++;
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`[${i + 1}/${itens.length}] ${sucesso ? 'OK  ' : 'FALHA'} ${item.pid} ${String(item.title).slice(0, 40)}  (${min} min)`);
    }
  } finally {
    await page.close().catch(() => {});
    // NAO fechar o browser: ele e do usuario e a sessao precisa continuar viva.
    browser.disconnect();
  }

  console.log(`\nresultado: ${ok} enviadas, ${falhas} falharam, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
