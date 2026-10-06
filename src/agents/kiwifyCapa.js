'use strict';
/**
 * kiwifyCapa.js — capa e categoria dos produtos da Kiwify.
 *
 * 06/10/2026: os 921 produtos da conta estavam SEM imagem (o publicador nunca
 * subiu capa) e 23% caiam na categoria "Outros". A imagem nao sobe pela API
 * propria: o painel envia o arquivo a um servico de upload (Transloadit), pede
 * a moderacao (`/v1/uploads/moderate-image`) e so entao "Salvar produto" grava
 * `product_img`. O PUT da Kiwify troca o produto INTEIRO e entrega/checkout
 * moram em outras partes dele; montar esse corpo aqui arriscaria apagar o link
 * de entrega. Por isso quem salva e o proprio painel; daqui sai o arquivo, a
 * categoria e a conferencia pela API.
 */
const { categoriaKiwify, CATEGORIAS } = require('./kiwifyRegras');

const PAINEL = 'https://dashboard.kiwify.com';
const dormir = ms => new Promise(r => setTimeout(r, ms));

/**
 * Preco minimo que o painel aceita, em centavos da moeda. Medido em 06/10/2026:
 * o iene exige ¥1.000 e os 55 produtos em JPY estavam a ¥5 — o painel recusa
 * salvar QUALQUER mudanca neles ("O preco minimo e ¥1,000"), capa incluida.
 */
const PRECO_MINIMO = { JPY: 100000 };

// O que fazer com produto abaixo do minimo: decisao do dono em 06/10/2026 —
// vende em dolar, ao preco base dos estrangeiros (US$ 5,00 = 500 centavos).
const MOEDA_SUBSTITUTA = { moeda: 'USD', centavos: 500 };

/** O produto esta abaixo do minimo da moeda (e o painel nao salva)? Pura. */
function precoAbaixoDoMinimo(produto) {
  const min = PRECO_MINIMO[String((produto && produto.currency) || '').toUpperCase()];
  return !!min && Number(produto.price) < min;
}

/**
 * Quem entra na rodada. `produtos` vem da listagem da Kiwify; `livros` e o
 * mapa id-do-produto -> {title, topic, cover_path} do banco; `feitos` sao os ids
 * ja resolvidos; `forcar` sao ids que precisam de capa nova mesmo tendo imagem
 * (capa errada). Produto sem livro ligado fica de fora: subir a capa de outro
 * livro e pior que nenhuma. Pura.
 */
function filaDeCapas(produtos, livros, { feitos = new Set(), forcar = new Set(), limite = Infinity } = {}) {
  const fila = [];
  // Forcados primeiro: a ordem da listagem da Kiwify muda entre chamadas.
  const ordem = [...(produtos || [])].sort((a, b) => (forcar.has(b && b.id) ? 1 : 0) - (forcar.has(a && a.id) ? 1 : 0));
  for (const p of ordem) {
    if (!p || !p.id || feitos.has(p.id)) continue;
    const converter = precoAbaixoDoMinimo(p);
    const precisa = !p.product_img || forcar.has(p.id) || converter;
    if (!precisa) continue;
    const livro = livros.get(p.id);
    if (!livro || !livro.cover_path) continue;
    fila.push({ id: p.id, nome: p.name, capa: livro.cover_path, categoria: categoriaKiwify(livro.title, livro.topic), trocar: !!p.product_img,
      ...(converter ? { moeda: { de: String(p.currency).toUpperCase(), ...MOEDA_SUBSTITUTA } } : {}) });
    if (fila.length >= limite) break;
  }
  return fila;
}

/** A categoria atual deve ser trocada? Vazia (999), ausente ou "Outros". Pura. */
function categoriaPrecisaTrocar(atual, nova) {
  // null e "" virariam 0 em Number(), que e "Saude e Esportes": contariam como preenchidos.
  const n = atual == null || String(atual).trim() === '' ? NaN : Number(atual);
  if (!Number.isInteger(n) || n === 999 || n === CATEGORIAS.outros) return nova !== CATEGORIAS.outros;
  return false;
}

/**
 * Abre o produto no painel, sobe a capa, acerta a categoria e salva.
 * Devolve { imagem, categoria } com o que o painel enviou. Lanca quando algo
 * nao aconteceu — quem chama confere pela API depois.
 */
async function aplicarNoPainel(page, item, { log = console, esperaMs = 1000 } = {}) {
  await page.goto(PAINEL + '/products/edit/' + item.id, { waitUntil: 'networkidle2', timeout: 90000 });

  // Capa errada: o campo de envio so aparece depois de remover a atual.
  if (item.trocar) {
    let removeu = false;
    for (let t = 0; t < 20 && !removeu; t++) {
      await dormir(esperaMs);
      removeu = await page.evaluate(() => {
      const a = [...document.querySelectorAll('*')].find(x => x.children.length === 0 && /^remover imagem$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
      if (a) { a.click(); return true; }
      return false;
      });
    }
    if (!removeu) throw new Error('KIWIFY_CAPA: "Remover imagem" nao apareceu');
    await dormir(1500);
  }

  let campo = null;
  for (let t = 0; t < 20 && !campo; t++) {
    await dormir(esperaMs);
    for (const i of await page.$$('input[type=file]')) {
      const a = await page.evaluate(e => e.accept + '|' + e.name, i);
      if (/^image\/jpeg,image\/jpg,image\/png\|files/.test(a)) campo = i;
    }
  }
  if (!campo) throw new Error('KIWIFY_CAPA: campo da imagem nao apareceu');

  // A moderacao e o sinal de que o arquivo subiu; o endereco dela e o que vai
  // ser gravado em product_img.
  const moderou = page.waitForRequest(r => /\/v1\/uploads\/moderate-image/.test(r.url()) && r.method() === 'POST', { timeout: 120000 });
  const aprovou = page.waitForResponse(r => /\/v1\/uploads\/moderate-image/.test(r.url()) && r.request().method() === 'POST', { timeout: 120000 });
  await campo.uploadFile(item.capa);
  const pedido = await moderou;
  const resposta = await aprovou;
  let imagem = null;
  try { imagem = JSON.parse(pedido.postData() || '{}').fileURL || null; } catch (_) { /* protocolo: corpo sem JSON, a conferencia pela API decide */ }
  const corpoModeracao = await resposta.text().catch(() => '');
  if (!resposta.ok() || !/"success"\s*:\s*true/.test(corpoModeracao)) throw new Error('KIWIFY_CAPA: moderacao recusou a imagem (' + resposta.status() + ')');

  let categoria = null;
  const atual = await page.evaluate(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === '999'));
    return s ? s.value : null;
  });
  if (categoriaPrecisaTrocar(atual, item.categoria)) {
    const ok = await page.evaluate((v) => {
      const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === '999'));
      if (!s) return false;
      s.value = String(v);
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value === String(v);
    }, item.categoria);
    if (ok) categoria = item.categoria;
    else log.warn('categoria nao entrou no formulario de ' + item.id);
  }

  // Moeda abaixo do minimo: troca a moeda e digita o preco. O campo e v-money
  // (mascara por digitos): '500' vira 5,00 em dolar.
  if (item.moeda) {
    const trocou = await page.evaluate((de, para) => {
      const s = [...document.querySelectorAll('select')].find(x => x.value === de && [...x.options].some(o => o.value === para) && x.getBoundingClientRect().width > 0);
      if (!s) return false;
      s.value = para;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value === para;
    }, item.moeda.de, item.moeda.moeda);
    if (!trocou) throw new Error('KIWIFY_MOEDA: seletor de moeda em ' + item.moeda.de + ' nao achado');
    await dormir(1500);
    const preco = await page.$('input.v-money');
    if (!preco) throw new Error('KIWIFY_MOEDA: campo de preco nao achado');
    await preco.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await preco.type(String(item.moeda.centavos), { delay: 60 });
    await dormir(800);
  }

  // Salvar: o clique so conta quando o PUT do produto volta 200.
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await dormir(1500);
    const ponto = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /salvar produto/i.test(x.textContent) && x.getBoundingClientRect().width > 0 && !x.disabled);
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const q = b.getBoundingClientRect();
      return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
    });
    if (!ponto) continue;
    const salvou = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/v1/products/' + item.id), { timeout: 20000 }).catch(() => null);
    await page.mouse.click(ponto.x, ponto.y);
    const r = await salvou;
    if (r && r.ok()) {
      let enviado = {};
      try { enviado = JSON.parse(r.request().postData() || '{}'); } catch (_) { /* protocolo: corpo sem JSON, a conferencia pela API decide */ }
      return { imagem, categoria, moeda: enviado.currency || null, preco: enviado.price == null ? null : Number(enviado.price) };
    }
    if (r && r.status() === 429) throw new Error('KIWIFY_LIMITE: 429 ao salvar');
    // Sem PUT costuma ser validacao do formulario: a mensagem diz o porque.
    const aviso = await page.evaluate(() => [...document.querySelectorAll('.text-red-600, .text-red-500, [role=alert]')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 2).join(' | '));
    if (aviso) throw new Error('KIWIFY_VALIDACAO: ' + aviso.slice(0, 160));
    log.warn('salvar nao confirmou (' + (r ? r.status() : 'sem PUT') + ') — tentativa ' + tentativa);
  }
  throw new Error('KIWIFY_CAPA: o painel nao salvou o produto');
}

module.exports = { filaDeCapas, categoriaPrecisaTrocar, aplicarNoPainel, precoAbaixoDoMinimo, PRECO_MINIMO, MOEDA_SUBSTITUTA };
