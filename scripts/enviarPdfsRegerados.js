'use strict';
/**
 * enviarPdfsRegerados.js — segunda metade do conserto dos produtos sem arquivo.
 *
 * O container reergue o PDF (scripts/regerarPdfFaltante.js, cron de 2 em 2 h),
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

function prontos(limite) {
  const consulta = 'const fs=require("fs");const d=require("/app/src/core/database").getDb();' +
    'const r=d.prepare("SELECT s.produto, e.pdf_path FROM hotmart_sem_arquivo s JOIN ebooks e ON e.id=s.ebook_id").all()' +
    '.filter(x=>x.pdf_path&&fs.existsSync(x.pdf_path)).slice(0,' + limite + ');console.log(JSON.stringify(r));';
  fs.writeFileSync(path.join(os.tmpdir(), 'consulta_prontos.js'), consulta);
  execFileSync('scp', ['-q', path.join(os.tmpdir(), 'consulta_prontos.js'), 'vps:/tmp/consulta_prontos.js']);
  ssh('docker cp /tmp/consulta_prontos.js ' + CONTAINER + ':/tmp/consulta_prontos.js');
  return extrairJson(ssh('docker exec ' + CONTAINER + ' node /tmp/consulta_prontos.js'));
}

async function main() {
  const limite = parseInt(arg('limite', '5'), 10);
  const lista = prontos(limite);
  if (!lista.length) { console.log('nenhum PDF regerado esperando envio'); return; }
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfs-hm-'));
  const pares = [];
  for (const item of lista) {
    const local = path.join(destino, 'pdf_' + item.produto + '.pdf');
    ssh('docker cp ' + CONTAINER + ':' + item.pdf_path + ' /tmp/envio_' + item.produto + '.pdf');
    execFileSync('scp', ['-q', 'vps:/tmp/envio_' + item.produto + '.pdf', local]);
    pares.push(item.produto + '=' + local);
  }
  const token = ssh('docker exec ' + CONTAINER + ' cat /app/data/hotmart_access_token.txt').trim();
  console.log('enviando ' + pares.length + ' PDF(s)...');
  const saida = execFileSync(process.execPath, [path.join(__dirname, 'reanexarPdfHotmart.js'), '--token=' + token, ...pares], { encoding: 'utf8' });
  console.log(saida.trim());
  // Sai da fila so quem a API confirmou.
  const confirmados = [...saida.matchAll(/^(\d+) uploadPDF=\w+ API confirma arquivo=true$/gm)].map(m => m[1]);
  if (confirmados.length) {
    const limpa = 'const d=require("/app/src/core/database").getDb();' +
      'const n=d.prepare("DELETE FROM hotmart_sem_arquivo WHERE produto IN (' + confirmados.map(c => "'" + c + "'").join(',') + ')").run().changes;' +
      'console.log(JSON.stringify({removidos:n}));';
    fs.writeFileSync(path.join(os.tmpdir(), 'limpa_fila.js'), limpa);
    execFileSync('scp', ['-q', path.join(os.tmpdir(), 'limpa_fila.js'), 'vps:/tmp/limpa_fila.js']);
    ssh('docker cp /tmp/limpa_fila.js ' + CONTAINER + ':/tmp/limpa_fila.js');
    console.log(ssh('docker exec ' + CONTAINER + ' node /tmp/limpa_fila.js').trim().split('\n').pop());
  }
  fs.rmSync(destino, { recursive: true, force: true });
}

module.exports = { extrairJson };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
