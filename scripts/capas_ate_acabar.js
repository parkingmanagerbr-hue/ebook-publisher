'use strict';
/**
 * capas_ate_acabar.js — roda capa+idioma ate nao sobrar produto sem capa.
 *
 * A fila de capas vem em pedacos por um motivo estrutural: o aplicador so
 * enxerga produtos cuja imagem EXISTE em disco, e a retencao guarda 1.000
 * arquivos (KEEP_COVERS). O passivo antigo teve o PNG apagado ha muito tempo.
 *
 * Entao o ciclo e: aplicar o que da → quando a fila secar, mandar o VPS regerar
 * um bloco → aplicar de novo. Regerar tudo de uma vez nao adianta: a mesma
 * retencao apagaria as primeiras antes de subirem.
 *
 * Uso:  node scripts/capas_ate_acabar.js --lote=40 --ciclos=200
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const VPS = process.env.VPS_ALIAS || 'vps';
const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

function ssh(cmd, timeout) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=30', VPS, cmd],
    { encoding: 'utf8', timeout: timeout || 180000, maxBuffer: 8 * 1024 * 1024 });
}

/** Dispara a regeracao DESTACADA: segurar o ssh aberto ja derrubou o processo. */
function regerar(quantos) {
  try {
    // --todas: troca a capa ANTIGA pela viral tambem em quem ja tem arquivo.
    // Sem esta flag o regenerador so atende quem perdeu o PNG pela retencao, e
    // o catalogo antigo ficaria com a capa velha para sempre.
    ssh(`nohup docker exec ${CONTAINER} sh -c "cd /app && node src/agents/regenCovers.js --limite=${quantos} --todas" ` +
        `>> /opt/platform/logs/regen_covers.log 2>&1 &`, 60000);
    return true;
  } catch (e) {
    console.log('  (nao consegui disparar a regeracao: ' + String(e.message).slice(0, 70) + ')');
    return false;
  }
}

function dormir(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function aplicarLote(lote) {
  // Processo separado por lote: se um travar, o orquestrador segue vivo.
  const r = spawnSync(process.execPath, [path.join(__dirname, 'capas_em_lote.js'), '--limite=' + lote],
    { encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  const saida = (r.stdout || '') + (r.stderr || '');
  const m = saida.match(/TOTAL: (\d+)\/(\d+)/);
  const vazio = /nada pendente/.test(saida);
  return { ok: m ? parseInt(m[1], 10) : 0, total: m ? parseInt(m[2], 10) : 0, vazio, saida };
}

async function main() {
  const lote = parseInt(arg('lote', '40'), 10);
  const ciclos = parseInt(arg('ciclos', '200'), 10);
  let totalOk = 0, secasSeguidas = 0;
  const t0 = Date.now();

  for (let c = 1; c <= ciclos; c++) {
    const r = aplicarLote(lote);
    totalOk += r.ok;
    const min = ((Date.now() - t0) / 60000).toFixed(0);
    console.log(`[ciclo ${c}] ${r.ok}/${r.total} | acumulado ${totalOk} | ${min} min`);

    if (r.vazio || r.total === 0) {
      // Fila seca quase sempre significa capa apagada pela retencao, nao
      // trabalho concluido — a diferenca ja me custou um diagnostico errado.
      console.log('  fila seca — regerando ' + lote + ' capas no VPS...');
      if (!regerar(lote)) break;
      dormir(90000);                       // tempo de a regeracao produzir
      secasSeguidas++;
      // Tres secas seguidas mesmo apos regerar = nao ha mais o que alcancar.
      if (secasSeguidas >= 3) { console.log('nada mais a regerar — encerrando'); break; }
    } else {
      secasSeguidas = 0;
    }
  }
  console.log(`\nTOTAL GERAL: ${totalOk} capas em ${((Date.now() - t0) / 60000).toFixed(0)} min`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
