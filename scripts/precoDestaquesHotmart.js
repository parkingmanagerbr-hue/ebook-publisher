'use strict';
/**
 * precoDestaquesHotmart.js — preco da oferta principal dos livros em destaque.
 *
 * Mesmo PUT do painel (Precificacao e ofertas > Editar), capturado em
 * 16/09/2026. Do servidor so funciona com o cabecalho x-app-name: app-product;
 * a leitura leva alguns segundos para refletir a gravacao, por isso a
 * conferencia repete. Os 20 destaques foram de R$ 4,99 para R$ 9,90 (decisao do
 * dono: ticket melhor para o afiliado).
 *
 * Uso (no container): PRECO=9.9 node scripts/precoDestaquesHotmart.js [produto]
 */
process.chdir('/app');
const tok = require('fs').readFileSync('/app/data/hotmart_access_token.txt', 'utf8').trim();
const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json', 'x-app-name': process.env.APP_NAME || 'app-product', referer: 'https://app.hotmart.com/', origin: 'https://app.hotmart.com' };
const PRECO = Number(process.env.PRECO || '9.9');
const d = require('/app/src/core/database').getDb();
const alvo = process.argv[2] ? [process.argv[2]] : d.prepare("SELECT produto FROM afiliacao_hotmart WHERE destaque = 1").all().map(r => r.produto);
const dormir = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const cont = {};
  for (const pid of alvo) {
    const base = 'https://api-product.vulcano.hotmart.com/product/v1/product/' + pid + '/offer';
    try {
      const o = ((await (await fetch(base, { headers: H })).json()).data || []).find(x => x.mainOffer);
      if (!o) throw new Error('sem oferta principal');
      if (Number(o.price) === PRECO) { cont.ja = (cont.ja || 0) + 1; continue; }
      const corpo = { paymentMode: o.paymentMode || 'PAY_IN_FULL', shoppingCartOpenPermanent: null, checkoutConfiguration: { vatValueEmbedded: false },
        detail: { offerId: String(o.id), offerKey: o.key, value: { currencyCode: o.currencyCode || 'BRL', value: PRECO }, installmentCustomizationEnabled: false,
          disableConversion: !!o.disableConversion, activeInstallments: [true, false, false], lotOffer: {}, recoveryWithSmartInstallments: false,
          smartInstallmentTermsAgreed: false, maxInstallmentsRecovery: null, buyerInstallmentInterestRate: null } };
      const r = await fetch(base + '/' + o.id, { method: 'PUT', headers: H, body: JSON.stringify(corpo) });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
      // a leitura demora alguns segundos para refletir a gravacao
      let d2 = null;
      for (let t = 0; t < 5; t++) {
        await dormir(3000);
        d2 = ((await (await fetch(base, { headers: H })).json()).data || []).find(x => x.mainOffer);
        if (Number(d2.price) === PRECO) break;
      }
      if (Number(d2.price) !== PRECO) throw new Error('nao persistiu: ' + d2.price);
      cont.ok = (cont.ok || 0) + 1;
    } catch (e) { cont.erro = (cont.erro || 0) + 1; console.log('ERRO', pid, e.message); }
    await dormir(1000);
  }
  console.log(JSON.stringify({ produtos: alvo.length, ...cont }));
})();
