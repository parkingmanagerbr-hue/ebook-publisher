'use strict';
/**
 * resumoDiario.js — um resumo por loja do que aconteceu nas ultimas 24 h.
 *
 * Em 15/10/2026 a resposta a "o que publicou, o que recusou, o que falhou?"
 * estava espalhada em seis logs, e o mais lido (hotmart_vps.log) repetia a
 * mesma linha a cada volta de 10 min: a recusa do KDP ("conta bancaria que nao
 * pode receber") apareceu 465 vezes, o "pulado" da Kiwify 430. Repetir sem
 * contar afoga o que mudou. Aqui cada linha vira um registro (loja, contagem
 * ou motivo) e o motivo e agrupado: aparece UMA vez, com quantas vezes,
 * a primeira e a ultima.
 *
 * Tudo puro: recebe as linhas ("arquivo<TAB>linha") e devolve o resumo.
 */

/** Tira cor ANSI, datas, ids e numeros longos: o que sobra e o MOTIVO. */
function normalizarMotivo(texto) {
  return String(texto == null ? '' : texto)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:]+(?:[+-]\d{2}:\d{2}|Z)?\s*/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2} [\d:]+\]\s*/, '')
    .replace(/\b(info|warn|error)\b\s*/, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/GGKEY:[A-Z0-9]+/g, '<ggkey>')
    .replace(/"[^"]{40,}"/g, '"…"')
    .replace(/\d{3,}/g, 'N')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Momento da linha: ISO com fuso (laco do host) ou "[AAAA-MM-DD HH:MM:SS]" (container, UTC). */
function momentoDaLinha(linha) {
  const s = String(linha || '');
  let m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z))/.exec(s);
  if (m) return Date.parse(m[1]);
  m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/.exec(s.replace(/\x1b\[[0-9;]*m/g, ''));
  if (m) return Date.parse(m[1] + 'T' + m[2] + 'Z');
  return null;
}

const json = s => { try { return JSON.parse(s); } catch (_) { return null; } };

/**
 * Uma linha -> registros { loja, conta?: {chave: n}, motivo?, foto? }.
 * `foto` e o retrato do estado (o ultimo do periodo vale, nao se soma).
 */
function classificar(arquivo, linha) {
  const l = String(linha || '').replace(/\x1b\[[0-9;]*m/g, '');
  const corpo = l.replace(/^\S+T\S+\s+/, '');
  if (/OCI runtime exec failed|cannot exec in a stopped container/.test(l)) {
    const loja = (/^(\w[\w ]*?):/.exec(corpo) || [, 'laco'])[1];
    return [{ loja: 'infra', motivo: 'comando morto: container recriado no meio (deploy ou reinicio) — ' + loja }];
  }
  if (arquivo === 'hotmart_vps.log') {
    let m;
    if ((m = /lote \d+: TOTAL: (\d+)\/(\d+) publicados/.exec(corpo))) return [{ loja: 'hotmart', conta: { publicados: +m[1], tentados: +m[2] } }];
    if (/lote \d+: sem TOTAL/.test(corpo)) return [{ loja: 'hotmart', motivo: 'lote interrompido sem TOTAL (container recriado ou travou no meio)' }];
    if (/pede login/.test(corpo)) return [{ loja: 'hotmart', motivo: 'Hotmart pede login no navegador da VPS' }];
    if ((m = /^capas hotmart: TOTAL: (\d+)\/(\d+)/.exec(corpo))) return [{ loja: 'hotmart', conta: { capas: +m[1] } }];
    if (/^pdfs hotmart: \d+ uploadPDF=\w+ API confirma arquivo=false/.test(corpo)) return [{ loja: 'hotmart', motivo: normalizarMotivo(corpo) }];
    if ((m = /^(kiwify|capas kiwify|kdp|gplay): (\{.*\})\s*$/.exec(corpo))) {
      const j = json(m[2]);
      if (!j) return [];   // JSON quebrado nao vira conta inventada
      if (m[1] === 'kiwify') {
        if (j.pulado) return [{ loja: 'kiwify', motivo: 'rodada pulada: limite de produtos da conta (espera 6 h)' }];
        return [{ loja: 'kiwify', conta: { publicados: j.publicados || 0, falhas: j.falhas || 0, recusados: j.recusados || 0 } }];
      }
      if (m[1] === 'capas kiwify') return [{ loja: 'kiwify', conta: { capas: j.ok || 0, capasFalhas: j.falhas || 0 } }];
      if (m[1] === 'kdp') return [j.liberada ? { loja: 'kdp', foto: 'conta liberada' } : { loja: 'kdp', motivo: 'conta nao liberada: ' + normalizarMotivo(j.motivo) }];
      if (j.semSessao) return [{ loja: 'gplay', motivo: 'sem sessao do Google no navegador da VPS (entrar em navegador.veloxisit.com.br)' }];
      if (j.portao && j.portao !== 'live') return [{ loja: 'gplay', motivo: 'conta em revisao (portao: ' + j.portao + ') — nenhum livro novo' }];
      return [{ loja: 'gplay', conta: { publicados: j.publicados || 0, falhas: j.falhas || 0 } }];
    }
    if ((m = /^(\w[\w ]*?): .*\bERRO\b:?\s*(.*)$/.exec(corpo))) return [{ loja: m[1].replace(/^capas /, '').replace(/^pdfs /, ''), motivo: normalizarMotivo(m[2]) }];
    return [];
  }
  if (arquivo === 'backlog_publish.log') {
    if (/\[publicarCakto\] publicado /.test(l)) return [{ loja: 'cakto', conta: { publicados: 1 } }];
    if (/\[publicarCakto\] FALHA /.test(l)) return [{ loja: 'cakto', motivo: normalizarMotivo(l.replace(/^.*FALHA "[^"]*":\s*/, '')) }];
    // A linha "resumo: {...recusados: 0}" tem a palavra e NAO e recusa (medido
    // no primeiro resumo real: 83 linhas de resumo listadas como motivo).
    if (/\[publicarCakto\] (?!resumo:).*recusad/i.test(l)) return [{ loja: 'cakto', motivo: normalizarMotivo(l) }];
    return [];
  }
  if (arquivo === 'cakto_checkout.log') {
    const m = /checkout da Cakto: (\{.*\})/.exec(l);
    if (m) { const j = json(m[1]); if (!j) return []; return [{ loja: 'cakto', foto: 'checkout na vitrine: ' + j.ativos + ' ativos de ' + j.livros + ' | fora: ' + JSON.stringify(j.motivos || {}) }]; }
    if (/ERRO|lista incompleta/.test(l)) return [{ loja: 'cakto', motivo: 'checkout: ' + normalizarMotivo(l) }];
    return [];
  }
  if (arquivo === 'recompressao_pdf.log') {
    const m = /recompressao: (\{.*\})/.exec(l);
    if (m) { const j = json(m[1]); if (j && j.substituidos) return [{ loja: 'pdfs', conta: { recomprimidos: j.substituidos, mantidos: j.mantidos || 0 } }]; }
    return [];
  }
  if (arquivo === 'kiwify_cadeia.log' && /resumo da auditoria/.test(l)) return [{ loja: 'kiwify', foto: 'auditoria de entrega: ' + l.replace(/^.*resumo da auditoria de entrega[^:]*:\s*/, '') }];
  return [];
}

/** Junta os registros do periodo [desde, ate). Pura. */
function agregar(entradas, { desde, ate }) {
  const lojas = {};
  const loja = n => (lojas[n] = lojas[n] || { conta: {}, motivos: {}, foto: null });
  for (const { arquivo, linha } of entradas || []) {
    const t = momentoDaLinha(linha);
    if (t == null || t < desde || t >= ate) continue;
    for (const r of classificar(arquivo, linha)) {
      const L = loja(r.loja);
      if (r.conta) for (const [k, v] of Object.entries(r.conta)) L.conta[k] = (L.conta[k] || 0) + v;
      if (r.foto) L.foto = r.foto;
      if (r.motivo) {
        const m = L.motivos[r.motivo] = L.motivos[r.motivo] || { n: 0, primeira: t, ultima: t };
        m.n++; m.primeira = Math.min(m.primeira, t); m.ultima = Math.max(m.ultima, t);
      }
    }
  }
  return lojas;
}

const hora = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

/** Texto do resumo; `extras[loja]` = linhas vindas do banco. Pura. */
function formatar(lojas, { desde, ate, extras = {} }) {
  const linhas = ['Resumo das lojas — ' + hora(desde) + ' a ' + hora(ate) + ' UTC', ''];
  const ordem = ['hotmart', 'cakto', 'kiwify', 'gplay', 'kdp', 'pdfs', 'infra'];
  const nomes = [...new Set([...ordem, ...Object.keys(lojas), ...Object.keys(extras)])].filter(n => lojas[n] || extras[n]);
  for (const n of nomes) {
    const L = lojas[n] || { conta: {}, motivos: {}, foto: null };
    linhas.push('## ' + n);
    const c = Object.entries(L.conta);
    if (c.length) linhas.push('  ' + c.map(([k, v]) => k + ': ' + v).join(' | '));
    if (L.foto) linhas.push('  estado: ' + L.foto);
    for (const x of extras[n] || []) linhas.push('  ' + x);
    const ms = Object.entries(L.motivos).sort((a, b) => b[1].n - a[1].n);
    for (const [motivo, m] of ms) linhas.push('  - ' + motivo + ' — ' + m.n + 'x' + (m.n > 1 ? ' (' + hora(m.primeira) + ' a ' + hora(m.ultima) + ')' : ' (' + hora(m.primeira) + ')'));
    if (!c.length && !L.foto && !ms.length && !(extras[n] || []).length) linhas.push('  sem atividade');
    linhas.push('');
  }
  if (!nomes.length) linhas.push('nenhuma linha no periodo');
  return linhas.join('\n');
}

module.exports = { normalizarMotivo, momentoDaLinha, classificar, agregar, formatar };
