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
    modelos: ['llama3.1-8b', 'llama-3.3-70b'],
    env: 'CEREBRAS_API_KEY',
  },
};

async function respondeDeVerdade(cfg) {
  const chave = process.env[cfg.env];
  if (!chave) return false;
  for (const modelo of cfg.modelos) {
    try {
      const r = await fetch(cfg.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json' },
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

    const modelo = await respondeDeVerdade(cfg);
    if (!modelo) { console.log(nome + ': segue fora (' + marcados.length + ' marcados, mantidos)'); continue; }

    for (const k of marcados) delete estado.degraded[k];
    liberou += marcados.length;
    console.log(nome + ': RESPONDEU via ' + modelo + ' — liberadas ' + marcados.length + ' entradas');
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
