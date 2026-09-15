'use strict';
/**
 * pdfIdioma.js — textos fixos e fontes do PDF no idioma do livro.
 *
 * Medido em 15/09/2026 em PDFs reais do catalogo:
 * - JAPONES ILEGIVEL: o PDF usava Helvetica, que nao tem kanji nem kana. O texto
 *   extraido de um livro japones tinha 0 caracteres japoneses em 36 mil — saia
 *   "0μ0¤0Ð0ü•Z0n". Os dois compradores japoneses do dia receberam isso. Vale
 *   para chines e coreano, e o polones perdia ą ę ł ś ż (fora da WinAnsi).
 * - PORTUGUES NO LIVRO ESTRANGEIRO: "Sumario", "Introducao", "Publicado em" e o
 *   aviso de direitos saiam em portugues em livros alemaes e espanhois.
 */
const fs = require('fs');

const NOTO = '/usr/share/fonts/truetype/noto/';
const NOTO_CJK = '/usr/share/fonts/opentype/noto/';

// Nome PostScript dentro do .ttc: cada colecao CJK traz as variantes JP/SC/TC/KR.
const CJK_PS = { ja: 'JP', zh: 'SC', ko: 'KR' };

const base = l => String(l || 'pt-BR').toLowerCase().split('-')[0];

const TEXTOS = {
  pt: { sumario: 'Sumário', introducao: 'Introdução', conclusao: 'Conclusão', publicado: 'Publicado em', direitos: '© Todos os direitos reservados. Proibida a reprodução parcial ou total sem autorização.', rodape: '© Veloxis Editorial — Todos os direitos reservados', ctaTitulo: 'Gostou deste e-book?', ctaTexto: 'Compartilhe com amigos que precisam desta informação. Sua indicação faz diferença!', ctaSite: 'Encontre mais e-books em: veloxisit.com.br', dica: 'Dica Prática|Atenção|Nota:|Importante:' },
  en: { sumario: 'Contents', introducao: 'Introduction', conclusao: 'Conclusion', publicado: 'Published', direitos: '© All rights reserved. No part of this book may be reproduced without permission.', rodape: '© Veloxis Editorial — All rights reserved', ctaTitulo: 'Enjoyed this e-book?', ctaTexto: 'Share it with friends who need this information. Your recommendation makes a difference!', ctaSite: 'Find more e-books at: veloxisit.com.br', dica: 'Tip|Practical Tip|Warning|Note:|Important:' },
  es: { sumario: 'Índice', introducao: 'Introducción', conclusao: 'Conclusión', publicado: 'Publicado en', direitos: '© Todos los derechos reservados. Prohibida la reproducción total o parcial sin autorización.', rodape: '© Veloxis Editorial — Todos los derechos reservados', ctaTitulo: '¿Te gustó este e-book?', ctaTexto: 'Compártelo con amigos que necesitan esta información. ¡Tu recomendación marca la diferencia!', ctaSite: 'Encuentra más e-books en: veloxisit.com.br', dica: 'Consejo|Consejo práctico|Atención|Nota:|Importante:' },
  fr: { sumario: 'Sommaire', introducao: 'Introduction', conclusao: 'Conclusion', publicado: 'Publié en', direitos: '© Tous droits réservés. Toute reproduction, même partielle, est interdite sans autorisation.', rodape: '© Veloxis Editorial — Tous droits réservés', ctaTitulo: 'Vous avez aimé cet e-book ?', ctaTexto: 'Partagez-le avec des amis qui ont besoin de ces informations. Votre recommandation compte !', ctaSite: 'Plus d’e-books sur : veloxisit.com.br', dica: 'Conseil|Conseil pratique|Attention|Remarque :|Important :' },
  de: { sumario: 'Inhalt', introducao: 'Einleitung', conclusao: 'Fazit', publicado: 'Veröffentlicht', direitos: '© Alle Rechte vorbehalten. Vervielfältigung, auch auszugsweise, nur mit Genehmigung.', rodape: '© Veloxis Editorial — Alle Rechte vorbehalten', ctaTitulo: 'Hat Ihnen dieses E-Book gefallen?', ctaTexto: 'Teilen Sie es mit Freunden, die diese Informationen brauchen. Ihre Empfehlung zählt!', ctaSite: 'Weitere E-Books unter: veloxisit.com.br', dica: 'Tipp|Praxistipp|Achtung|Hinweis:|Wichtig:' },
  it: { sumario: 'Indice', introducao: 'Introduzione', conclusao: 'Conclusione', publicado: 'Pubblicato a', direitos: '© Tutti i diritti riservati. Vietata la riproduzione, anche parziale, senza autorizzazione.', rodape: '© Veloxis Editorial — Tutti i diritti riservati', ctaTitulo: 'Ti è piaciuto questo e-book?', ctaTexto: 'Condividilo con gli amici che hanno bisogno di queste informazioni. Il tuo consiglio conta!', ctaSite: 'Trova altri e-book su: veloxisit.com.br', dica: 'Consiglio|Consiglio pratico|Attenzione|Nota:|Importante:' },
  nl: { sumario: 'Inhoud', introducao: 'Inleiding', conclusao: 'Conclusie', publicado: 'Gepubliceerd', direitos: '© Alle rechten voorbehouden. Niets uit deze uitgave mag zonder toestemming worden verveelvoudigd.', rodape: '© Veloxis Editorial — Alle rechten voorbehouden', ctaTitulo: 'Vond je dit e-book goed?', ctaTexto: 'Deel het met vrienden die deze informatie nodig hebben. Jouw aanbeveling maakt het verschil!', ctaSite: 'Meer e-books op: veloxisit.com.br', dica: 'Tip|Praktische tip|Let op|Opmerking:|Belangrijk:' },
  pl: { sumario: 'Spis treści', introducao: 'Wstęp', conclusao: 'Podsumowanie', publicado: 'Wydano', direitos: '© Wszelkie prawa zastrzeżone. Kopiowanie w całości lub w części bez zgody jest zabronione.', rodape: '© Veloxis Editorial — Wszelkie prawa zastrzeżone', ctaTitulo: 'Podobał Ci się ten e-book?', ctaTexto: 'Podziel się nim ze znajomymi, którzy potrzebują tych informacji. Twoja rekomendacja ma znaczenie!', ctaSite: 'Więcej e-booków: veloxisit.com.br', dica: 'Wskazówka|Praktyczna wskazówka|Uwaga|Uwaga:|Ważne:' },
  ja: { sumario: '目次', introducao: 'はじめに', conclusao: 'おわりに', publicado: '発行', direitos: '© 無断転載・複製を禁じます。', rodape: '© Veloxis Editorial — 無断転載を禁じます', ctaTitulo: 'この電子書籍はお役に立ちましたか？', ctaTexto: 'この情報を必要としているご友人にぜひ共有してください。', ctaSite: 'その他の電子書籍：veloxisit.com.br', dica: 'ポイント|実践のヒント|注意|メモ：|重要：' },
  zh: { sumario: '目录', introducao: '引言', conclusao: '结语', publicado: '出版于', direitos: '© 版权所有，未经许可不得复制或转载。', rodape: '© Veloxis Editorial — 版权所有', ctaTitulo: '喜欢这本电子书吗？', ctaTexto: '把它分享给需要这些信息的朋友吧，您的推荐很重要！', ctaSite: '更多电子书：veloxisit.com.br', dica: '提示|实用提示|注意|备注：|重要：' },
  ko: { sumario: '목차', introducao: '들어가며', conclusao: '마치며', publicado: '발행', direitos: '© 무단 전재 및 복제를 금합니다.', rodape: '© Veloxis Editorial — 무단 전재 금지', ctaTitulo: '이 전자책이 도움이 되셨나요?', ctaTexto: '이 정보가 필요한 친구들에게 공유해 주세요.', ctaSite: '더 많은 전자책: veloxisit.com.br', dica: '팁|실용 팁|주의|참고:|중요:' },
};

/** Textos fixos no idioma; idioma desconhecido cai em ingles (nao em portugues). */
function textos(idioma) {
  const b = base(idioma);
  return TEXTOS[b] || (b === 'pt' ? TEXTOS.pt : TEXTOS.en);
}

/** "setembro de 2026" / "September 2026" / "2026年9月" no idioma do livro. */
function mesAno(idioma, data = new Date()) {
  const loc = idioma && idioma.includes('-') ? idioma : ({ pt: 'pt-BR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' }[base(idioma)] || base(idioma));
  try { return data.toLocaleDateString(loc, { month: 'long', year: 'numeric' }); }
  catch { return data.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
}

/**
 * Fontes para o idioma: {regular, bold, italic, registrar:[[nome, arquivo, familia?]]}.
 * Sem os arquivos Noto (maquina de desenvolvimento), volta para Helvetica —
 * mas CJK sem fonte e erro: gerar PDF ilegivel e pior que nao gerar.
 */
function fontes(idioma, existe = fs.existsSync) {
  const b = base(idioma);
  if (CJK_PS[b]) {
    const reg = NOTO_CJK + 'NotoSansCJK-Regular.ttc', neg = NOTO_CJK + 'NotoSansCJK-Bold.ttc';
    if (!existe(reg) || !existe(neg)) throw new Error('fonte CJK ausente (' + reg + ') — PDF em ' + b + ' sairia ilegivel');
    const s = CJK_PS[b];
    return { regular: 'Corpo', bold: 'Negrito', italic: 'Corpo',
      registrar: [['Corpo', reg, 'NotoSansCJK' + s.toLowerCase() + '-Regular'], ['Negrito', neg, 'NotoSansCJK' + s.toLowerCase() + '-Bold']] };
  }
  const r = NOTO + 'NotoSans-Regular.ttf', n = NOTO + 'NotoSans-Bold.ttf', i = NOTO + 'NotoSans-Italic.ttf';
  if (existe(r) && existe(n) && existe(i)) {
    return { regular: 'Corpo', bold: 'Negrito', italic: 'Italico', registrar: [['Corpo', r], ['Negrito', n], ['Italico', i]] };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', registrar: [] };
}

module.exports = { textos, mesAno, fontes, TEXTOS, base };
