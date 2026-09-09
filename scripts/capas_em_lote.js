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
function paraLocaleHotmart(lang) {
  return LOCALE_HOTMART[lang] || null;   // desconhecido: nao arrisca, mantem o atual
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

/** Produtos no Hotmart que ainda nao passaram por aqui e tem capa em disco. */
function buscarPendentes(limite) {
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db');
    db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();
    const rows = db.prepare(
      "SELECT e.hotmart_product_id AS pid, e.title, e.cover_path, e.language FROM ebooks e " +
      "WHERE e.hotmart_product_id IS NOT NULL AND e.hotmart_product_id <> '' " +
      "AND e.cover_path IS NOT NULL AND e.cover_path <> '' " +
      "AND NOT EXISTS (SELECT 1 FROM cover_backfill b WHERE b.produto = CAST(e.hotmart_product_id AS TEXT)) " +
      "ORDER BY e.rowid DESC LIMIT ?"
    ).all(${limite} * 6);
    console.log(JSON.stringify(rows.filter(r => fs.existsSync(r.cover_path)).slice(0, ${limite})));
  `);
  const m = saida.match(/\[.*\]/s);
  return m ? JSON.parse(m[0]) : [];
}

function baixarCapa(remoto, destino) {
  ssh(`docker cp ${CONTAINER}:${remoto} /tmp/capa_lote.png`);
  execFileSync('scp', [`${VPS}:/tmp/capa_lote.png`, destino], { timeout: 120000 });
  return fs.existsSync(destino) && fs.statSync(destino).size > 1000;
}

function registrar(produto, ok) {
  rodarNoContainer(`
    const D = require('better-sqlite3');
    const db = new D('/app/data/metrics.db');
    db.prepare('CREATE TABLE IF NOT EXISTS cover_backfill (produto TEXT PRIMARY KEY, quando INTEGER NOT NULL, ok INTEGER NOT NULL)').run();
    db.prepare('INSERT OR REPLACE INTO cover_backfill (produto, quando, ok) VALUES (?,?,?)')
      .run('${produto}', ${Date.now()}, ${ok ? 1 : 0});
    console.log('ok');
  `);
}

/** Sobe a capa e grava no produto, tudo de dentro da pagina logada. */
async function aplicar(page, id, b64, locale) {
  return await page.evaluate(async (dados, produto, loc) => {
    const tok = localStorage.getItem('token');
    if (!tok) return { erro: 'sem token' };
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
  const itens = buscarPendentes(limite);
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
  const t0 = Date.now();
  try {
    // Uma pagina do dominio serve para todos: o fetch e por produto, nao por URL.
    await page.goto('https://app.hotmart.com/products/producer', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 12000));

    for (const [i, item] of itens.entries()) {
      const local = path.join(TMP, 'c_' + item.pid + '.png');
      let r = { erro: 'nao processado' };
      try {
        if (!baixarCapa(item.cover_path, local)) throw new Error('capa nao veio do VPS');
        const b64 = fs.readFileSync(local).toString('base64');
        r = await aplicar(page, item.pid, b64, paraLocaleHotmart(item.language));
      } catch (e) {
        r = { erro: String(e.message).slice(0, 80) };
      }
      try { fs.unlinkSync(local); } catch {}

      const bom = !!r.capa;
      if (bom) ok++;
      if (bom && r.locale && r.locale !== 'PT_BR') idiomasCorrigidos++;
      try { registrar(item.pid, bom); } catch {}

      console.log(`  [${i + 1}/${itens.length}] ${bom ? 'OK  ' : 'FALHA'} ${item.pid} ${String(item.title).slice(0, 34)}` +
        (bom ? '  locale=' + r.locale : '  :: ' + r.erro));
    }
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
  console.log(`\nTOTAL: ${ok}/${itens.length} capas em ${((Date.now() - t0) / 60000).toFixed(1)} min` +
    (idiomasCorrigidos ? ` | ${idiomasCorrigidos} com idioma nao-portugues gravado` : ''));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
