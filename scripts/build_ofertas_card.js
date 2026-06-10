/* eslint-disable */
/**
 * build_ofertas_card.js — card 1080x1080 anunciando o hub ofertas.veloxisit.com.br
 * Roda no music-backend (tem @napi-rs/canvas). SEM emoji no card (sem fonte emoji).
 * Auto-fit de texto (regra GENIA): nada estoura a área segura; exit(2) se estourar.
 */
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');

const W = 1080, H = 1080;
const OUT = process.env.CARD_OUT || '/tmp/ofertas_card.png';
const c = createCanvas(W, H);
const x = c.getContext('2d');
const overflows = [];

function fitText(text, maxW, startPx, weight = 'bold') {
  let px = startPx;
  while (px > 18) {
    x.font = `${weight} ${px}px DejaVu Sans, sans-serif`;
    if (x.measureText(text).width <= maxW) return px;
    px -= 2;
  }
  overflows.push(`"${text.slice(0, 30)}" não coube em ${maxW}px`);
  return px;
}
function drawCentered(text, y, maxW, startPx, color, weight = 'bold') {
  const px = fitText(text, maxW, startPx, weight);
  x.fillStyle = color;
  x.textAlign = 'center';
  x.fillText(text, W / 2, y);
  return px;
}

// fundo gradiente escuro
const g = x.createLinearGradient(0, 0, W, H);
g.addColorStop(0, '#0f172a'); g.addColorStop(0.55, '#1e293b'); g.addColorStop(1, '#0f172a');
x.fillStyle = g; x.fillRect(0, 0, W, H);
// brilho radial topo
const rg = x.createRadialGradient(W / 2, 180, 40, W / 2, 180, 560);
rg.addColorStop(0, 'rgba(59,130,246,.28)'); rg.addColorStop(1, 'rgba(59,130,246,0)');
x.fillStyle = rg; x.fillRect(0, 0, W, H);

// badge NOVO
x.fillStyle = '#ff6b35';
const badgeW = 220, badgeH = 76;
x.beginPath(); x.roundRect((W - badgeW) / 2, 92, badgeW, badgeH, 38); x.fill();
drawCentered('NOVO', 145, badgeW - 40, 42, '#ffffff');

// título
drawCentered('OFERTAS', 330, W - 160, 124, '#ffffff');
drawCentered('SELECIONADAS', 450, W - 160, 96, '#3b82f6');

// subtítulo
drawCentered('116 produtos com os melhores preços', 560, W - 200, 44, '#cbd5e1', 'normal');
drawCentered('Air Fryers · Fones · Smartwatches · Echo · Kindle', 630, W - 200, 36, '#94a3b8', 'normal');

// linha divisória
x.strokeStyle = 'rgba(148,163,184,.35)'; x.lineWidth = 2;
x.beginPath(); x.moveTo(240, 700); x.lineTo(W - 240, 700); x.stroke();

// CTA box
x.fillStyle = '#3b82f6';
const ctaW = 760, ctaH = 110;
x.beginPath(); x.roundRect((W - ctaW) / 2, 770, ctaW, ctaH, 55); x.fill();
drawCentered('ofertas.veloxisit.com.br', 842, ctaW - 70, 52, '#ffffff');

// rodapé idiomas + disclosure
drawCentered('Portugues · English · Espanol', 950, W - 240, 32, '#94a3b8', 'normal');
drawCentered('Links de afiliado — sem custo extra para voce', 1010, W - 220, 26, '#64748b', 'normal');

if (overflows.length) {
  console.error('OFERTAS CARD QUALITY FAIL:', overflows.join(' | '));
  process.exit(2);
}
fs.writeFileSync(OUT, c.toBuffer('image/png'));
console.log('card OK ->', OUT);
