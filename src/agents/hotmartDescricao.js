'use strict';
/**
 * hotmartDescricao.js — descricao que a Hotmart aceita no cadastro.
 *
 * A Hotmart exige no minimo 200 caracteres. Em japones, chines e coreano a
 * descricao gerada cabe em bem menos: em 16/09/2026 um livro japones falhou
 * ("Descrição deve ter no mínimo 200 caracteres.") em TODA rodada da tarefa
 * local e ocupava metade de cada lote.
 *
 * Complemento factual no idioma do livro (formato e entrega), nunca promessa
 * de resultado.
 */
const MIN = 200;
const MAX = 500;

const COMPLEMENTO = {
  pt: ['E-book digital em PDF, com acesso imediato após a compra pela Hotmart.', 'Conteúdo organizado em capítulos, com linguagem direta e exemplos práticos para aplicar no dia a dia.', 'Tema: {t}.'],
  en: ['Digital e-book in PDF, with instant access after purchase through Hotmart.', 'Content organized into chapters, written in plain language with practical examples you can apply day to day.', 'Topic: {t}.'],
  es: ['E-book digital en PDF, con acceso inmediato después de la compra en Hotmart.', 'Contenido organizado en capítulos, con lenguaje directo y ejemplos prácticos para aplicar en el día a día.', 'Tema: {t}.'],
  fr: ['E-book numérique au format PDF, accessible immédiatement après l’achat sur Hotmart.', 'Contenu organisé en chapitres, avec un langage clair et des exemples pratiques à appliquer au quotidien.', 'Sujet : {t}.'],
  de: ['Digitales E-Book im PDF-Format, sofort nach dem Kauf über Hotmart verfügbar.', 'Der Inhalt ist in Kapitel gegliedert, klar formuliert und enthält praktische Beispiele für den Alltag.', 'Thema: {t}.'],
  it: ['E-book digitale in PDF, con accesso immediato dopo l’acquisto su Hotmart.', 'Contenuto organizzato in capitoli, con un linguaggio diretto ed esempi pratici da applicare ogni giorno.', 'Argomento: {t}.'],
  nl: ['Digitaal e-book in pdf-formaat, direct beschikbaar na aankoop via Hotmart.', 'De inhoud is ingedeeld in hoofdstukken, in heldere taal en met praktische voorbeelden voor elke dag.', 'Onderwerp: {t}.'],
  pl: ['Cyfrowy e-book w formacie PDF, dostępny natychmiast po zakupie w Hotmart.', 'Treść podzielona na rozdziały, napisana prostym językiem, z praktycznymi przykładami na co dzień.', 'Temat: {t}.'],
  ja: ['本書はPDF形式の電子書籍で、Hotmartでのご購入後すぐにお読みいただけます。', '内容は章ごとに整理されており、分かりやすい言葉と日常ですぐに使える具体例で解説しています。', 'テーマ：{t}。', '各章では要点を順番に取り上げ、読み終えたあとに自分で実践できるよう手順を丁寧にまとめています。', 'PDFなので、パソコン、タブレット、スマートフォンのどれでも読むことができます。', 'Veloxis Editorialが制作した実用ガイドシリーズの一冊です。'],
  zh: ['本书为PDF格式电子书，通过Hotmart购买后即可立即阅读。', '内容按章节编排，语言简明，并配有可在日常生活中直接应用的实用示例。', '主题：{t}。', '每一章依次讲解重点内容，并整理了清晰的步骤，方便读者读完后自行实践。', 'PDF格式可以在电脑、平板或手机上阅读。', '本书是Veloxis Editorial出版的实用指南系列之一。', '书中内容围绕实际情况展开，按步骤说明，便于读者整理思路并制定自己的行动计划。', '适合希望系统了解这一主题、并希望在生活或工作中加以运用的读者。'],
  ko: ['이 책은 PDF 형식의 전자책으로, Hotmart에서 구매한 후 바로 읽을 수 있습니다.', '내용은 장별로 정리되어 있으며, 쉬운 표현과 일상에서 바로 적용할 수 있는 실용적인 예시로 설명합니다.', '주제: {t}.', '각 장에서는 핵심 내용을 차례대로 다루고, 읽은 뒤 직접 실천할 수 있도록 단계를 정리했습니다.', 'PDF 형식이라 컴퓨터, 태블릿, 스마트폰에서 모두 읽을 수 있습니다.', '이 책은 Veloxis Editorial에서 펴낸 실용 가이드 시리즈 중 한 권입니다.'],
};

const base = l => String(l || 'pt-BR').toLowerCase().split('-')[0];
const SEM_ESPACO = new Set(['ja', 'zh']);

/** Corta em ate MAX sem partir palavra/frase quando possivel. Pura. */
function cortar(txt) {
  if (txt.length <= MAX) return txt;
  const c = txt.slice(0, MAX);
  const p = Math.max(c.lastIndexOf('. '), c.lastIndexOf('。'), c.lastIndexOf('! '), c.lastIndexOf('? '));
  if (p >= MIN) return c.slice(0, p + 1).trim();
  const e = c.lastIndexOf(' ');
  return (e >= MIN ? c.slice(0, e) : c).trim();
}

/** Descricao entre 200 e 500 caracteres, no idioma do livro. Pura. */
function descricaoHotmart(descricao, titulo, tema, idioma) {
  const b = Object.prototype.hasOwnProperty.call(COMPLEMENTO, base(idioma)) ? base(idioma) : 'en';
  const sep = SEM_ESPACO.has(b) ? '' : ' ';
  let txt = String(descricao || titulo || '').replace(/\s+/g, ' ').trim();
  const assunto = String(tema || titulo || '').replace(/\s+/g, ' ').trim();
  for (const frase of COMPLEMENTO[b]) {
    if (txt.length >= MIN) break;
    if (frase.includes('{t}') && !assunto) continue;
    txt = (txt ? txt + sep : '') + frase.replace('{t}', assunto);
  }
  // Ultimo recurso: o titulo, que e do proprio livro.
  if (txt.length < MIN && titulo && !txt.includes(titulo)) txt += sep + String(titulo).trim();
  return cortar(txt);
}

module.exports = { descricaoHotmart, MIN, MAX };
