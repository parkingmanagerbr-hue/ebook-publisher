'use strict';
/**
 * capas_em_lote.js — sobe a capa E corrige o idioma dos produtos no Hotmart.
 *
 * COMO FUNCIONA (descoberto em 09/09/2026, depois de dias no escuro):
 *   1. POST /product/v1/product/photo  com FormData campo "data" = File
 *   2. PUT  /product/v1/product/{id}/basic-information  com coverPhoto + campos
 *
 * TRES DETALHES QUE DECIDEM, e cada um sozinho quebrava tudo:
 *   - o campo chama "data". Testei file/photo/image/productPhoto/coverPhoto/
 *     files/upload — todos HTTP 500. So apareceu ao instrumentar
 *     FormData.append dentro da pagina, porque gravador de rede NAO mostra
 *     corpo de multipart.
 *   - tem de ser File, nao Blob. Blob anonimo sobe (200) mas a midia fica com
 *     name="blob" e o PUT seguinte devolve 500.
 *   - a chamada tem de sair DE DENTRO DA PAGINA logada. Do servidor, com o
 *     mesmo Bearer, e sempre 500 — faltam cookies/origem.
 *
 * Por isso este script dirige o Chrome ja logado em vez de falar com a API
 * direto. Nao ha dialogo nativo envolvido: o arquivo entra como base64 e vira
 * File dentro da pagina.
 *
 * O idioma vai no MESMO PUT: 342 produtos estavam cadastrados como
 * Portugues/Brasil com conteudo em japones, ingles, espanhol.
 *
 * Uso:
 *   node scripts/capas_em_lote.js --limite=20
 *   node scripts/capas_em_lote.js --limite=5 --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const TMP = path.join(os.tmpdir(), 'capas-lote');

/**
 * Codigo de idioma como a Hotmart aceita.
 *
 * Portugues e o unico com regiao: PT_BR. Todos os outros sao so a lingua — EN,
 * ES, JA. Medido: enviar EN_US faz o PUT devolver 200 e DESCARTAR a requisicao
 * inteira em silencio (nem a capa entrava junto); com EN ele grava. Um valor
 * invalido aqui nao da erro, so some com a alteracao — por isso a lista e
 * fechada em vez de derivada do codigo BCP-47.
 */
const LOCALE_HOTMART = {
  'pt-BR': 'PT_BR', 'en-US': 'EN', 'es-ES': 'ES', 'de-DE': 'DE', 'fr-FR': 'FR',
  'it-IT': 'IT', 'nl-NL': 'NL', 'pl-PL': 'PL', 'ja-JP': 'JA', 'zh-CN': 'ZH',
  'ko-KR': 'KO', 'ru-RU': 'RU',
};
// Os livros novos gravam o idioma curto ("fr", "ja"); so o codigo completo
// estava na lista, e o curto devolvia null — o produto ficava com o PT_BR do
// cadastro. Caso real em 16/09/2026: livro frances subiu como PT_BR.
const LOCALE_POR_BASE = { pt: 'PT_BR', en: 'EN', es: 'ES', de: 'DE', fr: 'FR', it: 'IT', nl: 'NL', pl: 'PL', ja: 'JA', zh: 'ZH', ko: 'KO', ru: 'RU' };
function paraLocaleHotmart(lang) {
  if (!lang) return null;
  if (Object.prototype.hasOwnProperty.call(LOCALE_HOTMART, lang)) return LOCALE_HOTMART[lang];
  const base = String(lang).toLowerCase().split(/[-_]/)[0];
  // desconhecido: nao arrisca, mantem o atual
  return Object.prototype.hasOwnProperty.call(LOCALE_POR_BASE, base) ? LOCALE_POR_BASE[base] : null;
}

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}
function ssh(cmd, timeout) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=30', VPS, cmd],
    { encoding: 'utf8', timeout: timeout || 180000, maxBuffer: 8 * 1024 * 1024 });
}
function rodarNoContainer(js) {
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'q.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, `${VPS}:/tmp/qlote.js`], { timeout: 120000 });
  ssh(`docker cp /tmp/qlote.js ${CONTAINER}:/app/qlote.js`);
  return ssh(`docker exec ${CONTAINER} sh -c "cd /app && node qlote.js"`);
}

/** Itens dados a mao (PRODUTO:EBOOK_ID), com capa e idioma lidos do e-book. */
function buscarForcados(lista) {
  const pares = lista.split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(':'));
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db', { readonly: true });
    const pares = ${JSON.stringify(pares)};
    const out = [];
    for (const [pid, id] of pares) {
      const e = db.prepare('SELECT title, cover_path, language FROM ebooks WHERE id = ?').get(id);
      if (e && e.cover_path && fs.existsSync(e.cover_path)) out.push({ pid, title: e.title, cover_path: e.cover_path, language: e.language });
    }
    console.log(JSON.stringify(out));
  `);
  const m = saida.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

/** Produtos no Hotmart que ainda nao passaram por aqui e tem capa em disco. */
function buscarPendentes(limite) {
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db');
    db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();
    // ok = 1: so quem SUBIU de verdade sai da fila. Antes o registro entrava
    // em qualquer desfecho, entao falha de upload virava "processado" e o
    // produto sumia para sempre — 25 ficaram presos assim, sem nunca
    // reaparecer para nova tentativa.
    const naoSubiu = "AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT) AND b.ok = 1) ";
    const valido = "e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' AND e.cover_path IS NOT NULL AND e.cover_path <> '' ";

    // PRIMEIRO: capa viral ja gerada e ainda nao enviada, direto pela tabela da
    // regeneracao. A busca olhava so as linhas mais recentes do catalogo; quando
    // a regeneracao passou a atender os livros MENOS tentados (os antigos), a
    // capa nova ficava fora da janela e nao subia — medido: "geradas 3, subidas
    // 0/0" no primeiro ciclo depois da mudanca.
    let virais = [];
    try {
      virais = db.prepare(
        "SELECT e.hotmart_product_id AS pid, e.title, e.cover_path, e.language FROM cover_viral_v2 v " +
        "JOIN ebooks e ON e.id = v.ebook_id WHERE " + valido + naoSubiu +
        "ORDER BY v.quando DESC LIMIT ?"
      ).all(${limite} * 6);
    } catch (e) { /* tabela ainda nao existe: so a busca geral */ }

    const geral = db.prepare(
      "SELECT e.hotmart_product_id AS pid, e.title, e.cover_path, e.language FROM ebooks e WHERE " +
      valido + naoSubiu + "ORDER BY e.rowid DESC LIMIT ?"
    ).all(${limite} * 6);

    const vistos = new Set(), rows = [];
    for (const r of [...virais, ...geral]) {
      if (vistos.has(r.pid)) continue;
      vistos.add(r.pid);
      rows.push(r);
    }
    console.log(JSON.stringify(rows.filter(r => fs.existsSync(r.cover_path)).slice(0, ${limite})));
  `);
  const m = saida.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

/**
 * Traz TODAS as capas do lote num pacote so.
 *
 * Uma por uma custava duas viagens de SSH cada (copiar do container, depois
 * puxar para ca) — quarenta viagens num lote de vinte, boa parte do tempo de
 * ciclo gasta em handshake. Aqui e um tar unico: duas viagens para o lote
 * inteiro.
 *
 * Nomeia cada arquivo pelo id do produto, e nao pelo nome original: dois
 * e-books podem apontar para a mesma capa em disco, e o nome original faria um
 * sobrescrever o outro dentro do tar.
 */
function baixarCapasEmLote(itens, destinoDir) {
  fs.mkdirSync(destinoDir, { recursive: true });
  const copias = itens
    .map(i => `cp '${i.cover_path}' /tmp/lotecapas/${i.pid}.png 2>/dev/null || true`)
    .join('; ');
  ssh(`docker exec ${CONTAINER} sh -c "rm -rf /tmp/lotecapas && mkdir -p /tmp/lotecapas && ${copias}" && ` +
      `rm -rf /tmp/lotecapas && docker cp ${CONTAINER}:/tmp/lotecapas /tmp/lotecapas && ` +
      `tar -czf /tmp/lotecapas.tgz -C /tmp/lotecapas .`, 600000);
  const tgz = path.join(destinoDir, 'lote.tgz');
  execFileSync('scp', [`${VPS}:/tmp/lotecapas.tgz`, tgz], { timeout: 600000 });
  // Extrair DENTRO da pasta, com nome relativo: sem letra de drive no
  // argumento, nao ha dois-pontos para o tar confundir com host remoto.
  //
  // A versao anterior usava --force-local, que so o tar do Git Bash aceita. O
  // vigia religa o passe via cmd.exe, onde "tar" e o do Windows (bsdtar), que
  // responde "Option --force-local is not supported" — todo lote de upload
  // quebrava ali e o relatorio mostrava so "subidas 0/0". Caminho relativo
  // funciona igual nos dois.
  execFileSync('tar', ['-xzf', 'lote.tgz'], { cwd: destinoDir, timeout: 300000 });
  try { fs.unlinkSync(tgz); } catch {}

  const mapa = new Map();
  for (const i of itens) {
    const f = path.join(destinoDir, i.pid + '.png');
    if (fs.existsSync(f) && fs.statSync(f).size > 1000) mapa.set(String(i.pid), f);
  }
  return mapa;
}

/**
 * Grava o resultado de VARIOS produtos numa unica ida ao container.
 *
 * Antes cada produto custava tres viagens de SSH so para ser marcado (escrever o
 * script, copiar para dentro do container, executar). Com vinte por lote isso
 * eram sessenta round-trips gastos em contabilidade, mais que o proprio upload.
 *
 * O preco de agrupar: se o processo morrer no meio do lote, as marcas ainda nao
 * gravadas se perdem e esses produtos serao refeitos. Refazer e barato e
 * idempotente; sessenta viagens por ciclo, nao.
 */
function registrarLote(resultados) {
  if (!resultados.length) return;
  const linhas = resultados
    .map(r => `['${String(r.produto).replace(/'/g, '')}', ${r.quando}, ${r.ok ? 1 : 0}]`)
    .join(',');
  rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();
    const ins = db.prepare('INSERT OR REPLACE INTO cover_backfill (produto, quando, ok) VALUES (?,?,?)');
    const gravar = db.transaction(rows => { for (const r of rows) ins.run(r[0], r[1], r[2]); });
    gravar([${linhas}]);
    console.log('gravados ' + ${resultados.length});
  `);
}

/** Sobe a capa e grava no produto, tudo de dentro da pagina logada. */
async function aplicar(page, id, b64, locale) {
  return await page.evaluate(async (dados, produto, loc) => {
    const tok = localStorage.getItem('token');
    // SESSAO_MORTA e diferente de falha do produto: quando a sessao cai, TODOS
    // falham igual, e insistir so consumiria a fila inteira em erro. Quem chama
    // aborta o lote em vez de marcar produto por produto.
    if (!tok) return { erro: 'SESSAO_MORTA' };
    const bin = Uint8Array.from(atob(dados), c => c.charCodeAt(0));
    // File (nao Blob): o Blob anonimo vira midia name="blob" e o PUT da 500.
    const arquivo = new File([bin], 'capa.png', { type: 'image/png' });
    const fd = new FormData();
    fd.append('data', arquivo);

    const up = await fetch('https://api-product.vulcano.hotmart.com/product/v1/product/photo', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd, credentials: 'include',
    });
    if (!up.ok) return { erro: 'upload HTTP ' + up.status };
    const midia = JSON.parse(await up.text());

    const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const base = 'https://api-product.vulcano.hotmart.com/product/v1/product/' + produto + '/basic-information';
    const at = await (await fetch(base, { headers: H, credentials: 'include' })).json();

    const corpo = {
      name: at.name,
      // Idioma no MESMO PUT: e o unico caminho que grava (a API isolada ignora).
      contentLocale: loc || at.contentLocale,
      targetCountry: at.targetCountry,
      ucode: at.ucode, categoryId: at.categoryId, subcategoryId: at.subcategoryId,
      description: at.description, coverPhoto: midia,
    };
    const sv = await fetch(base, { method: 'PUT', headers: H, credentials: 'include', body: JSON.stringify(corpo) });
    if (!sv.ok) return { erro: 'PUT HTTP ' + sv.status };

    await new Promise(r => setTimeout(r, 1800));
    const dep = await (await fetch(base, { headers: H, credentials: 'include' })).json();
    // Confirmar pelo EFEITO, nunca pelo status: ja houve 200 que nao gravava nada.
    return { capa: !!(dep.coverPhoto && dep.coverPhoto.webPath), locale: dep.contentLocale };
  }, b64, String(id), locale);
}

async function main() {
  const limite = parseInt(arg('limite', '10'), 10);
  const dryRun = process.argv.includes('--dry-run');

  console.log('consultando a fila...');
  // --itens=PRODUTO:EBOOK_ID,... aplica a capa do e-book em produtos especificos,
  // inclusive os que nao estao no banco. Existe para limpar produtos que
  // receberam imagem de TESTE durante a descoberta do upload — quatro copias do
  // mesmo e-book japones, duas delas vendendo, fora de qualquer fila.
  const forcados = arg('itens', '');
  const itens = forcados ? buscarForcados(forcados) : buscarPendentes(limite);
  if (!itens.length) { console.log('nada pendente'); return; }
  console.log(itens.length + ' produtos na fila');

  if (dryRun) {
    for (const i of itens) console.log('  [dry-run] ' + i.pid + '  ' + (i.language || '?') + '  ' + String(i.title).slice(0, 40));
    return;
  }

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  fs.mkdirSync(TMP, { recursive: true });

  let ok = 0, idiomasCorrigidos = 0;
  const pendentes = [];   // gravados de uma vez no fim (ver registrarLote)
  const t0 = Date.now();
  try {
    // Uma pagina do dominio serve para todos: o fetch e por produto, nao por URL.
    await page.goto('https://app.hotmart.com/products/producer', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 12000));

    // Um pacote para o lote inteiro, antes de comecar a subir.
    const capas = baixarCapasEmLote(itens, TMP);
    console.log(capas.size + '/' + itens.length + ' capas baixadas do VPS');

    for (const [i, item] of itens.entries()) {
      const local = capas.get(String(item.pid));
      let r = { erro: 'nao processado' };
      try {
        if (!local) throw new Error('capa nao veio do VPS');
        const b64 = fs.readFileSync(local).toString('base64');
        r = await aplicar(page, item.pid, b64, paraLocaleHotmart(item.language));
      } catch (e) {
        r = { erro: String(e.message).slice(0, 80) };
      }
      try { if (local) fs.unlinkSync(local); } catch {}

      if (r && r.erro === 'SESSAO_MORTA') {
        console.log('  sessao do Hotmart caiu — abortando o lote (nada e marcado)');
        break;
      }
      const bom = !!r.capa;
      if (bom) ok++;
      if (bom && r.locale && r.locale !== 'PT_BR') idiomasCorrigidos++;
      pendentes.push({ produto: item.pid, quando: Date.now(), ok: bom });

      console.log(`  [${i + 1}/${itens.length}] ${bom ? 'OK  ' : 'FALHA'} ${item.pid} ${String(item.title).slice(0, 34)}` +
        (bom ? '  locale=' + r.locale : '  :: ' + r.erro));
    }
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
    // No finally: um erro no meio do lote nao pode jogar fora o que ja subiu,
    // senao esses produtos seriam reprocessados na proxima rodada.
    try { registrarLote(pendentes); } catch (e) { console.log('nao consegui gravar o lote: ' + e.message.slice(0, 60)); }
  }
  console.log(`\nTOTAL: ${ok}/${itens.length} capas em ${((Date.now() - t0) / 60000).toFixed(1)} min` +
    (idiomasCorrigidos ? ` | ${idiomasCorrigidos} com idioma nao-portugues gravado` : ''));
}

module.exports = { paraLocaleHotmart };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
