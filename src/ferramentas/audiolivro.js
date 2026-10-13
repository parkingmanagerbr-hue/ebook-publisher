'use strict';
/**
 * audiolivro.js — o produto "e-book + audiolivro".
 *
 * Pedido do dono (13/10/2026): os 500 MP3 gerados para livros ja publicados
 * viram produto a venda. Mesmo desenho do combo (ver combo.js): uma linha NOVA
 * em `ebooks`, preco proprio, e o PDF do livro com uma pagina de acesso logo
 * depois da folha de rosto — nela, o link ASSINADO do audio (entrega.urlAudio).
 *
 * Regra do dono para o texto ao leitor: nunca mencionar como o audio foi
 * produzido. O texto diz o que o comprador recebe (a versao em audio do livro
 * completo, quantos minutos, MP3) e nada promete.
 *
 * Tudo puro.
 */
const { tituloComSufixo, paraWinAnsi } = require('./combo');

const PRECO_AUDIOLIVRO = 9.9;

// Abaixo disso o MP3 esta incompleto: medido em 13/10/2026, a mediana e de 50
// minutos e os dois arquivos com menos de 15 tinham 5 e 12 — pedaco do livro,
// nao o livro. Vender "o livro completo em audio" com isso e propaganda falsa.
const DURACAO_MINIMA_S = 15 * 60;

/**
 * Textos por idioma do livro: o comprador de um livro em frances recebe a
 * pagina em frances. Japones, chines e polones ficam de fora de proposito: a
 * pagina de acesso usa a fonte padrao do PDF (WinAnsi), que nao tem esses
 * caracteres — o texto sairia com letras faltando.
 */
const TEXTOS = {
  pt: {
    sufixo: ' + Audiolivro',
    descricao: m => 'Inclui a versão em áudio narrada do livro completo, com cerca de ' + m +
      ' minutos, em MP3 para ouvir no celular ou no computador. O link para baixar o áudio está na segunda página do PDF.',
    cabecalho: 'Seu Audiolivro',
    linhas: m => [
      'Este livro vem com a versão em áudio narrada do livro completo,',
      'com cerca de ' + m + ' minutos, em MP3 para ouvir no celular ou no computador.',
      '',
      'Para baixar o áudio, abra o endereço abaixo:',
    ],
    rodape: t => 'O endereço é exclusivo de quem comprou "' + t + '". Guarde este arquivo.',
  },
  en: {
    sufixo: ' + Audiobook',
    descricao: m => 'Includes the narrated audio version of the complete book, about ' + m +
      ' minutes long, as an MP3 to listen to on your phone or computer. The download link is on the second page of the PDF.',
    cabecalho: 'Your Audiobook',
    linhas: m => [
      'This book comes with the narrated audio version of the complete book,',
      'about ' + m + ' minutes long, as an MP3 for your phone or computer.',
      '',
      'To download the audio, open the address below:',
    ],
    rodape: t => 'This address is exclusive to buyers of "' + t + '". Keep this file.',
  },
  es: {
    sufixo: ' + Audiolibro',
    descricao: m => 'Incluye la versión en audio narrada del libro completo, de unos ' + m +
      ' minutos, en MP3 para escuchar en el móvil o en el ordenador. El enlace de descarga está en la segunda página del PDF.',
    cabecalho: 'Tu Audiolibro',
    linhas: m => [
      'Este libro incluye la versión en audio narrada del libro completo,',
      'de unos ' + m + ' minutos, en MP3 para escuchar en el móvil o el ordenador.',
      '',
      'Para descargar el audio, abre la dirección de abajo:',
    ],
    rodape: t => 'La dirección es exclusiva de quien compró "' + t + '". Guarda este archivo.',
  },
  fr: {
    sufixo: ' + Livre audio',
    descricao: m => "Comprend la version audio lue du livre complet, d'environ " + m +
      " minutes, en MP3 à écouter sur votre téléphone ou votre ordinateur. Le lien de téléchargement se trouve à la deuxième page du PDF.",
    cabecalho: 'Votre livre audio',
    linhas: m => [
      'Ce livre est accompagné de la version audio lue du livre complet,',
      "d'environ " + m + ' minutes, en MP3 pour votre téléphone ou ordinateur.',
      '',
      "Pour télécharger l'audio, ouvrez l'adresse ci-dessous :",
    ],
    rodape: t => 'Cette adresse est réservée aux acheteurs de "' + t + '". Conservez ce fichier.',
  },
  de: {
    sufixo: ' + Hörbuch',
    descricao: m => 'Enthält die gesprochene Audioversion des vollständigen Buches, etwa ' + m +
      ' Minuten, als MP3 zum Anhören auf dem Handy oder Computer. Der Download-Link steht auf der zweiten Seite der PDF.',
    cabecalho: 'Ihr Hörbuch',
    linhas: m => [
      'Zu diesem Buch gehört die gesprochene Audioversion des ganzen Buches,',
      'etwa ' + m + ' Minuten, als MP3 für Handy oder Computer.',
      '',
      'Zum Herunterladen öffnen Sie die folgende Adresse:',
    ],
    rodape: t => 'Diese Adresse gilt nur für Käufer von "' + t + '". Bewahren Sie diese Datei auf.',
  },
  it: {
    sufixo: ' + Audiolibro',
    descricao: m => "Include la versione audio letta del libro completo, di circa " + m +
      " minuti, in MP3 da ascoltare sul telefono o sul computer. Il link per scaricarla è nella seconda pagina del PDF.",
    cabecalho: 'Il tuo audiolibro',
    linhas: m => [
      'Questo libro include la versione audio letta del libro completo,',
      'di circa ' + m + ' minuti, in MP3 per telefono o computer.',
      '',
      "Per scaricare l'audio, apri l'indirizzo qui sotto:",
    ],
    rodape: t => 'L\'indirizzo è riservato a chi ha acquistato "' + t + '". Conserva questo file.',
  },
  nl: {
    sufixo: ' + Luisterboek',
    descricao: m => 'Inclusief de voorgelezen audioversie van het volledige boek, ongeveer ' + m +
      ' minuten, als MP3 om te luisteren op je telefoon of computer. De downloadlink staat op de tweede pagina van de PDF.',
    cabecalho: 'Je luisterboek',
    linhas: m => [
      'Bij dit boek hoort de voorgelezen audioversie van het volledige boek,',
      'ongeveer ' + m + ' minuten, als MP3 voor telefoon of computer.',
      '',
      'Open het adres hieronder om de audio te downloaden:',
    ],
    rodape: t => 'Dit adres is alleen voor kopers van "' + t + '". Bewaar dit bestand.',
  },
};

/** Idioma do livro em duas letras; null quando a pagina nao pode ser escrita nele. Pura. */
function idiomaDoAudiolivro(language) {
  const k = String(language == null ? '' : language).slice(0, 2).toLowerCase() || 'pt';
  return TEXTOS[k] ? k : null;
}

/** Minutos inteiros para o texto ("cerca de 48 minutos"). Pura. */
function minutos(duracaoS) {
  return Math.max(1, Math.round(Number(duracaoS) / 60) || 1);
}

/**
 * O MP3 serve para virar produto? Devolve null quando serve, ou o motivo.
 * Pura: quem le disco e banco e o script, aqui so a decisao.
 */
function motivoParaNaoCriar({ original, duracaoS, temPdf, jaExiste }) {
  if (!original) return 'sem-livro';
  if (original.combo_de) return 'original-e-combo';
  if (original.audio_de) return 'original-e-audiolivro';
  if (jaExiste) return 'ja-existe';
  if (!temPdf) return 'sem-pdf';
  if (!idiomaDoAudiolivro(original.language)) return 'idioma-sem-fonte';
  if (!(Number(duracaoS) >= DURACAO_MINIMA_S)) return 'audio-curto';
  return null;
}

function textos(language) {
  return TEXTOS[idiomaDoAudiolivro(language) || 'pt'];
}

/**
 * Nome na loja: titulo + sufixo no idioma do livro, sufixo nunca cortado.
 * Teto de 100, nao 120: a Kiwify guarda o nome cortado em 100
 * (kiwifyRegras.nomeKiwify) e procura "ja existe?" pelo nome cortado. Com 120,
 * o corte comeria o sufixo, o nome viraria o do livro avulso e o audiolivro
 * seria ligado ao produto do livro de R$ 4,99 que ja esta la. Pura.
 */
function tituloDoAudiolivro(titulo, language, max = 100) {
  return tituloComSufixo(titulo, textos(language).sufixo, max);
}

/** Descricao: a do livro + o que o audio e. Sem promessa de resultado. Pura. */
function descricaoDoAudiolivro(descricao, duracaoS, language) {
  const base = String(descricao == null ? '' : descricao).replace(/\s+/g, ' ').trim();
  const extra = textos(language).descricao(minutos(duracaoS));
  return base ? base + '\n\n' + extra : extra;
}

/** Conteudo da pagina de acesso (a diagramacao e a do combo). Pura. */
function textoDaPaginaDoAudio(titulo, url, duracaoS, language) {
  const t = textos(language);
  return {
    cabecalho: t.cabecalho,
    linhas: t.linhas(minutos(duracaoS)),
    link: String(url || ''),
    rodape: t.rodape(paraWinAnsi(titulo).slice(0, 70)),
  };
}

module.exports = {
  PRECO_AUDIOLIVRO, DURACAO_MINIMA_S, idiomaDoAudiolivro, minutos, motivoParaNaoCriar,
  tituloDoAudiolivro, descricaoDoAudiolivro, textoDaPaginaDoAudio,
};
