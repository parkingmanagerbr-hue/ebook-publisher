'use strict';
/**
 * capaJpeg.js — a capa dentro do PDF vai em JPEG, nunca em PNG sem perda.
 *
 * Medido em 14/10/2026 com o disco da VPS em 91%: o PDFKit embute a capa PNG
 * sem perda (FlateDecode), ~3,3 MB por livro — 27 de 40 PDFs da amostra, e a
 * capa era a UNICA imagem do arquivo (o mesmo PDF sem a pagina 1 tem 0,1 MB).
 * Com 14.650 PDFs, a pasta tinha 32 GB e crescia 2–4 GB por dia. Em JPEG
 * qualidade 85 a mesma capa 1600x2560 fica em algumas centenas de KB.
 *
 * O JPEG sai pelo @napi-rs/canvas (ja dependencia do controle de qualidade):
 * sem processo externo, e com fundo branco por baixo — o JPEG nao tem alfa, e
 * a pagina do PDF, onde a capa cobre a folha inteira, e branca.
 */

const QUALIDADE = 85;
const LARGURA_MAX = 1600;

/** Bytes de imagem (PNG/JPEG/...) -> JPEG, no maximo `larguraMax` de largura. */
async function paraJpeg(bytes, { larguraMax = LARGURA_MAX, qualidade = QUALIDADE } = {}) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(Buffer.from(bytes));
  const escala = img.width > larguraMax ? larguraMax / img.width : 1;
  const w = Math.max(1, Math.round(img.width * escala));
  const h = Math.max(1, Math.round(img.height * escala));
  const tela = createCanvas(w, h);
  const ctx = tela.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { bytes: await tela.encode('jpeg', qualidade), largura: w, altura: h };
}

/**
 * A capa a usar no gerador: um JPEG TEMPORARIO (quem chama apaga depois do
 * doc.image, que le o arquivo na hora), ou a propria capa quando ela ja e JPEG
 * ou quando a conversao falha — capa pesada e melhor que livro sem capa.
 * `avisar(motivo)` registra a falha.
 */
async function capaParaPdf(caminho, { ler = require('fs').readFileSync, destino, avisar = () => {} } = {}) {
  const fs = require('fs');
  const bytes = ler(caminho);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { caminho, temporario: false };
  try {
    const j = await paraJpeg(bytes);
    const alvo = destino || require('path').join(require('os').tmpdir(), 'capa_' + process.pid + '_' + Date.now() + '.jpg');
    fs.writeFileSync(alvo, j.bytes);
    return { caminho: alvo, temporario: true, kbAntes: Math.round(bytes.length / 1024), kbDepois: Math.round(j.bytes.length / 1024) };
  } catch (e) {
    avisar('capa nao convertida para JPEG (' + String(e && e.message).slice(0, 120) + ') — vai a original');
    return { caminho, temporario: false };
  }
}

/**
 * Remonta um PNG a partir da imagem FlateDecode que o PDFKit gravou: com
 * Predictor 15 o stream E o IDAT do PNG original (filtro por linha dentro), so
 * falta o envelope. Assim a imagem e decodificada por quem sabe ler PNG, sem
 * reimplementar os filtros. Pura.
 */
function pngDoFlate({ dados, largura, altura, cores = 3, bits = 8 }) {
  const zlib = require('zlib');
  const tipo = cores === 1 ? 0 : cores === 3 ? 2 : null;
  if (tipo == null) throw new Error('cores nao suportadas: ' + cores);
  const pedaco = (nome, corpo) => {
    const tam = Buffer.alloc(4); tam.writeUInt32BE(corpo.length);
    const tipoEcorpo = Buffer.concat([Buffer.from(nome, 'latin1'), corpo]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tipoEcorpo) >>> 0);
    return Buffer.concat([tam, tipoEcorpo, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = bits; ihdr[9] = tipo; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pedaco('IHDR', ihdr), pedaco('IDAT', Buffer.from(dados)), pedaco('IEND', Buffer.alloc(0))]);
}

/**
 * A imagem da pagina 1 pode ser trocada por JPEG? Devolve null quando pode, ou
 * o motivo de nao poder. `img` = { filtro, preditor, cores, bits, temAlfa, bytes }.
 * Alfa fica de fora de proposito: tirar a mascara muda o que aparece onde ela
 * era transparente, e a regra e "capa igual". Pura.
 */
function motivoParaNaoTrocar(img) {
  if (!img) return 'sem-imagem-na-pagina-1';
  if (img.filtro === '/DCTDecode') return 'ja-jpeg';
  if (img.filtro !== '/FlateDecode') return 'filtro-' + String(img.filtro).replace(/^\//, '');
  // Alfa antes do preditor: o PDFKit separa a mascara e grava a parte colorida
  // sem preditor, e o motivo certo no diario e o alfa.
  if (img.temAlfa) return 'com-alfa';
  if (!(Number(img.preditor) >= 10)) return 'sem-preditor-png';
  if (Number(img.bits) !== 8 || ![1, 3].includes(Number(img.cores))) return 'formato-nao-suportado';
  if (Number(img.bytes) < 300 * 1024) return 'pequena';
  return null;
}

/**
 * O arquivo novo pode tomar o lugar do original? null quando pode. Toda
 * condicao que falha MANTEM o original: o PDF ja foi vendido e e entregue pelo
 * nosso servidor. Pura.
 */
function motivoParaRecusar({ antes, depois, paginasAntes, paginasDepois, textoAntes, textoDepois }) {
  if (paginasDepois !== paginasAntes) return 'paginas-diferentes';
  if (textoDepois !== textoAntes) return 'texto-diferente';
  if (!(Number(depois) > 0)) return 'arquivo-vazio';
  if (Number(depois) > Number(antes) * 0.7) return 'ganho-pequeno';
  return null;
}

module.exports = { QUALIDADE, LARGURA_MAX, paraJpeg, capaParaPdf, pngDoFlate, motivoParaNaoTrocar, motivoParaRecusar };
