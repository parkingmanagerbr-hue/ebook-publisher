'use strict';
/**
 * publicar_local.js — publica no Hotmart a partir da MAQUINA DO LOGIN.
 *
 * Mesma razao do backfill de capas: a Hotmart amarra a sessao a origem. Provado
 * em 01/09/2026 com os MESMOS cookies no MESMO instante — a maquina do usuario
 * abria o painel enquanto o VPS caia em sso.hotmart.com/login. A publicacao pelo
 * VPS vinha rendendo 0/4 por lote; daqui a sessao e nativa.
 *
 * O e-book (PDF e capa) mora no VPS e vem por copia sob demanda; o resultado
 * (url e id do produto) volta para o banco de la. A maquina local e so o braco.
 *
 * Uso:
 *   node scripts/publicar_local.js --limite=5
 *   node scripts/publicar_local.js --limite=5 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const TMP = path.join(os.tmpdir(), 'publicar-hotmart');
const MAX_TENTATIVAS = 3;

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}

function ssh(cmd, timeout) {
  return execFileSync('ssh', [VPS, cmd], { encoding: 'utf8', timeout: timeout || 180000, maxBuffer: 8 * 1024 * 1024 });
}

function rodarNoContainer(js, timeout) {
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'cmd.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, `${VPS}:/tmp/cmd.js`], { timeout: 120000 });
  ssh(`docker cp /tmp/cmd.js ${CONTAINER}:/app/cmd.js`);
  return ssh(`docker exec ${CONTAINER} sh -c "cd /app && node cmd.js"`, timeout);
}

/** E-books prontos que nunca foram ao Hotmart e ainda tem PDF em disco. */
function buscarPendentes(limite) {
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 5000');
    db.prepare('CREATE TABLE IF NOT EXISTS hotmart_publicar_falha (ebook_id TEXT PRIMARY KEY, tentativas INTEGER, erro TEXT, quando INTEGER)').run();
    const rows = db.prepare(
      "SELECT e.id, e.title, e.subtitle, e.topic, e.description, e.pdf_path, e.cover_path, e.price, e.language " +
      "FROM ebooks e WHERE (e.hotmart_url IS NULL OR e.hotmart_url = '') " +
      "AND (e.hotmart_product_id IS NULL OR e.hotmart_product_id = '') " +
      // Nao republicar titulo que ja tem produto no ar: auditoria de 02/09/2026
      // achou 51 titulos duplicados no Hotmart, um com DEZOITO copias. A causa e
      // o reciclo de topicos gerando o mesmo titulo, sem ninguem checar.
      "AND NOT EXISTS (SELECT 1 FROM ebooks d WHERE d.title = e.title " +
      "  AND d.hotmart_product_id IS NOT NULL AND d.hotmart_product_id <> '') " +
      "AND e.pdf_path IS NOT NULL AND e.cover_path IS NOT NULL AND e.cover_path <> '' " +
      // Livro que falha sempre (ex.: japones com descricao curta em 16/09/2026)
      // ocupava metade de cada lote. Depois de ${MAX_TENTATIVAS} falhas sai da fila.
      "AND e.id NOT IN (SELECT ebook_id FROM hotmart_publicar_falha WHERE tentativas >= ${MAX_TENTATIVAS}) " +
      "ORDER BY e.rowid DESC LIMIT ?"
    ).all(${limite} * 10);
    // PORTAO: so publica com CAPA VIRAL em disco. Produto entra no marketplace
    // uma vez so — se subir com o placeholder cinza, fica competindo com um
    // icone generico e nao ha segunda impressao. Melhor nao publicar hoje do
    // que publicar sem capa.
    const candidatos = rows.filter(r => fs.existsSync(r.pdf_path) && fs.existsSync(r.cover_path));
    // TITULO JA NA HOTMART: cadastro que falhou depois de criar o produto deixava
    // o id fora do banco e a rodada seguinte criava outra copia (214 copias em
    // 16/09/2026). Antes de criar, liga o e-book ao produto que ja existe.
    (async () => {
      const ok = [];
      let catalogo = null;
      try {
        const tok = fs.readFileSync('/app/data/hotmart_access_token.txt', 'utf8').trim();
        catalogo = await require('/app/src/agents/hotmartCatalogo').baixarCatalogo(tok);
      } catch (e) { console.error('catalogo indisponivel: ' + e.message); }
      if (!catalogo) { console.log('[]'); return; }  // sem conferir, nao publica
      const { idsPorTitulo } = require('/app/src/agents/hotmartCatalogo');
      const liga = db.prepare("UPDATE ebooks SET hotmart_product_id = ?, hotmart_url = ?, status = 'published' WHERE id = ?");
      for (const r of candidatos) {
        const existentes = idsPorTitulo(catalogo, r.title);
        if (existentes.length) {
          liga.run(existentes[0], 'https://hotmart.com/product/' + existentes[0], r.id);
          console.error('ja existe na Hotmart: ' + existentes[0] + ' ' + r.title);
          // Produto de cadastro interrompido pode estar sem arquivo: o PDF ja esta
          // em disco, entao entra na fila do enviarPdfsRegerados.
          const tem = await require('/app/src/agents/hotmartConteudo').consultarConteudo(existentes[0]);
          if (tem === false) {
            db.prepare('CREATE TABLE IF NOT EXISTS hotmart_sem_arquivo (produto TEXT PRIMARY KEY, ebook_id TEXT, quando INTEGER)').run();
            db.prepare('INSERT OR REPLACE INTO hotmart_sem_arquivo VALUES (?,?,?)').run(existentes[0], r.id, Date.now());
            console.error('  sem arquivo — na fila de envio do PDF');
          }
          continue;
        }
        ok.push(r);
        if (ok.length >= ${limite}) break;
      }
      console.log(JSON.stringify(ok));
    })();
  `);
  const m = saida.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

function baixar(remoto, destino) {
  ssh(`docker cp ${CONTAINER}:${remoto} /tmp/arquivo_atual`);
  execFileSync('scp', [`${VPS}:/tmp/arquivo_atual`, destino], { timeout: 180000 });
  return fs.existsSync(destino) && fs.statSync(destino).size > 1000;
}

function gravarFalha(ebookId, erro) {
  const js = `
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 8000');
    db.prepare('CREATE TABLE IF NOT EXISTS hotmart_publicar_falha (ebook_id TEXT PRIMARY KEY, tentativas INTEGER, erro TEXT, quando INTEGER)').run();
    db.prepare("INSERT INTO hotmart_publicar_falha VALUES (?, 1, ?, ?) ON CONFLICT(ebook_id) DO UPDATE SET tentativas = tentativas + 1, erro = excluded.erro, quando = excluded.quando")
      .run(${JSON.stringify(ebookId)}, ${JSON.stringify(String(erro || '').slice(0, 200))}, Date.now());
    console.log('falha registrada');
  `;
  rodarNoContainer(js);
}

function gravarResultado(ebookId, url, produtoId) {
  // Gravar o id do produto MESMO sem url: sem isso o proximo passe recria o
  // produto no marketplace, e duplicata nao se desfaz sozinha.
  const js = `
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.pragma('busy_timeout = 8000');
    db.prepare("UPDATE ebooks SET hotmart_url = COALESCE(NULLIF(?, ''), hotmart_url), hotmart_product_id = COALESCE(NULLIF(?, ''), hotmart_product_id), status = 'published' WHERE id = ?")
      .run(${JSON.stringify(url || '')}, ${JSON.stringify(String(produtoId || ''))}, ${JSON.stringify(ebookId)});
    console.log('gravado');
  `;
  rodarNoContainer(js);
}

async function main() {
  const limite = parseInt(arg('limite', '5'), 10);
  const dryRun = process.argv.includes('--dry-run');

  console.log('consultando a fila no VPS...');
  const itens = buscarPendentes(limite);
  if (!itens.length) { console.log('nada pendente'); return; }
  console.log(`${itens.length} e-books a publicar`);

  if (dryRun) {
    for (const e of itens) console.log('  [dry-run] ' + String(e.title).slice(0, 50));
    return;
  }

  const puppeteer = require('puppeteer');
  const { publishToHotmart } = require('../src/agents/publisherHotmart');
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1280, height: 900 } });

  let ok = 0;
  const t0 = Date.now();
  fs.mkdirSync(TMP, { recursive: true });

  try {
    for (const [i, e] of itens.entries()) {
      const pdfLocal = path.join(TMP, 'ebook_' + i + '.pdf');
      const capaLocal = path.join(TMP, 'capa_' + i + '.png');
      let r = null;
      try {
        if (!baixar(e.pdf_path, pdfLocal)) throw new Error('PDF nao veio do VPS');
        // A capa deixou de ser opcional: sem ela, nao publica.
        if (!baixar(e.cover_path, capaLocal)) throw new Error('capa viral nao veio do VPS — nao publico sem capa');

        r = await publishToHotmart({
          title: e.title, subtitle: e.subtitle, topic: e.topic, description: e.description,
          pdfPath: pdfLocal, coverPath: capaLocal,
          price: e.price, language: e.language,
        }, { browser });   // <- navegador do usuario: sessao nativa

        if (r && (r.url || r.hotmartProductId)) {
          gravarResultado(e.id, r.url || '', r.hotmartProductId || '');
        }
      } catch (err) {
        console.log('  erro: ' + String(err.message).slice(0, 100));
      }
      for (const f of [pdfLocal, capaLocal]) { try { fs.unlinkSync(f); } catch {} }

      const sucesso = !!(r && r.url);
      if (sucesso) ok++;
      else if (!(r && r.hotmartProductId)) {
        try { gravarFalha(e.id, (r && r.error) || 'sem url'); } catch (err) { console.log('  falha nao registrada: ' + String(err.message).slice(0, 80)); }
      }
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  [${i + 1}/${itens.length}] ${sucesso ? 'OK  ' : 'FALHA'} ${String(e.title).slice(0, 40)}` +
        (sucesso ? ' -> ' + r.url : ' :: ' + ((r && r.error) || 'sem url')) + `  (${min} min)`);
    }
  } finally {
    // NAO fechar o navegador: e do usuario.
    browser.disconnect();
  }

  console.log(`\nTOTAL: ${ok}/${itens.length} publicados em ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
