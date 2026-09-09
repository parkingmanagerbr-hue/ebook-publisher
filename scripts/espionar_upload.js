'use strict';
/**
 * espionar_upload.js — captura o CORPO exato do upload de capa.
 *
 * O endpoint ja e conhecido (POST /product/v1/product/photo) e a resposta
 * tambem ({id, name, webPath, url}). O que falta e o formato do corpo: toda
 * tentativa minha devolve HTTP 500 — de dentro da pagina, com cookies e token,
 * com PNG de 3MB e com JPEG de 3KB, e com os nomes de campo file/photo/image.
 * Logo, o problema nao e auth, nem tamanho, nem formato: e algum campo ou
 * cabecalho que so a interface envia.
 *
 * O gravador de rede do Puppeteer NAO mostra corpo de multipart, entao aqui a
 * captura acontece DENTRO da pagina: intercepta FormData.append, fetch e
 * XMLHttpRequest antes do upload e registra chave por chave.
 *
 * Uso: node scripts/espionar_upload.js 8487818
 *      (humano faz UM upload nessa janela; o resultado sai no console)
 */
const puppeteer = require('puppeteer');

const CDP = process.env.HOTMART_CDP || 'http://127.0.0.1:9223';

async function main() {
  const id = process.argv[2] || '8487818';
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const page = await browser.newPage();

  // A instrumentacao precisa existir ANTES de qualquer script da pagina rodar.
  await page.evaluateOnNewDocument(() => {
    window.__captura = [];
    const registra = o => { try { window.__captura.push(o); } catch {} };

    const appendOrig = FormData.prototype.append;
    FormData.prototype.append = function (chave, valor, nome) {
      const desc = valor instanceof Blob
        ? '[Blob tipo=' + valor.type + ' bytes=' + valor.size + ' nome=' + (nome || '') + ']'
        : String(valor).slice(0, 120);
      registra({ tipo: 'FormData.append', chave, valor: desc });
      return appendOrig.apply(this, arguments);
    };

    const fetchOrig = window.fetch;
    window.fetch = function (entrada, init) {
      const url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
      if (/product\/photo|upload/i.test(url)) {
        const h = (init && init.headers) || {};
        registra({ tipo: 'fetch', url: String(url).slice(0, 120),
          metodo: (init && init.method) || 'GET',
          cabecalhos: JSON.stringify(h).slice(0, 300),
          corpoTipo: init && init.body ? init.body.constructor.name : 'nenhum' });
      }
      return fetchOrig.apply(this, arguments);
    };

    const openOrig = XMLHttpRequest.prototype.open;
    const sendOrig = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return openOrig.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (corpo) {
      if (/product\/photo|upload/i.test(this.__u || '')) {
        registra({ tipo: 'xhr', metodo: this.__m, url: String(this.__u).slice(0, 120),
          corpoTipo: corpo ? corpo.constructor.name : 'nenhum' });
      }
      return sendOrig.apply(this, arguments);
    };
  });

  await page.bringToFront();
  await page.goto('https://app.hotmart.com/products/manage/' + id + '/info',
    { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Instrumentar TODAS as abas do Hotmart, nao so a que eu abri.
  //
  // As duas primeiras capturas voltaram vazias porque o humano fez o upload em
  // OUTRA aba — havia seis abertas — e evaluateOnNewDocument so vale para a
  // pagina em que foi registrado. Injetar o mesmo gancho em cada aba viva
  // elimina a chance de gravar a janela errada.
  const paginas = await browser.pages();
  let instrumentadas = 0;
  for (const pg of paginas) {
    if (!/hotmart\.com/.test(pg.url())) continue;
    try {
      await pg.evaluate(() => {
        if (window.__captura) return;              // ja instrumentada
        window.__captura = [];
        const reg = o => { try { window.__captura.push(o); } catch {} };
        const ap = FormData.prototype.append;
        FormData.prototype.append = function (k, v, n) {
          reg({ tipo: 'FormData.append', chave: k,
                valor: v instanceof Blob ? '[Blob ' + v.type + ' ' + v.size + 'b nome=' + (n || '') + ']' : String(v).slice(0, 120) });
          return ap.apply(this, arguments);
        };
        const fo = window.fetch;
        window.fetch = function (e, i) {
          const u = typeof e === 'string' ? e : (e && e.url) || '';
          if (/product\/photo|upload/i.test(u)) {
            reg({ tipo: 'fetch', url: String(u).slice(0, 120), metodo: (i && i.method) || 'GET',
                  cabecalhos: JSON.stringify((i && i.headers) || {}).slice(0, 300),
                  corpoTipo: i && i.body ? i.body.constructor.name : 'nenhum' });
          }
          return fo.apply(this, arguments);
        };
        const oo = XMLHttpRequest.prototype.open, so = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return oo.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (c) {
          if (/product\/photo|upload/i.test(this.__u || '')) reg({ tipo: 'xhr', metodo: this.__m, url: String(this.__u).slice(0, 120), corpoTipo: c ? c.constructor.name : 'nenhum' });
          return so.apply(this, arguments);
        };
      });
      instrumentadas++;
    } catch {}
  }
  console.log('abas do Hotmart instrumentadas: ' + instrumentadas);

  console.log('\n=== PRONTO — faca UM upload de capa nesta janela ===\n');

  // Fica lendo o que a pagina registrou, ate aparecer o upload.
  const limite = Date.now() + 10 * 60 * 1000;
  let visto = 0;
  while (Date.now() < limite) {
    await new Promise(r => setTimeout(r, 4000));
    // Le a captura de TODAS as abas, nao so da minha.
    const lista = [];
    for (const pg of await browser.pages()) {
      if (!/hotmart\.com/.test(pg.url())) continue;
      const cap = await pg.evaluate(() => JSON.stringify(window.__captura || [])).catch(() => '[]');
      for (const x of JSON.parse(cap)) lista.push(x);
    }
    for (let i = visto; i < lista.length; i++) console.log(JSON.stringify(lista[i]));
    if (lista.length > visto) visto = lista.length;
  }
  browser.disconnect();
}

if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
