'use strict';
/**
 * enviarPdfsRegerados.js — segunda metade do conserto dos produtos sem arquivo.
 *
 * O container reergue o PDF (scripts/regerarPdfFaltante.js, cron de hora em hora),
 * mas o envio para a Hotmart so funciona na maquina que fez o login: a sessao
 * esta presa a origem. Este script roda LOCAL, pergunta ao VPS quem ja tem PDF,
 * baixa os arquivos e reenvia pelo Chrome de automacao (porta 9223), conferindo
 * na API de conteudo.
 *
 * Uso: node scripts/enviarPdfsRegerados.js [--limite=5]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const { noServidor, rodarAqui, pastaTemporaria } = require('../src/core/modoServidor');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

const ssh = cmd => execFileSync('ssh', ['-o', 'ConnectTimeout=30', 'vps', cmd], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

/** Le a saida do VPS ignorando o ruido de log antes do JSON. Pura. */
function extrairJson(saida) {
  // Linha a linha, de tras para frente: o log do container comeca com
  // "[2026-09-15 ...]" e um regex guloso pegava esse colchete como o JSON.
  const texto = String(saida);
  for (const linha of texto.split(/\r?\n/).reverse()) {
    const l = linha.trim();
    if (!/^[[{]/.test(l)) continue;
    try { return JSON.parse(l); } catch { /* linha de log com colchete */ }
  }
  // JSON no meio de uma linha de texto ("ruido {...} fim")
  const m = texto.match(/\{[^{}]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* segue */ } }
  throw new Error('VPS nao devolveu JSON: ' + texto.slice(-200));
}

/**
 * Produtos que a API confirmou com arquivo. "ja tem arquivo" tambem conta:
 * sem isso o 8534887 ficou na fila repetindo a cada rodada (16-17/09/2026).
 * Pura.
 */
function produtosConfirmados(saida) {
  const s = String(saida || '');
  return [
    ...[...s.matchAll(/^(\d+) uploadPDF=\w+ API confirma arquivo=true$/gm)].map(m => m[1]),
    ...[...s.matchAll(/^(\d+) ja tem arquivo\b/gm)].map(m => m[1]),
  ];
}

/**
 * Envios sem confirmacao da API antes de desistir do produto. Medido em
 * 06–09/10/2026: o produto 8672444 foi reenviado 135 vezes (a cada volta de
 * 10 min), sempre "uploadPDF=true API confirma arquivo=false" — falha que nao
 * marca nada e repeticao eterna.
 */
const MAX_ENVIOS = 5;

/**
 * O que fazer depois de uma rodada. `tentativas`: {produto: envios ja feitos}.
 * Confirmado sai da fila e zera; nao confirmado conta mais um; quem chega ao
 * teto DESISTE (sai da fila, fica registrado para conferir no painel). Pura.
 */
function planoDeTentativas({ enviados = [], confirmados = [], tentativas = {}, max = MAX_ENVIOS } = {}) {
  const ok = new Set(confirmados.map(String));
  const limpar = [], incrementar = [], desistir = [];
  for (const p of enviados.map(String)) {
    if (ok.has(p)) { limpar.push(p); continue; }
    const n = (Number(tentativas[p]) || 0) + 1;
    incrementar.push({ produto: p, tentativas: n });
    if (n >= max) desistir.push(p);
  }
  return { limpar, incrementar, desistir };
}

function prontos(limite) {
  const consulta = 'const fs=require("fs");const d=require("/app/src/core/database").getDb();' +
    'd.prepare("CREATE TABLE IF NOT EXISTS hotmart_pdf_envio (produto TEXT PRIMARY KEY, tentativas INTEGER, quando INTEGER, desistiu INTEGER DEFAULT 0)").run();' +
    'const r=d.prepare("SELECT s.produto, e.pdf_path, COALESCE(t.tentativas, 0) tentativas FROM hotmart_sem_arquivo s JOIN ebooks e ON e.id=s.ebook_id ' +
    'LEFT JOIN hotmart_pdf_envio t ON t.produto = s.produto WHERE COALESCE(t.desistiu, 0) = 0").all()' +
    '.filter(x=>x.pdf_path&&fs.existsSync(x.pdf_path)).slice(0,' + limite + ');console.log(JSON.stringify(r));';
  if (noServidor()) return extrairJson(rodarAqui(consulta)); // na VPS: sem ssh
  fs.writeFileSync(path.join(os.tmpdir(), 'consulta_prontos.js'), consulta);
  execFileSync('scp', ['-q', path.join(os.tmpdir(), 'consulta_prontos.js'), 'vps:/tmp/consulta_prontos.js']);
  ssh('docker cp /tmp/consulta_prontos.js ' + CONTAINER + ':/tmp/consulta_prontos.js');
  return extrairJson(ssh('docker exec ' + CONTAINER + ' node /tmp/consulta_prontos.js'));
}

async function main() {
  const limite = parseInt(arg('limite', '5'), 10);
  const lista = prontos(limite);
  if (!lista.length) { console.log('nenhum PDF regerado esperando envio'); return; }
  // Na VPS a pasta e a compartilhada com o Chrome (o upload passa o caminho).
  // pastaTemporaria: modo 755, senao o Chrome (outro usuario) le zero bytes.
  const destino = pastaTemporaria('pdfs-hm');
  try { await enviar(lista, destino); } finally { fs.rmSync(destino, { recursive: true, force: true }); }
}

async function enviar(lista, destino) {
  const pares = [];
  for (const item of lista) {
    const local = path.join(destino, 'pdf_' + item.produto + '.pdf');
    if (noServidor()) { fs.copyFileSync(item.pdf_path, local); fs.chmodSync(local, 0o644); }
    else {
      ssh('docker cp ' + CONTAINER + ':' + item.pdf_path + ' /tmp/envio_' + item.produto + '.pdf');
      execFileSync('scp', ['-q', 'vps:/tmp/envio_' + item.produto + '.pdf', local]);
    }
    pares.push(item.produto + '=' + local);
  }
  const token = noServidor()
    ? fs.readFileSync('/app/data/hotmart_access_token.txt', 'utf8').trim()
    : ssh('docker exec ' + CONTAINER + ' cat /app/data/hotmart_access_token.txt').trim();
  console.log('enviando ' + pares.length + ' PDF(s)...');
  const saida = execFileSync(process.execPath, [path.join(__dirname, 'reanexarPdfHotmart.js'), '--token=' + token, ...pares], { encoding: 'utf8' });
  console.log(saida.trim());
  // Sai da fila so quem a API confirmou; os outros contam uma tentativa.
  const confirmados = produtosConfirmados(saida);
  const plano = planoDeTentativas({ enviados: lista.map(i => i.produto), confirmados, tentativas: Object.fromEntries(lista.map(i => [String(i.produto), i.tentativas])) });
  if (plano.incrementar.length || plano.limpar.length) {
    const grava = 'const d=require("/app/src/core/database").getDb();' +
      'd.prepare("CREATE TABLE IF NOT EXISTS hotmart_pdf_envio (produto TEXT PRIMARY KEY, tentativas INTEGER, quando INTEGER, desistiu INTEGER DEFAULT 0)").run();' +
      'const up=d.prepare("INSERT INTO hotmart_pdf_envio (produto, tentativas, quando, desistiu) VALUES (?,?,?,?) ON CONFLICT(produto) DO UPDATE SET tentativas=excluded.tentativas, quando=excluded.quando, desistiu=excluded.desistiu");' +
      'const del=d.prepare("DELETE FROM hotmart_pdf_envio WHERE produto=?");' +
      JSON.stringify(plano.incrementar) + '.forEach(x=>up.run(x.produto,x.tentativas,Date.now(),' + JSON.stringify(plano.desistir) + '.includes(x.produto)?1:0));' +
      JSON.stringify(plano.limpar) + '.forEach(p=>del.run(p));console.log("ok");';
    rodarNoBanco(grava);
  }
  for (const p of plano.desistir) {
    console.log('desistiu: ' + p + ' apos ' + MAX_ENVIOS + ' envios sem a API confirmar o arquivo — conferir o produto no painel da Hotmart');
  }
  if (confirmados.length) {
    // Produto pausado so por esperar o PDF (16/09/2026) volta a vender aqui.
    const lista = confirmados.map(c => "'" + c + "'").join(',');
    const limpa = 'const d=require("/app/src/core/database").getDb();const fs=require("fs");' +
      'const n=d.prepare("DELETE FROM hotmart_sem_arquivo WHERE produto IN (' + lista + ')").run().changes;' +
      'let p=[];try{p=d.prepare("SELECT produto FROM hotmart_pausados WHERE motivo LIKE \'aguardando pdf%\' AND produto IN (' + lista + ')").all().map(r=>r.produto)}catch(e){}' +
      'const tok=fs.readFileSync("/app/data/hotmart_access_token.txt","utf8").trim();' +
      '(async()=>{let reativados=0;for(const id of p){const r=await fetch("https://api-product.vulcano.hotmart.com/product/v1/product/"+id+"/sales?salesEnable=true&notifyAffiliateSalesStatus=false",' +
      '{method:"PUT",headers:{authorization:"Bearer "+tok,"x-app-name":"app-product"}});' +
      'if(r.ok){d.prepare("DELETE FROM hotmart_pausados WHERE produto=?").run(id);reativados++}}' +
      'console.log(JSON.stringify({removidos:n,reativados}))})();';
    console.log(rodarNoBanco(limpa).trim().split('\n').pop());
  }
}

/** Roda um trecho no container (direto na VPS; por ssh na maquina do dono). */
function rodarNoBanco(js) {
  if (noServidor()) return rodarAqui(js);
  fs.writeFileSync(path.join(os.tmpdir(), 'limpa_fila.js'), js);
  execFileSync('scp', ['-q', path.join(os.tmpdir(), 'limpa_fila.js'), 'vps:/tmp/limpa_fila.js']);
  ssh('docker cp /tmp/limpa_fila.js ' + CONTAINER + ':/tmp/limpa_fila.js');
  return ssh('docker exec ' + CONTAINER + ' node /tmp/limpa_fila.js');
}

module.exports = { extrairJson, produtosConfirmados, planoDeTentativas, MAX_ENVIOS };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
