'use strict';
/**
 * entregaCakto.js — preenche o link de entrega dos produtos Cakto.
 *
 * Os produtos foram criados com entrega "link externo" e o campo
 * emailAccessLink vazio: quem comprasse nao recebia nada (15/09/2026). Para cada
 * livro com checkout Cakto E PDF em disco, grava no produto o link assinado de
 * /entrega/:token (src/core/entrega.js).
 *
 * Livro sem PDF nao recebe link — nao ha o que entregar; ver --sem-pdf.
 *
 * Ritmo: uma chamada a cada 3 s. Rajada na API da Cakto aciona o desafio do
 * Cloudflare e derruba a sessao salva (aconteceu na auditoria).
 *
 * Uso (dentro do container):
 *   node scripts/entregaCakto.js --limite=1            # testa em 1 produto
 *   node scripts/entregaCakto.js --limite=5000
 *   node scripts/entregaCakto.js --sem-pdf             # so conta/lista quem nao tem PDF
 */
const fs = require('fs');
const { urlEntrega } = require('../src/core/entrega');

const PAUSA_MS = parseInt(process.env.CAKTO_PAUSA_MS || '3000', 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const arg = (n, p) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : p; };

/**
 * Cabecalhos de escrita. A sessao salva nao tem cookie de CSRF e a escrita dava
 * 403 "CSRF cookie not set". O painel pede o token em /get-csrf-token/ (visto no
 * bundle) — que devolve o valor e grava o cookie; aqui se faz o mesmo.
 */
async function cabecalhos() {
  const s = JSON.parse(fs.readFileSync(process.env.CAKTO_SESSION_FILE || '/app/data/sessions/cakto.json', 'utf8'));
  const base = {
    accept: 'application/json', 'content-type': 'application/json', referer: 'https://app.cakto.com.br/',
    origin: 'https://app.cakto.com.br',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  let cookies = s.cookies.map(c => c.name + '=' + c.value);
  const r = await fetch('https://api.cakto.com.br/api/get-csrf-token/', { headers: { ...base, cookie: cookies.join('; ') } });
  const novos = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]);
  const nomesNovos = new Set(novos.map(c => c.split('=')[0]));
  cookies = cookies.filter(c => !nomesNovos.has(c.split('=')[0])).concat(novos);
  let token = null;
  try { token = (await r.json()).csrfToken; } catch { /* sem corpo */ }
  if (!token) throw new Error('get-csrf-token nao devolveu token (HTTP ' + r.status + ')');
  return { ...base, cookie: cookies.join('; '), 'x-csrftoken': token };
}

async function api(metodo, rota, corpo, H) {
  const r = await fetch('https://api.cakto.com.br/api/' + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined });
  const t = await r.text();
  if (t.startsWith('<')) {
    const e = new Error('Cakto devolveu HTML (HTTP ' + r.status + ') — Cloudflare ou sessao expirada');
    e.cloudflare = true; throw e;
  }
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { const e = new Error(metodo + ' ' + rota + ': HTTP ' + r.status + ' ' + String(t).slice(0, 200)); e.status = r.status; throw e; }
  return j;
}

// Nome do vendedor no checkout. Vazio, a Cakto mostrava o E-MAIL da conta
// ("Termos de uso de ...@hotmail.com") — comprador desconfia. E o nome que ja
// esta impresso nas capas.
const PRODUTOR = process.env.CAKTO_PRODUCER_NAME || 'Veloxis Editorial';

// Afiliacao (decisao do dono em 16/09/2026): sem trafego proprio, o catalogo
// Cakto nunca teve um pedido. Afiliado so encontra o produto se ele estiver na
// vitrine com comissao. Comissao ja definida por alguem nao e trocada.
const COMISSAO_AFILIADO = 50;
const DESCRICAO_AFILIADO = 'E-book digital com entrega imediata por link. Comissão de ' + COMISSAO_AFILIADO +
  '% em cada venda aprovada, afiliação automática. Divulgue de forma honesta, sem prometer resultado.';

/** O que o produto deve ter depois da correcao. Pura. */
function alvo(produto, linkEsperado, pausadoPorNos = false, opcoes = {}) {
  const atual = produto.emailAccessLink || '';
  const out = {};
  // Link de terceiro nunca e sobrescrito: alguem configurou a entrega a mao.
  if (atual !== linkEsperado && (!atual || atual.includes('/entrega/'))) out.emailAccessLink = linkEsperado;
  if (!produto.producerName) out.producerName = PRODUTOR;
  // Pausado por este job por falta de PDF e o PDF voltou: volta a vender.
  // Pausado por outra pessoa (sem registro nosso) continua como esta.
  if (pausadoPorNos && produto.status === 'waiting_config') out.status = 'active';
  if (opcoes.afiliacao && !produto.affiliate) {
    Object.assign(out, { affiliate: true, affiliateRequest: false, affiliateMarketplace: true });
    if (produto.affiliateCommission == null) out.affiliateCommission = COMISSAO_AFILIADO;
    if (!produto.affiliateDescription) out.affiliateDescription = DESCRICAO_AFILIADO;
  }
  // "Pagina de vendas" apontava para https://hotmart.com em todos os produtos:
  // o afiliado mandaria o comprador para outra plataforma. Sem pagina propria,
  // o proprio checkout e o destino certo.
  if (opcoes.checkout && (!produto.salesPage || /^https?:\/\/(www\.)?hotmart\.com\/?$/i.test(produto.salesPage))) out.salesPage = opcoes.checkout;
  return out;
}

/** Decide o que fazer com um produto. Pura. */
function planejar(produto, linkEsperado, pausadoPorNos = false, opcoes = {}) {
  if (Object.keys(alvo(produto, linkEsperado, pausadoPorNos, opcoes)).length) return 'gravar';
  const atual = produto.emailAccessLink || '';
  return atual && atual !== linkEsperado ? 'link-alheio' : 'ok';
}

async function main() {
  const { getDb } = require('../src/core/database');
  const db = getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS cakto_entrega (ebook_id TEXT PRIMARY KEY, produto TEXT, resultado TEXT, quando INTEGER)').run();

  const livros = db.prepare("SELECT id, title, pdf_path, cover_path, cakto_product_id FROM ebooks WHERE cakto_product_id IS NOT NULL AND cakto_product_id <> '' ORDER BY rowid DESC").all();
  const comPdf = livros.filter(e => e.pdf_path && fs.existsSync(e.pdf_path));
  if (process.argv.includes('--sem-pdf')) {
    console.log(JSON.stringify({ comCheckout: livros.length, comPdf: comPdf.length, semPdf: livros.length - comPdf.length }));
    return;
  }

  const limite = parseInt(arg('limite', '1'), 10);
  const feitos = new Set(db.prepare("SELECT ebook_id FROM cakto_entrega WHERE resultado IN ('gravado-v4','ok-v4')").all().map(r => r.ebook_id));
  const fila = comPdf.filter(e => !feitos.has(e.id)).slice(0, limite);
  const pausados = new Set(db.prepare("SELECT ebook_id FROM cakto_entrega WHERE resultado = 'pausado-sem-pdf'").all().map(r => r.ebook_id));
  const vistosSemPdf = new Set(db.prepare("SELECT ebook_id FROM cakto_entrega WHERE resultado IN ('pausado-sem-pdf','sem-pdf-nao-ativo')").all().map(r => r.ebook_id));
  const semPdf = livros.filter(e => !(e.pdf_path && fs.existsSync(e.pdf_path)) && !vistosSemPdf.has(e.id));
  const filaPausa = semPdf.slice(0, Math.max(0, limite - fila.length));
  const H = await cabecalhos();
  const marca = db.prepare('INSERT OR REPLACE INTO cakto_entrega (ebook_id, produto, resultado, quando) VALUES (?,?,?,?)');
  const cont = {};

  // Oferta (shortcode do checkout) -> produto. O detalhe da oferta traz o produto.
  for (const e of fila) {
    try {
      const oferta = await api('GET', 'offers/' + e.cakto_product_id + '/', null, H); await dormir(PAUSA_MS);
      const produtoId = oferta.product;
      const produto = await api('GET', 'product/' + produtoId + '/', null, H); await dormir(PAUSA_MS);
      const link = urlEntrega(e.id);
      const opcoes = { afiliacao: true, checkout: 'https://pay.cakto.com.br/' + e.cakto_product_id };
      const mudar = alvo(produto, link, pausados.has(e.id), opcoes);
      const decisao = planejar(produto, link, pausados.has(e.id), opcoes);
      if (decisao === 'gravar') {
        // A rota nao aceita PATCH (405): PUT com o produto inteiro que acabou de
        // ser lido, trocando so o link. A conferencia abaixo pega o caso de a
        // API ignorar o campo ou mexer em outro.
        // Sem `image`: a imagem tem rota propria (multipart), e reenviar a URL ou o
        // null lido poderia apagar a capa ja enviada.
        const { image: _imagem, ...corpo } = produto;
        await api('PUT', 'product/' + produtoId + '/', { ...corpo, ...mudar }, H); await dormir(PAUSA_MS);
        const conferido = await api('GET', 'product/' + produtoId + '/', null, H); await dormir(PAUSA_MS);
        const mexeuEmOutro = camposAlterados(produto, conferido).filter(k => !['updatedAt', ...Object.keys(mudar)].includes(k));
        if (mexeuEmOutro.length) console.log('ATENCAO', produtoId, 'campos mudaram alem do link:', mexeuEmOutro.join(','));
        const persistiu = Object.entries(mudar).every(([k, v]) => mesmoValor(conferido[k], v));
        const res = !persistiu ? 'nao-persistiu' : (mexeuEmOutro.length ? 'gravado-com-efeito' : 'gravado-v4');
        marca.run(e.id, produtoId, res, Date.now()); cont[res] = (cont[res] || 0) + 1;
      } else {
        marca.run(e.id, produtoId, decisao === 'ok' ? 'ok-v4' : decisao, Date.now()); cont[decisao] = (cont[decisao] || 0) + 1;
      }
      // Capa DEPOIS do PUT de dados: o PUT reenvia o produto lido, com image null,
      // e apagaria uma imagem enviada antes dele.
      if (precisaImagem(produto, !!(e.cover_path && fs.existsSync(e.cover_path)))) {
        const jpg = await capaParaCheckout(e.cover_path);
        try {
          await enviarImagem(produtoId, jpg, H); await dormir(PAUSA_MS);
          const comImagem = await api('GET', 'product/' + produtoId + '/', null, H); await dormir(PAUSA_MS);
          const r = comImagem.image ? 'imagem' : 'imagem-nao-persistiu';
          cont[r] = (cont[r] || 0) + 1;
          if (!comImagem.image) marca.run(e.id, produtoId, r, Date.now());
        } finally { try { fs.unlinkSync(jpg); } catch {} }
      }
    } catch (err) {
      cont.erro = (cont.erro || 0) + 1;
      marca.run(e.id, null, 'erro: ' + String(err.message).slice(0, 120), Date.now());
      console.log('ERRO', e.cakto_product_id, err.message.slice(0, 160));
      if (err.cloudflare) { console.log('parando: Cloudflare/sessao'); break; }
      await dormir(PAUSA_MS * 3);
    }
  }
  // Livro sem PDF: tirar de venda. Checkout ativo sem arquivo cobra e nao entrega.
  for (const e of filaPausa) {
    try {
      const oferta = await api('GET', 'offers/' + e.cakto_product_id + '/', null, H); await dormir(PAUSA_MS);
      const produto = await api('GET', 'product/' + oferta.product + '/', null, H); await dormir(PAUSA_MS);
      const acao = acaoSemPdf(produto);
      if (acao === 'pausar') {
        const { image: _i, ...corpo } = produto;
        await api('PUT', 'product/' + oferta.product + '/', { ...corpo, status: 'waiting_config' }, H); await dormir(PAUSA_MS);
        const conferido = await api('GET', 'product/' + oferta.product + '/', null, H); await dormir(PAUSA_MS);
        const res = conferido.status === 'waiting_config' ? 'pausado-sem-pdf' : 'pausa-nao-persistiu';
        marca.run(e.id, oferta.product, res, Date.now()); cont[res] = (cont[res] || 0) + 1;
      } else {
        marca.run(e.id, oferta.product, 'sem-pdf-nao-ativo', Date.now()); cont['sem-pdf-nao-ativo'] = (cont['sem-pdf-nao-ativo'] || 0) + 1;
      }
    } catch (err) {
      cont.erro = (cont.erro || 0) + 1;
      console.log('ERRO pausa', e.cakto_product_id, err.message.slice(0, 160));
      if (err.cloudflare) break;
      await dormir(PAUSA_MS * 3);
    }
  }
  console.log(JSON.stringify({ fila: fila.length, filaPausa: filaPausa.length, ...cont }));
}

/** Livro sem PDF: so pausa o que esta ATIVO (vendendo). Pura. */
function acaoSemPdf(produto) {
  return produto.status === 'active' ? 'pausar' : 'nada';
}

/** Produto sem imagem e com capa em disco. Pura. */
function precisaImagem(produto, capaExiste) {
  return !produto.image && capaExiste;
}

/**
 * Capa de 1600x2560 em PNG (~3,4 MB) e pesada para o checkout, que a mostra
 * pequena. 600 px de largura em JPEG fica perto de 60 KB.
 */
function capaParaCheckout(caminho) {
  const saida = '/tmp/capa_cakto_' + process.pid + '_' + Date.now() + '.jpg';
  require('child_process').execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', caminho, '-vf', 'scale=600:-2', '-q:v', '3', saida]);
  return saida;
}

/** Rota achada no bundle do painel: PUT /product/{id}/image/ multipart, campo image. */
async function enviarImagem(produtoId, arquivo, H) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(arquivo)], { type: 'image/jpeg' }), 'capa.jpg');
  const { 'content-type': _ignorado, ...semTipo } = H; // o fetch poe o boundary
  const r = await fetch('https://api.cakto.com.br/api/product/' + produtoId + '/image/', { method: 'PUT', headers: semTipo, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error('imagem: HTTP ' + r.status + ' ' + t.slice(0, 160));
}

/** A API devolve numero como texto ("50.00"): compara pelo valor. Pura. */
function mesmoValor(lido, gravado) {
  if (lido === gravado) return true;
  if (typeof gravado === 'number') return Number(lido) === gravado;
  return false;
}

/** Campos de primeiro nivel cujo valor mudou entre duas leituras. Pura. */
function camposAlterados(antes, depois) {
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  return [...chaves].filter(k => JSON.stringify((antes || {})[k]) !== JSON.stringify((depois || {})[k]));
}

module.exports = { planejar, alvo, acaoSemPdf, mesmoValor, COMISSAO_AFILIADO, camposAlterados, precisaImagem, PRODUTOR };

if (require.main === module) main().catch(e => { console.error('ERRO', e.message); process.exit(1); });
