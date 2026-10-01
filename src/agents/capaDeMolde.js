'use strict';
/**
 * capaDeMolde.js — capa de livro SEM IA, a partir do titulo.
 *
 * 01/10/2026: 6.149 produtos da Cakto estavam sem imagem (342 deles vendendo).
 * As capas do disco tinham sido apagadas pela retencao antiga, a capa por IA de
 * imagem esta sem cota, e a capa "HTML viral" pede o HTML a IA de texto (~6 mil
 * tokens cada) — inviavel para milhares. Este molde e determinístico: o mesmo
 * titulo da sempre a mesma capa, sem rede e sem cota. Puro.
 */

const LARGURA = 1600;
const ALTURA = 2560;

// Paletas sobrias (fundo escuro em degrade, acento claro). A escolha vem do
// titulo, entao livros vizinhos no catalogo nao saem todos iguais.
const PALETAS = [
  { de: '#0f2027', para: '#2c5364', acento: '#f6c445' },
  { de: '#1a1a2e', para: '#16213e', acento: '#e94560' },
  { de: '#0b3d2e', para: '#145c43', acento: '#f2e8cf' },
  { de: '#2d1b4e', para: '#4a2c7a', acento: '#ffd166' },
  { de: '#3a0f0f', para: '#7a1f1f', acento: '#ffe8d6' },
  { de: '#102a43', para: '#243b53', acento: '#7dd3fc' },
  { de: '#1f2933', para: '#3e4c59', acento: '#f97316' },
  { de: '#06283d', para: '#1363df', acento: '#dff6ff' },
];

const EDITORA = 'Veloxis Editorial';

/** Escapa texto para dentro do HTML. Pura. */
function escapar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Indice estavel a partir do texto (soma de codigos). Pura. */
function indice(texto, tamanho) {
  let h = 0;
  for (const c of String(texto || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % tamanho;
}

/** Tamanho da fonte do titulo: titulo longo encolhe para caber. Pura. */
function fonteDoTitulo(titulo) {
  const n = String(titulo || '').length;
  if (n <= 24) return 150;
  if (n <= 40) return 128;
  if (n <= 60) return 108;
  if (n <= 85) return 92;
  return 78;
}

/**
 * Separa "Titulo: subtitulo" quando o livro so tem o nome composto (caso dos
 * produtos da Cakto sem livro no banco). Pura.
 */
function separarTitulo(nome) {
  const s = String(nome || '').replace(/\s+/g, ' ').trim();
  const i = s.indexOf(': ');
  if (i > 3 && i < s.length - 4) return { titulo: s.slice(0, i), subtitulo: s.slice(i + 2) };
  return { titulo: s, subtitulo: '' };
}

/** HTML completo da capa (1600 x 2560). Pura. */
function htmlDaCapa({ titulo, subtitulo = '', idioma = 'pt-BR' } = {}) {
  const t = String(titulo || '').trim();
  if (!t) throw new Error('capa sem titulo');
  const p = PALETAS[indice(t, PALETAS.length)];
  const lang = escapar(String(idioma || 'pt-BR').slice(0, 10));
  const sub = String(subtitulo || '').trim().slice(0, 180);
  return '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0}' +
    'body{position:relative;overflow:hidden;width:' + LARGURA + 'px;height:' + ALTURA + 'px;' +
    'font-family:"DejaVu Sans","Liberation Sans",Arial,sans-serif;' +
    'background:linear-gradient(160deg,' + p.de + ' 0%,' + p.para + ' 100%);color:#fff;display:flex;flex-direction:column;' +
    'box-sizing:border-box;padding:170px 140px 150px}' +
    // Formas grandes e transparentes: sem elas o terco de baixo ficava vazio.
    '.c1,.c2{position:absolute;border-radius:50%;border:24px solid ' + p.acento + ';opacity:.14}' +
    '.c1{width:1500px;height:1500px;right:-700px;bottom:-500px}' +
    '.c2{width:700px;height:700px;right:-160px;top:-240px;opacity:.10}' +
    '.barra{width:220px;height:16px;background:' + p.acento + ';border-radius:8px;position:relative}' +
    '.meio{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative}' +
    'h1{font-size:' + fonteDoTitulo(t) + 'px;line-height:1.12;margin:0;font-weight:800;letter-spacing:-1px;word-wrap:break-word}' +
    'h2{font-size:62px;line-height:1.3;margin:70px 0 0;font-weight:400;color:' + p.acento + '}' +
    '.rodape{position:relative;font-size:44px;letter-spacing:6px;text-transform:uppercase;opacity:.9;border-top:4px solid ' + p.acento + ';padding-top:50px}' +
    '</style></head><body><div class="c1"></div><div class="c2"></div><div class="barra"></div>' +
    '<div class="meio"><h1>' + escapar(t) + '</h1>' + (sub ? '<h2>' + escapar(sub) + '</h2>' : '') + '</div>' +
    '<div class="rodape">' + escapar(EDITORA) + '</div></body></html>';
}

module.exports = { htmlDaCapa, separarTitulo, fonteDoTitulo, escapar, indice, PALETAS, LARGURA, ALTURA };
