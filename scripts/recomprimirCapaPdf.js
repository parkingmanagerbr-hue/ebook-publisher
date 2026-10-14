'use strict';
/**
 * recomprimirCapaPdf.js — troca a capa sem perda (PNG/Flate) da pagina 1 dos
 * PDFs JA PUBLICADOS por JPEG de mesmas dimensoes. Disco da VPS em 91% em
 * 14/10/2026: ~3,3 MB de capa por livro, 8.504 PDFs de 3 a 5 MB.
 *
 * Esses arquivos ja foram vendidos e sao entregues pelo nosso servidor
 * (/entrega), entao o original so e substituido (rename) quando o novo:
 * abre de novo com pdf-lib E com pdf-parse (o leitor do controle de
 * qualidade), tem o mesmo numero de paginas, o MESMO texto extraido, e ficou
 * mais de 30% menor. Qualquer falha mantem o original e fica no diario.
 * Decisoes puras em src/agents/capaJpeg.js.
 *
 * Diario: data/recompressao_pdf.jsonl, uma linha por arquivo; o que ja tem
 * linha e pulado (retomavel — deploy recria o container no meio do lote).
 *
 * Uso: node scripts/recomprimirCapaPdf.js [--limite=N] [--seco] [--arquivos=a.pdf,b.pdf]
 */
const fs = require('fs');
const path = require('path');
const { pngDoFlate, paraJpeg, motivoParaNaoTrocar, motivoParaRecusar } = require('../src/agents/capaJpeg');

let log;
try { log = require('../src/core/logger').createLogger('recompressao'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const DIR = process.env.PDFS_DIR || path.join(__dirname, '..', 'data', 'pdfs');
const DIARIO = process.env.DIARIO_RECOMPRESSAO || path.join(__dirname, '..', 'data', 'recompressao_pdf.jsonl');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : p; };

/** Imagem da pagina 1 com o que a decisao precisa. */
function imagemDaPagina1(doc) {
  const { PDFName, PDFRawStream } = require('pdf-lib');
  const res = doc.getPage(0).node.Resources();
  const xo = res && res.lookup(PDFName.of('XObject'));
  if (!xo) return null;
  for (const chave of xo.keys()) {
    const ref = xo.get(chave);
    const s = doc.context.lookup(ref);
    if (!(s instanceof PDFRawStream)) continue;
    const sub = s.dict.get(PDFName.of('Subtype'));
    if (!sub || sub.toString() !== '/Image') continue;
    const parm = s.dict.lookup(PDFName.of('DecodeParms'));
    const num = (d, n) => { const v = d && d.lookup && d.lookup(PDFName.of(n)); return v && v.asNumber ? v.asNumber() : null; };
    return {
      xo, chave, ref, stream: s,
      filtro: String(s.dict.get(PDFName.of('Filter'))),
      preditor: num(parm, 'Predictor'), cores: num(parm, 'Colors'), bits: num(s.dict, 'BitsPerComponent'),
      largura: num(s.dict, 'Width'), altura: num(s.dict, 'Height'),
      temAlfa: !!s.dict.get(PDFName.of('SMask')), bytes: s.contents.length,
    };
  }
  return null;
}

async function texto(bytes) {
  const r = await require('../src/agents/qualityAgent').lerPdf(Buffer.from(bytes));
  return { texto: String(r.text || ''), paginas: r.numpages };
}

/** Processa UM arquivo. Devolve a linha do diario. Nunca toca no original sem passar em tudo. */
async function recomprimir(arquivo, { seco = false, decidir = motivoParaRecusar } = {}) {
  const { PDFDocument } = require('pdf-lib');
  const antesBytes = fs.readFileSync(arquivo);
  const linha = { arquivo: path.basename(arquivo), antes: antesBytes.length };
  const doc = await PDFDocument.load(antesBytes);
  const img = imagemDaPagina1(doc);
  const nao = motivoParaNaoTrocar(img);
  if (nao) return { ...linha, resultado: 'mantido', motivo: nao };
  const png = pngDoFlate({ dados: img.stream.contents, largura: img.largura, altura: img.altura, cores: img.cores, bits: img.bits });
  const jpg = await paraJpeg(png, { larguraMax: img.largura });
  if (jpg.largura !== img.largura || jpg.altura !== img.altura) return { ...linha, resultado: 'mantido', motivo: 'dimensao-mudou' };
  const nova = await doc.embedJpg(jpg.bytes);
  img.xo.set(img.chave, nova.ref);
  doc.context.delete(img.ref);
  // Formato classico: o pdf-parse do controle de qualidade nao abre object streams.
  const depoisBytes = await doc.save({ useObjectStreams: false });

  // Conferencias — o arquivo e de quem ja comprou.
  await PDFDocument.load(depoisBytes);
  const a = await texto(antesBytes);
  const d = await texto(depoisBytes);
  const recusa = decidir({ antes: antesBytes.length, depois: depoisBytes.length, paginasAntes: a.paginas, paginasDepois: d.paginas, textoAntes: a.texto, textoDepois: d.texto });
  if (recusa) return { ...linha, depois: depoisBytes.length, resultado: 'mantido', motivo: recusa };
  if (seco) return { ...linha, depois: depoisBytes.length, resultado: 'seria-substituido' };
  const tmp = arquivo + '.recomp.tmp';
  fs.writeFileSync(tmp, depoisBytes);
  fs.chmodSync(tmp, fs.statSync(arquivo).mode & 0o777);
  fs.renameSync(tmp, arquivo);
  return { ...linha, depois: depoisBytes.length, resultado: 'substituido' };
}

function jaFeitos(diario = DIARIO) {
  const feitos = new Set();
  if (!fs.existsSync(diario)) return feitos;
  for (const l of fs.readFileSync(diario, 'utf8').split('\n')) {
    try { const j = JSON.parse(l); if (j.resultado !== 'seria-substituido') feitos.add(j.arquivo); } catch (_) { /* protocolo: linha vazia ou cortada */ }
  }
  return feitos;
}

async function principal() {
  const seco = process.argv.includes('--seco');
  const limite = Number(arg('limite', '0')) || Infinity;
  const so = arg('arquivos', '');
  const feitos = jaFeitos();
  const lista = (so ? so.split(',') : fs.readdirSync(DIR).filter(f => f.endsWith('.pdf')))
    .filter(f => !feitos.has(f))
    .map(f => ({ f, b: fs.statSync(path.join(DIR, f)).size }))
    .sort((x, y) => y.b - x.b);   // maiores primeiro: o ganho chega antes
  const resumo = { fila: lista.length, jaFeitos: feitos.size, substituidos: 0, mantidos: 0, erros: 0, bytesAntes: 0, bytesDepois: 0, motivos: {} };
  log.info('recompressao: ' + lista.length + ' na fila, ' + feitos.size + ' ja no diario' + (seco ? ' (seco)' : ''));
  let n = 0;
  for (const { f } of lista) {
    if (n++ >= limite) break;
    let linha;
    try { linha = await recomprimir(path.join(DIR, f), { seco }); }
    catch (e) { linha = { arquivo: f, resultado: 'erro', motivo: String(e && e.message).replace(/[\r\n]+/g, ' ').slice(0, 160) }; }
    linha.quando = new Date().toISOString();
    if (!seco) fs.appendFileSync(DIARIO, JSON.stringify(linha) + '\n');
    if (linha.resultado === 'substituido' || linha.resultado === 'seria-substituido') { resumo.substituidos++; resumo.bytesAntes += linha.antes; resumo.bytesDepois += linha.depois; }
    else if (linha.resultado === 'erro') { resumo.erros++; log.warn('erro em ' + f.slice(0, 40) + ': ' + linha.motivo); }
    else resumo.mantidos++;
    if (linha.motivo) resumo.motivos[linha.motivo.split(':')[0].slice(0, 40)] = (resumo.motivos[linha.motivo.split(':')[0].slice(0, 40)] || 0) + 1;
    if (n % 100 === 0) log.info('progresso ' + n + ': ' + JSON.stringify({ ...resumo, motivos: undefined, gbLiberados: ((resumo.bytesAntes - resumo.bytesDepois) / 1e9).toFixed(2) }));
  }
  resumo.gbLiberados = Number(((resumo.bytesAntes - resumo.bytesDepois) / 1e9).toFixed(2));
  log.info('recompressao' + (seco ? ' (seco)' : '') + ': ' + JSON.stringify(resumo));
  return resumo;
}

if (require.main === module) {
  principal()
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + String(e && e.message).replace(/[\r\n]+/g, ' ').slice(0, 200)); console.error('ERRO: ' + String(e && e.message).slice(0, 200)); process.exit(1); });
}

module.exports = { recomprimir, imagemDaPagina1, jaFeitos, principal };
