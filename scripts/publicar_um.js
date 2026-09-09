'use strict';
/**
 * publicar_um.js — publica UM e-book especifico, escolhido pelo idioma.
 *
 * Existe para testar o cadastro de idioma sem depender da ordem da fila: a fila
 * normal e por rowid DESC e quase sempre entrega portugues, que e justamente o
 * caso em que o seletor de idioma nao faz nada (ja e o padrao).
 *
 * Uso:  node scripts/publicar_um.js --idioma=ja-JP
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.EBOOK_CONTAINER || 'platform-ebook-publisher-1';
const VPS = process.env.VPS_ALIAS || 'vps';
const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';
const TMP = path.join(os.tmpdir(), 'publicar-um');

function arg(nome, padrao) {
  const p = process.argv.find(a => a.startsWith('--' + nome + '='));
  return p ? p.split('=')[1] : padrao;
}
function ssh(cmd, timeout) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=30', VPS, cmd], { encoding: 'utf8', timeout: timeout || 180000, maxBuffer: 8 * 1024 * 1024 });
}
function rodarNoContainer(js) {
  fs.mkdirSync(TMP, { recursive: true });
  const local = path.join(TMP, 'cmd.js');
  fs.writeFileSync(local, js);
  execFileSync('scp', [local, `${VPS}:/tmp/cmd1.js`], { timeout: 120000 });
  ssh(`docker cp /tmp/cmd1.js ${CONTAINER}:/app/cmd1.js`);
  return ssh(`docker exec ${CONTAINER} sh -c "cd /app && node cmd1.js"`);
}
function baixar(remoto, destino) {
  ssh(`docker cp ${CONTAINER}:${remoto} /tmp/arq1`);
  execFileSync('scp', [`${VPS}:/tmp/arq1`, destino], { timeout: 180000 });
  return fs.existsSync(destino) && fs.statSync(destino).size > 1000;
}

async function main() {
  const idioma = arg('idioma', 'ja-JP');
  const saida = rodarNoContainer(`
    const D = require('better-sqlite3');
    const fs = require('fs');
    const db = new D('/app/data/metrics.db', { readonly: true });
    const r = db.prepare(
      "SELECT id, title, subtitle, topic, description, pdf_path, cover_path, price, language FROM ebooks " +
      "WHERE language = ? AND (hotmart_url IS NULL OR hotmart_url='') " +
      "AND (hotmart_product_id IS NULL OR hotmart_product_id='') " +
      "AND pdf_path IS NOT NULL AND cover_path IS NOT NULL ORDER BY rowid DESC LIMIT 12"
    ).all(${JSON.stringify(idioma)});
    const ok = r.filter(x => fs.existsSync(x.pdf_path) && fs.existsSync(x.cover_path)).slice(0, 1);
    console.log(JSON.stringify(ok));
  `);
  const m = saida.match(/\[.*\]/s);
  const itens = m ? JSON.parse(m[0]) : [];
  if (!itens.length) { console.log('nenhum e-book pronto em ' + idioma); return; }
  const e = itens[0];
  console.log('publicando [' + e.language + '] ' + String(e.title).slice(0, 50));

  const pdfLocal = path.join(TMP, 'e.pdf');
  const capaLocal = path.join(TMP, 'c.png');
  if (!baixar(e.pdf_path, pdfLocal)) throw new Error('PDF nao veio');
  if (!baixar(e.cover_path, capaLocal)) throw new Error('capa nao veio');

  const puppeteer = require('puppeteer');
  const { publishToHotmart } = require('../src/agents/publisherHotmart');
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1280, height: 900 } });
  let r = null;
  try {
    r = await publishToHotmart({
      title: e.title, subtitle: e.subtitle, topic: e.topic, description: e.description,
      pdfPath: pdfLocal, coverPath: capaLocal, price: e.price, language: e.language,
    }, { browser });
  } finally { browser.disconnect(); }

  console.log('resultado: ' + JSON.stringify({ url: r && r.url, id: r && r.hotmartProductId, erro: r && r.error }).slice(0, 160));
  if (r && r.hotmartProductId) {
    // Conferir o que a Hotmart REALMENTE gravou — o log do wizard nao prova nada.
    const chk = rodarNoContainer(`
      const fs = require('fs');
      const tok = fs.readFileSync('/app/data/hotmart_access_token.txt','utf8').trim();
      (async () => {
        const r = await fetch('https://api-product.vulcano.hotmart.com/product/v1/product/${r.hotmartProductId}/basic-information',
          { headers: { Authorization: 'Bearer ' + tok } });
        const p = await r.json();
        console.log('VERIFICADO contentLocale=' + p.contentLocale + ' targetCountry=' + p.targetCountry);
      })();
    `);
    console.log(chk.trim().split('\n').pop());
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
