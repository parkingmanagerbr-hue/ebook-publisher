'use strict';
/**
 * destravar_ia.js — libera provider marcado como degradado que JA VOLTOU.
 *
 * Este script existe porque eu destravei isso na mao TRES vezes em uma semana:
 * o pipeline anunciava "todos os providers falharam" enquanto uma chamada
 * direta a API respondia HTTP 200. O circuito meio-aberto do aiClient deveria
 * cobrir isso, mas o prazo de castigo e sempre um chute (a janela real de reset
 * nao vem na resposta) e a sondagem pode demorar a coincidir com a volta.
 *
 * A regra aqui e a mesma que uso a mao: NAO acreditar no estado, PERGUNTAR A
 * API. Se o provider responde de verdade, a punicao cai.
 *
 * Detalhe que importa: a cota do Groq e POR MODELO. Medido em 02/09/2026 —
 * gpt-oss-120b devolvia 429 enquanto gpt-oss-20b respondia 200 com a MESMA
 * chave e o MESMO tamanho de requisicao (4096 tokens). Por isso a sondagem
 * varre a lista de modelos: basta UM responder para o provider estar vivo.
 */
const fs = require('fs');
const path = require('path');

const STATE = process.env.AI_STATE_FILE || '/app/data/ai_state.json';

const PROVEDORES = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelos: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini'],
    env: 'GROQ_API_KEY',
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    modelos: ['gpt-oss-120b', 'zai-glm-4.7'],
    env: 'CEREBRAS_API_KEY',
    // Cloudflare do Cerebras devolve 403 code 1010 sem User-Agent de browser.
    // Sem isto a sondagem le "fora do ar" numa conta perfeitamente viva.
    ua: true,
  },
  sambanova: {
    url: 'https://api.sambanova.ai/v1/chat/completions',
    modelos: ['Meta-Llama-3.3-70B-Instruct'],
    env: 'SAMBANOVA_API_KEY',
  },
  // Sem sondagem, as chaves do HF ficavam presas: em 15/09/2026 as 6 estavam
  // marcadas, 3 sem credito do mes (402) e 3 respondendo 200 — e a cadeia de
  // capas rodava so com o Groq ate estourar.
  huggingface: {
    url: 'https://router.huggingface.co/v1/chat/completions',
    modelos: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct'],
    env: 'HUGGINGFACE_API_KEY',
  },
  gemini: {
    // Formato proprio (nao OpenAI): tratado a parte em respondeDeVerdade.
    gemini: true,
    modelos: ['gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-flash-latest'],
    env: 'GEMINI_API_KEY',
  },
};

/** Todas as chaves do provedor: BASE, BASE_2, BASE_3... sem furo. */
function chavesDe(base) {
  const out = [];
  for (let i = 1; i <= 12; i++) {
    const v = (process.env[i === 1 ? base : base + '_' + i] || '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * Sonda UMA chave especifica.
 *
 * Antes daqui so a primeira chave era testada, e a resposta dela decidia o
 * destino de todas as outras. Medido em 10/09/2026: das chaves Gemini, as duas
 * primeiras devolviam 429 e a TERCEIRA respondia 200 — o provedor inteiro ficava
 * preso por causa das duas da frente. Cota e por chave; a sondagem tambem tem
 * de ser.
 */
async function respondeDeVerdade(cfg, chave) {
  if (!chave) return false;
  if (cfg.gemini) {
    for (const modelo of cfg.modelos) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + chave, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Responda apenas: ok' }] }] }),
          signal: AbortSignal.timeout(30000),
        });
        if (r.ok) return modelo;
      } catch { /* proximo modelo */ }
    }
    return false;
  }
  for (const modelo of cfg.modelos) {
    try {
      const cab = { Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json' };
      if (cfg.ua) cab['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      const r = await fetch(cfg.url, {
        method: 'POST',
        headers: cab,
        // Tamanho parecido com o do pipeline: uma requisicao minuscula pode
        // passar sob um limite de tokens/dia que a real nao passaria, e ai a
        // sondagem mentiria a favor.
        body: JSON.stringify({
          model: modelo,
          messages: [{ role: 'user', content: 'Responda apenas: ok' }],
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return modelo;
    } catch { /* proximo modelo */ }
  }
  return false;
}

async function main() {
  let estado;
  try { estado = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { console.log('sem estado de IA — nada a fazer'); return; }
  if (!estado.degraded) { console.log('nenhum provider degradado'); return; }

  let liberou = 0;
  for (const [nome, cfg] of Object.entries(PROVEDORES)) {
    const marcados = Object.keys(estado.degraded)
      .filter(k => k === nome || k.startsWith(nome + ':'));
    if (!marcados.length) continue;

    // Varre TODAS as chaves: basta uma responder para o provedor voltar a ser
    // tentavel. Libera a entrada generica e as das chaves que responderam.
    const chaves = chavesDe(cfg.env);
    let vivo = false, vivas = 0;
    for (const c of chaves) {
      const m = await respondeDeVerdade(cfg, c);
      if (m) {
        vivo = vivo || m; vivas++;
        // A marca por chave usa o final da credencial como sufixo.
        const suf = c.slice(-8);
        for (const k of marcados) if (k.endsWith(':' + suf)) delete estado.degraded[k];
      }
    }
    if (!vivo) { console.log(nome + ': segue fora (' + marcados.length + ' marcados, mantidos)'); continue; }

    delete estado.degraded[nome];                 // trava do provedor inteiro
    const restantes = Object.keys(estado.degraded).filter(k => k.startsWith(nome + ':')).length;
    liberou += marcados.length - restantes;
    console.log(nome + ': RESPONDEU via ' + vivo + ' — ' + vivas + '/' + chaves.length +
      ' chaves vivas, ' + restantes + ' seguem marcadas');
  }

  if (liberou) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(estado, null, 2));
    console.log('estado salvo: ' + liberou + ' liberadas');
  } else {
    console.log('nada a liberar');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}

module.exports = { respondeDeVerdade, PROVEDORES };
