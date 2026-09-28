'use strict';
/**
 * diarioDeTestes.js — roda a suite e registra o resultado no diario.
 *
 * Existe para responder, a qualquer momento, sem abrir o CI: a suite esta
 * verde? desde quando esta vermelha? o que exatamente esta falhando? ha quanto
 * tempo ela nao roda? A cobertura esta caindo?
 *
 * Em 27/09/2026 a suite morreu por DISCO CHEIO e o portao so disse
 * "test failed" — sem historico, nao havia como notar que o problema era o
 * ambiente, nem ha quanto tempo durava.
 *
 * Uso:
 *   node scripts/diarioDeTestes.js            # roda a suite e grava a linha
 *   node scripts/diarioDeTestes.js --ver      # so mostra o historico
 *   node scripts/diarioDeTestes.js --ver=20   # ultimas 20 rodadas
 *
 * Sai com codigo 1 quando a rodada nao ficou verde — serve de alarme no cron.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { linhaDoDiario, resumoDoDiario } = require('../src/core/diarioDeTestes');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = process.env.DIARIO_TESTES || path.join(RAIZ, 'logs', 'diario_de_testes.jsonl');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n)); return a ? (a.split('=')[1] || true) : p; };

/** Le as ultimas N linhas do diario, a mais nova primeiro. */
function ler(quantas = 10) {
  let bruto = '';
  try { bruto = fs.readFileSync(ARQUIVO, 'utf8'); } catch (_) { return []; }
  return bruto.split(/\r?\n/).filter(Boolean).slice(-quantas).reverse()
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

/** Acrescenta a linha (JSON Lines: nunca reescreve o que ja esta gravado). */
function gravar(linha) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.appendFileSync(ARQUIVO, JSON.stringify(linha) + os.EOL, 'utf8');
}

function principal() {
  const ver = arg('ver', null);
  if (ver) {
    const quantas = Number(ver) > 0 ? Number(ver) : 10;
    const linhas = ler(quantas);
    console.log(resumoDoDiario(linhas));
    for (const l of linhas) {
      console.log('  ' + l.quando + '  ' + (l.ok ? 'ok    ' : 'FALHOU') +
        '  ' + String(l.passou).padStart(4) + ' passaram, ' + l.falhou + ' falharam' +
        (l.cobertura == null ? '' : ', cobertura ' + l.cobertura + '%') +
        (l.completou ? '' : '  [suite nao terminou]') +
        (l.falharam && l.falharam.length ? '  <- ' + l.falharam.slice(0, 2).join(' | ') : ''));
    }
    return linhas.length && !linhas[0].ok ? 1 : 0;
  }

  const t0 = Date.now();
  let saida = '';
  let coberturaOk = true;
  try {
    saida = execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'gateCobertura.js')],
      { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  } catch (e) {
    // O portao sai com codigo != 0 quando testa falha OU cobertura nao bate;
    // a saida continua valendo e e dela que sai o placar.
    saida = String((e && (e.stdout || '')) + (e && e.stderr ? '\n' + e.stderr : ''));
    coberturaOk = false;
  }
  if (/\[gate\] ok:/.test(saida)) coberturaOk = true;

  const linha = linhaDoDiario({ saida, coberturaOk, segundos: (Date.now() - t0) / 1000, rotulo: String(arg('rotulo', 'suite')) });
  gravar(linha);
  console.log(resumoDoDiario([linha, ...ler(20).slice(1)]));
  return linha.ok ? 0 : 1;
}

if (require.main === module) process.exit(principal());

module.exports = { ler, gravar, ARQUIVO };
