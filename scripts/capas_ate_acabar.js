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

/**
 * Regera um bloco e ESPERA terminar, devolvendo o resultado.
 *
 * Antes isto era disparado destacado (`nohup ... &`) e o orquestrador seguia sem
 * saber o que aconteceu — decidia "acabou" pela fila de UPLOAD, que so enche
 * quando a capa sai COM gancho. Numa janela de IA fraca, 4 de 40 ganhavam gancho
 * e o loop lia isso como catalogo terminado. Quem manda no fim e a regeracao.
 */
function regerar(quantos) {
  try {
    const saida = ssh(
      `docker exec ${CONTAINER} sh -c "cd /app && node src/agents/regenCovers.js --limite=${quantos} --todas"`,
      50 * 60 * 1000);
    const m = saida.match(/\{"total":(\d+),"ok":(\d+),"semGancho":(\d+)/);
    if (!m) return { total: 0, ok: 0, semGancho: 0 };
    return { total: +m[1], ok: +m[2], semGancho: +m[3] };
  } catch (e) {
    console.log('  (regeracao falhou: ' + String(e.message).slice(0, 70) + ')');
    return null;
  }
}

/**
 * Destrava provedor de IA que ja voltou.
 *
 * Sem isto o gancho para de sair no meio do passe: um 429 passageiro marca o
 * provedor por horas e as capas seguintes saem com o titulo comum. A sondagem
 * pergunta a API antes de liberar, entao rodar de rotina nao mascara queda real.
 */
function destravarIA() {
  try { ssh(`docker exec ${CONTAINER} sh -c "cd /app && node scripts/destravar_ia.js"`, 180000); } catch {}
}

function dormir(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function aplicarLote(lote) {
  // Processo separado por lote: se um travar, o orquestrador segue vivo.
  const r = spawnSync(process.execPath, [path.join(__dirname, 'capas_em_lote.js'), '--limite=' + lote],
    { encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  const saida = (r.stdout || '') + (r.stderr || '');
  const m = saida.match(/TOTAL: (\d+)\/(\d+)/);
  const vazio = /nada pendente/.test(saida);
  // Sem TOTAL e sem "nada pendente", o filho QUEBROU. Antes isso virava um
  // "subidas 0/0" mudo: foi assim que o upload ficou parado por ciclos inteiros
  // quando o tar do Windows recusou uma opcao — o erro existia, mas era
  // descartado junto com o resto da saida do filho.
  if (!m && !vazio) {
    const fim = saida.trim().split('\n').slice(-4).join(' | ');
    console.log('  upload QUEBROU (codigo ' + r.status + '): ' + (fim || 'sem saida').slice(0, 300));
  }
  return { ok: m ? parseInt(m[1], 10) : 0, total: m ? parseInt(m[2], 10) : 0, vazio, saida };
}

async function main() {
  const lote = parseInt(arg('lote', '40'), 10);
  const ciclos = parseInt(arg('ciclos', '200'), 10);
  let totalOk = 0, totalGeradas = 0, semGanchoAcum = 0, falhasSeguidas = 0;
  const t0 = Date.now();

  for (let c = 1; c <= ciclos; c++) {
    destravarIA();                          // gancho depende de provedor vivo
    const g = regerar(lote);
    if (!g) {
      // Falha transitoria nao pode matar um passe de horas. A primeira queda
      // real foi o proprio CI redeployando o container depois de um push meu:
      // o docker exec falhou por segundos e o laco inteiro morreu no ciclo 2.
      // So desiste depois de varias quedas SEGUIDAS — ai o problema e real.
      falhasSeguidas++;
      if (falhasSeguidas >= 6) { console.log('6 falhas seguidas de regeracao — desistindo'); break; }
      console.log(`  regeracao falhou (${falhasSeguidas}/6) — nova tentativa em 2 min`);
      dormir(120000);
      continue;
    }
    falhasSeguidas = 0;

    // total === 0 e o UNICO fim legitimo: nao ha mais e-book sem capa viral.
    if (g.total === 0) { console.log('catalogo inteiro com capa viral — encerrando'); break; }

    const r = aplicarLote(lote);
    totalOk += r.ok;
    totalGeradas += g.ok;
    semGanchoAcum += g.semGancho;
    const min = ((Date.now() - t0) / 60000).toFixed(0);
    console.log(`[ciclo ${c}] geradas ${g.ok}/${g.total}` +
      (g.semGancho ? ` (${g.semGancho} sem gancho, voltam)` : '') +
      ` | subidas ${r.ok}/${r.total} | acumulado ${totalGeradas} geradas / ${totalOk} subidas | ${min} min`);

    // Passe inteiro sem gancho = provedor de texto fora. Com o pulo antes da
    // imagem, isso agora aparece como ok=0 — insistir so roda o laco a vazio.
    if (g.ok === 0 && g.total > 0) {
      console.log('  nenhum gancho neste passe — esperando a IA de texto voltar');
      dormir(180000);
    }
  }
  console.log('\nTOTAL GERAL: ' + totalGeradas + ' capas virais geradas, ' + totalOk + ' subidas, ' +
    semGanchoAcum + ' passagens sem gancho, em ' + ((Date.now() - t0) / 60000).toFixed(0) + ' min');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
