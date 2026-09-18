'use strict';
/**
 * dicaDoDia.js — monta o post de conteudo do dia a partir de um livro nosso.
 *
 * Plano do dono (18/09/2026), item 4: conta de nicho publicando conteudo util
 * todos os dias, em vez de anuncio em conta sem audiencia. A dica sai do texto
 * do proprio livro (conteudo nosso), o card leva a marca e a legenda leva o
 * link da pagina do livro.
 *
 * Saida em /app/data/conteudo_nicho/: <data>.mp4 + <data>.json (titulo,
 * legenda, primeiro comentario). Publicar e outro passo: enquanto a conta de
 * nicho nao existe, a fila fica pronta.
 *
 * Uso (no container): node scripts/dicaDoDia.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { frasesUteis, escolherLivro, montarLegenda, primeiroComentario, linhasDoCard } = require('../src/agents/dicaNicho');

const SAIDA = process.env.DICA_DIR || '/app/data/conteudo_nicho';
const FONTE = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';
const BASE = 'https://veloxisit.com.br/livros/';

function slugDoTitulo(titulo, pid) {
  const b = String(titulo || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
  return (b || 'livro') + '-' + pid;
}

async function textoDoPdf(caminho) {
  delete require.cache[require.resolve('pdf-parse')];
  const pdf = require('pdf-parse');
  const { text } = await pdf(fs.readFileSync(caminho));
  return text;
}

/** Card vertical 1080x1920 com a dica. Texto em cima, marca embaixo. */
function gerarVideo(dica, livro, destino) {
  const linhas = linhasDoCard(dica, 24);
  const topo = Math.max(320, 760 - linhas.length * 45);   // bloco centralizado no terco de cima
  // Texto por ARQUIVO: dois-pontos e aspas no texto quebravam os argumentos do
  // drawtext ("Both text and text file provided", 18/09/2026).
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dica-'));
  const arquivo = (nome, conteudo) => {
    const c = path.join(tmp, nome + '.txt');
    fs.writeFileSync(c, conteudo);
    return c;
  };
  const filtros = linhas.map((l, i) =>
    `drawtext=fontfile=${FONTE}:textfile=${arquivo('l' + i, l)}:fontsize=64:fontcolor=white:x=(w-tw)/2:y=${topo + i * 90}`);
  const fimDica = topo + linhas.length * 90;
  // Titulo cortado em palavra inteira: "para Freelance" ficava pela metade.
  const titulo = linhasDoCard(String(livro.title), 34)[0] + (String(livro.title).length > 34 ? '…' : '');
  filtros.push(`drawtext=fontfile=${FONTE}:textfile=${arquivo('t', titulo)}:fontsize=40:fontcolor=0xffcf5a:x=(w-tw)/2:y=${fimDica + 120}`);
  filtros.push(`drawtext=fontfile=${FONTE}:textfile=${arquivo('u', 'veloxisit.com.br/livros')}:fontsize=44:fontcolor=0xff6a3d:x=(w-tw)/2:y=${fimDica + 210}`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x0e0e1a:s=1080x1920:d=8',
    '-vf', filtros.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', destino]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  const seco = process.argv.includes('--dry-run');
  const db = require('../src/core/database').getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS dica_nicho (ebook_id TEXT, quando INTEGER, dica TEXT)').run();
  const usados = new Map(db.prepare('SELECT ebook_id, MAX(quando) q FROM dica_nicho GROUP BY ebook_id').all()
    .map(r => [String(r.ebook_id), r.q]));
  const jaDitas = new Set(db.prepare('SELECT dica FROM dica_nicho').all().map(r => r.dica));

  const linhas = db.prepare(
    "SELECT e.id, e.title, e.topic, e.language, e.pdf_path AS pdf, CAST(e.hotmart_product_id AS TEXT) pid " +
    "FROM ebooks e WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' AND e.pdf_path IS NOT NULL"
  ).all().filter(l => fs.existsSync(l.pdf)).map(l => ({ ...l, slug: slugDoTitulo(l.title, l.pid) }));

  const livro = escolherLivro(linhas, usados);
  if (!livro) { console.log(JSON.stringify({ erro: 'nenhum livro elegivel' })); return; }

  const texto = await textoDoPdf(livro.pdf);
  const dica = frasesUteis(texto).find(f => !jaDitas.has(f));
  if (!dica) { console.log(JSON.stringify({ livro: livro.id, erro: 'sem frase nova' })); return; }

  const legenda = montarLegenda(livro, dica, BASE);
  const comentario = primeiroComentario(livro, BASE);
  if (seco) { console.log(JSON.stringify({ livro: livro.title, dica, legenda }, null, 1)); return; }

  fs.mkdirSync(SAIDA, { recursive: true });
  // Varias no mesmo dia formam fila (util enquanto a conta de nicho nao existe):
  // 2026-09-18.mp4, 2026-09-18-2.mp4, ...
  const hoje = new Date().toISOString().slice(0, 10);
  let nome = hoje;
  for (let i = 2; fs.existsSync(path.join(SAIDA, nome + '.mp4')); i++) nome = hoje + '-' + i;
  const video = path.join(SAIDA, nome + '.mp4');
  gerarVideo(dica, livro, video);
  const meta = { data: nome, livro: livro.title, slug: livro.slug, dica, legenda, first_comment: comentario, video };
  fs.writeFileSync(path.join(SAIDA, nome + '.json'), JSON.stringify(meta, null, 2));
  db.prepare('INSERT INTO dica_nicho VALUES (?,?,?)').run(livro.id, Date.now(), dica);
  console.log(JSON.stringify({ video, livro: livro.title, dica: dica.slice(0, 60) }));
}

module.exports = { slugDoTitulo };

if (require.main === module) main().catch(e => { console.error('ERRO ' + e.message); process.exit(1); });
