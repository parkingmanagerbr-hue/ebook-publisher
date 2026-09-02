'use strict';
/**
 * backfill_capas_local.js — regera e reenvia capas, RODANDO NA MAQUINA DO LOGIN.
 *
 * POR QUE ISTO NAO RODA NO VPS, ao contrario de todo o resto:
 * a Hotmart amarra a sessao a origem. Provado em 01/09/2026 com os MESMOS
 * cookies no MESMO instante — a maquina do usuario abria app.hotmart.com
 * normalmente enquanto o VPS era redirecionado para sso.hotmart.com/login.
 * Nenhum cookie vencido, CAS devolvendo ST 200 e JWT OK: a credencial e valida,
 * o app e que recusa sessao vinda de outra origem. Transplantar sessao para o
 * VPS e tratado como sequestro e vai continuar quebrando por mais que se ajuste
 * detector, cron ou paralelismo.
 *
 * Aqui o script CONECTA ao Chrome ja aberto e logado (CDP 9223) em vez de subir
 * um navegador com cookies transplantados.
 *
 * CICLO REGERAR -> ENVIAR: dos produtos sem capa, a retencao (KEEP_COVERS=1000)
 * ja apagou o PNG de praticamente todos. Buscar a fila sem regerar antes devolve
 * vazio e parece "trabalho concluido" — foi exatamente o engano que me fez
 * reportar fila cheia quando nao havia nada alcancavel. Por isso cada ciclo
 * regera um lote pequeno e envia em seguida, antes que a retencao apague de novo.
 *
 * O banco e os PNGs continuam no VPS; a maquina local e so o braco que clica.
 *
 * Uso:
 *   node scripts/backfill_capas_local.js --limite=20 --ciclos=30
 *   node scripts/backfill_capas_local.js --limite=5 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const TMP = path.join(os.tmpdir(), 'capas-hotmart');

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

function ssh(comando, timeout) {
  return execFileSync('ssh', [VPS, comando], {
    encoding: 'utf8', timeout: timeout || 180000, maxBuffer: 8 * 1024 * 1024,
  });
}

/** Fila real: produto sem capa no Hotmart cujo PNG existe no disco do VPS. */
function buscarPendentes(limite) {
  // O SELECT vai num ARQUIVO para dentro do container: escapar SQL atraves de
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
    ).all(${limite} * 6);
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

/**
 * Manda o VPS regerar capas — DESTACADO, e depois espera a fila encher.
 *
 * Segurar o ssh aberto durante a regeracao ja derrubou o processo: com a IA de
 * volta, cada capa passa pelo LLM do packaging e o lote estourou o timeout do
 * ssh, matando o backfill inteiro no meio ("nada regerado; encerrando"). O
 * trabalho remoto nao pode depender da duracao de uma conexao local.
 *
 * Entao dispara com nohup e PERGUNTA A FILA a cada 20s ate aparecer trabalho.
 */
/**
 * Espera SINCRONA sem processo externo. O `timeout` do Windows exige console
 * interativo e falha com stdio redirecionado; `sleep` nao existe la. Atomics
 * funciona igual nos dois e nao gasta CPU.
 */
function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function regerarNoVps(quantos, esperaMax) {
  const limite = esperaMax || 20 * 60 * 1000;
  try {
    ssh(`nohup docker exec ${CONTAINER} sh -c "cd /app && node src/agents/regenCovers.js --limite=${quantos}" >> /opt/platform/logs/regen_covers.log 2>&1 &`, 60000);
  } catch (e) {
    console.log('  (nao consegui disparar a regeracao: ' + String(e.message).slice(0, 70) + ')');
    return 0;
  }
  // Esperar o LOTE, nao o primeiro item. Voltar assim que aparece 1 capa fazia
  // o ciclo processar um item por vez e pagar o custo fixo do ciclo (consulta +
  // conexao) a cada capa — o ciclo 3 rodou com exatamente 1 item.
  const alvo = Math.max(2, Math.ceil(quantos * 0.6));
  const t0 = Date.now();
  let ultima = 0;
  while (Date.now() - t0 < limite) {
    dormir(20000);
    const fila = buscarPendentes(quantos);
    if (fila.length >= alvo) return fila.length;
    // Regeracao terminou (parou de crescer por 2 rodadas) e ja ha trabalho:
    // seguir com o que tem em vez de esperar o limite inteiro.
    if (fila.length && fila.length === ultima) return fila.length;
    ultima = fila.length;
  }
  return ultima;
}

function baixarCapa(remoto, destino) {
  ssh(`docker cp ${CONTAINER}:${remoto} /tmp/capa_atual.png`);
  execFileSync('scp', [`${VPS}:/tmp/capa_atual.png`, destino], { timeout: 120000 });
  return fs.existsSync(destino) && fs.statSync(destino).size > 1000;
}

function registrarNoVps(produto, ok) {
  // Gravar no VPS a cada item: a fila e a verdade, e um lote interrompido aqui
  // nao pode fazer o proximo passe reenviar tudo de novo.
  const js = `const D=require('better-sqlite3');const db=new D('/app/data/metrics.db');` +
    `db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();` +
    `db.prepare('INSERT OR REPLACE INTO cover_backfill (produto, quando, ok) VALUES (?,?,?)').run('${produto}',${Date.now()},${ok ? 1 : 0});`;
  const local = path.join(TMP, 'reg.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, `${VPS}:/tmp/reg.js`], { timeout: 120000 });
  ssh(`docker cp /tmp/reg.js ${CONTAINER}:/app/reg.js && docker exec ${CONTAINER} sh -c "cd /app && node reg.js"`);
}

/** Envia um lote pelo Chrome ja logado. Devolve quantas subiram. */
async function enviar(itens, page) {
  const { uploadCoverImage } = require('../src/agents/publisherHotmart');
  let ok = 0;
  fs.mkdirSync(TMP, { recursive: true });

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

    // Registrar SEMPRE, inclusive falha: sem isso o item volta em todo passe e
    // a fila gira em falso sobre os mesmos produtos.
    try { registrarNoVps(item.pid, sucesso); }
    catch (e) { console.log('  (nao gravei no VPS: ' + String(e.message).slice(0, 50) + ')'); }

    if (sucesso) ok++;
    console.log(`  [${i + 1}/${itens.length}] ${sucesso ? 'OK  ' : 'FALHA'} ${item.pid} ${String(item.title).slice(0, 40)}`);
  }
  return ok;
}

async function main() {
  const limite = parseInt(arg('limite', '20'), 10);
  const ciclos = parseInt(arg('ciclos', '1'), 10);
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    const itens = buscarPendentes(limite);
    console.log(itens.length + ' na fila com PNG em disco');
    for (const i of itens) console.log('  [dry-run] ' + i.pid + ' ' + String(i.title).slice(0, 45));
    return;
  }

  const puppeteer = require('puppeteer');
  // CONECTAR, nao lancar: o navegador aberto e a origem autenticada.
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();

  let total = 0;
  const t0 = Date.now();
  try {
    for (let c = 1; c <= ciclos; c++) {
      let itens = buscarPendentes(limite);
      if (!itens.length) {
        console.log(`\n[ciclo ${c}/${ciclos}] fila vazia — regerando ${limite} capas no VPS...`);
        const geradas = regerarNoVps(limite);
        if (!geradas) { console.log('nada regerado; encerrando'); break; }
        itens = buscarPendentes(limite);
        if (!itens.length) { console.log('regerou mas a fila segue vazia; encerrando'); break; }
      }
      console.log(`\n[ciclo ${c}/${ciclos}] enviando ${itens.length} capas`);
      total += await enviar(itens, page);
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`[ciclo ${c}/${ciclos}] acumulado: ${total} capas em ${min} min`);
    }
  } finally {
    await page.close().catch(() => {});
    // NAO fechar o browser: ele e do usuario e a sessao precisa seguir viva.
    browser.disconnect();
  }

  console.log(`\nTOTAL: ${total} capas enviadas em ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
