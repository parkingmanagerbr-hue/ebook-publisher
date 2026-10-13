'use strict';
/**
 * criarAudiolivros.js — transforma cada MP3 de livro publicado num produto
 * "e-book + audiolivro" a venda.
 *
 * Pedido do dono (13/10/2026): "inclua todos os audiobooks para vender". Os
 * MP3 estavam em /app/data/audiobooks/<id do livro>.mp3, servidos sem
 * assinatura e sem produto nenhum que os vendesse.
 *
 * Mesmo desenho do combo (criarCombos.js): uma linha NOVA em `ebooks`, com
 * `audio_de` apontando para o original, preco proprio e o PDF do livro com a
 * pagina de acesso ao audio depois da folha de rosto. Os publicadores pegam
 * pela fila de sempre. NAO usa `combo_de`: criarCombos trata "existe linha com
 * combo_de = original" como "o combo ja existe", e o livro perderia o combo do
 * plano de acao.
 *
 * Idempotente: livro que ja tem linha audio_de e pulado.
 *
 * Uso (no container): node scripts/criarAudiolivros.js [--limite=20] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { montarPdfDoCombo } = require('../src/ferramentas/combo');
const {
  PRECO_AUDIOLIVRO, motivoParaNaoCriar, tituloDoAudiolivro, descricaoDoAudiolivro, textoDaPaginaDoAudio, minutos,
} = require('../src/ferramentas/audiolivro');

let log;
try { log = require('../src/core/logger').createLogger('audiolivros'); }
catch { log = { info: console.log, warn: console.warn, error: console.error }; }

const DIR_AUDIO = process.env.AUDIOBOOKS_DIR || path.join(__dirname, '..', 'data', 'audiobooks');
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };
const umaLinha = (s, n = 60) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const ID_DO_ARQUIVO = /^([A-Za-z0-9-]{8,64})\.mp3$/;

/** Garante a coluna que liga o audiolivro ao livro original. */
function prepararBanco(db) {
  const cols = db.prepare('PRAGMA table_info(ebooks)').all().map(c => c.name);
  for (const c of ['combo_de', 'audio_de']) {
    if (!cols.includes(c)) db.prepare('ALTER TABLE ebooks ADD COLUMN ' + c + ' TEXT').run();
  }
}

/** Duracao do MP3 em segundos, pelo ffprobe. NaN quando nao da para medir. */
function duracaoDoMp3(arquivo, executar = execFileSync) {
  const saida = executar('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', arquivo],
    { encoding: 'utf8', timeout: 30000 });
  return Number(String(saida).trim());
}

/** Ids dos MP3 de livro (o de dominio publico, gutenberg-*, nao e de livro nosso). */
function idsComAudio(dir, lerDir = fs.readdirSync) {
  return lerDir(dir).map(f => ID_DO_ARQUIVO.exec(f)).filter(Boolean).map(m => m[1])
    .filter(id => !id.startsWith('gutenberg-')).sort();
}

/**
 * Cria o audiolivro de um livro. `deps` injeta disco, medicao e link para o
 * teste nao precisar de ffprobe nem de segredo.
 */
async function criarUm(db, id, deps = {}) {
  const existe = deps.existe || fs.existsSync;
  const medir = deps.medir || duracaoDoMp3;
  const urlAudio = deps.urlAudio || require('../src/core/entrega').urlAudio;
  const ler = deps.ler || fs.readFileSync;
  const dir = deps.dir || DIR_AUDIO;

  const original = db.prepare('SELECT * FROM ebooks WHERE id = ?').get(id);
  const ja = original ? db.prepare('SELECT id FROM ebooks WHERE audio_de = ?').get(id) : null;
  const temPdf = !!(original && original.pdf_path && existe(original.pdf_path));
  // Mede so quem passou nas condicoes baratas: ffprobe por arquivo e o passo caro.
  const previo = motivoParaNaoCriar({ original, duracaoS: Infinity, temPdf, jaExiste: !!ja });
  if (previo) return { estado: previo, id: ja ? ja.id : undefined };
  const duracaoS = medir(path.join(dir, id + '.mp3'));
  const motivo = motivoParaNaoCriar({ original, duracaoS, temPdf, jaExiste: false });
  if (motivo) return { estado: motivo, duracaoS };

  // O link vai para o MP3 do ORIGINAL: o arquivo leva o id dele.
  const url = urlAudio(original.id);
  const texto = textoDaPaginaDoAudio(original.title, url, duracaoS, original.language);
  const bytes = await montarPdfDoCombo(ler(original.pdf_path), { titulo: original.title, url, texto });
  const novo = crypto.randomUUID();
  const destino = path.join(path.dirname(original.pdf_path), 'audiolivro_' + novo.slice(0, 8) + '.pdf');
  if (deps.seco) return { estado: 'seria-criado', duracaoS, titulo: tituloDoAudiolivro(original.title, original.language) };
  const tmp = destino + '.tmp' + process.pid;
  (deps.gravar || fs.writeFileSync)(tmp, bytes);
  (deps.renomear || fs.renameSync)(tmp, destino);   // temporario + rename: falha no meio nao deixa PDF pela metade

  const titulo = tituloDoAudiolivro(original.title, original.language);
  db.prepare(
    'INSERT INTO ebooks (id, topic, title, subtitle, description, cover_path, pdf_path, status, price, ai_provider, language, word_count, audio_de) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 'audiolivro', ?, ?, ?)"
  ).run(novo, original.topic, titulo, original.subtitle, descricaoDoAudiolivro(original.description, duracaoS, original.language),
    original.cover_path, destino, PRECO_AUDIOLIVRO, original.language, original.word_count || 0, original.id);
  return { estado: 'criado', id: novo, titulo, duracaoS, kb: Math.round(bytes.length / 1024) };
}

async function principal({ db, limite, ids, deps = {} } = {}) {
  db = db || require('../src/core/database').getDb();
  prepararBanco(db);
  limite = limite || Number(arg('limite', '20')) || 20;
  const seco = deps.seco != null ? deps.seco : process.argv.includes('--dry-run');
  const lista = ids || idsComAudio(deps.dir || DIR_AUDIO);
  const resumo = { mp3: lista.length, criados: 0, jaExistiam: 0, pulados: 0, falhas: 0, motivos: {} };
  for (const id of lista) {
    if (resumo.criados + resumo.falhas >= limite) break;
    try {
      const r = await criarUm(db, id, { ...deps, seco });
      if (r.estado === 'criado' || r.estado === 'seria-criado') {
        resumo.criados++;
        log.info((seco ? '[dry-run] criaria' : 'audiolivro criado') + ' "' + umaLinha(r.titulo) + '" | ' + minutos(r.duracaoS) + ' min' +
          (r.kb ? ' | PDF ' + r.kb + ' KB | id ' + r.id.slice(0, 8) : '') + ' | livro ' + id.slice(0, 8));
      } else if (r.estado === 'ja-existe') resumo.jaExistiam++;
      else {
        resumo.pulados++;
        resumo.motivos[r.estado] = (resumo.motivos[r.estado] || 0) + 1;
        log.warn('audiolivro pulado (' + r.estado + (r.duracaoS ? ', ' + Math.round(r.duracaoS) + ' s' : '') + ') livro ' + id.slice(0, 8));
      }
    } catch (e) {
      resumo.falhas++;
      log.error('audiolivro falhou livro ' + id.slice(0, 8) + ': ' + umaLinha(e && e.message, 160));
    }
  }
  return resumo;
}

if (require.main === module) {
  principal()
    .then(r => { log.info('resumo: ' + JSON.stringify(r)); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error('ERRO: ' + umaLinha(e && e.message, 200)); process.exit(1); });
}

module.exports = { principal, criarUm, prepararBanco, duracaoDoMp3, idsComAudio };
