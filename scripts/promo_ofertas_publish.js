/* eslint-disable */
/**
 * promo_ofertas_publish.js — anuncia o hub ofertas.veloxisit.com.br
 * na página FB (foto binária) + IG feed (URL pública) da veloxisit.
 * Roda dentro do platform-system-backend-1.
 */
const fs = require('fs');
const fb = require('/app/src/publishers/facebook');
const ig = require('/app/src/publishers/instagram');

const IMG = '/app/data/sites/veloxisit/reels/ofertas_card.png';
const PUBLIC_URL = 'https://veloxisit.com.br/og/ofertas_card.png';
const CAPTION =
  '🛒 NOVO: Hub de Ofertas Veloxisit!\n\n' +
  'Selecionamos 116 produtos com os melhores preços da Amazon — air fryers, ' +
  'fones bluetooth, smartwatches, Echo, Kindle e muito mais. Tudo num lugar só, ' +
  'em português, inglês e espanhol. 🔥\n\n' +
  '👉 Confira: https://ofertas.veloxisit.com.br\n\n' +
  '#ofertas #promocao #achadinhos #amazon #tecnologia';

(async () => {
  if (!fs.existsSync(IMG)) { console.error('[promo] imagem ausente:', IMG); process.exit(1); }

  try {
    const r = await fb.publishFacebookPhoto({ imagePath: IMG, caption: CAPTION, siteId: 'veloxisit' });
    console.log('[FB]', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.log('[FB] ERRO:', String(e.response ? JSON.stringify(e.response.data) : e.message).slice(0, 200));
  }

  try {
    const r = await ig.publishInstagramFeedImage({ publicImageUrl: PUBLIC_URL, caption: CAPTION, siteId: 'veloxisit' });
    console.log('[IG]', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.log('[IG] ERRO:', String(e.response ? JSON.stringify(e.response.data) : e.message).slice(0, 200));
  }
})();
