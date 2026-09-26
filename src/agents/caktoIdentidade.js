'use strict';
/**
 * caktoIdentidade.js — quem aparece no checkout da Cakto.
 *
 * Vive separado (e sem `process.env`) para que a regra seja a MESMA em
 * producao e no teste: com fallback de ambiente, o valor mudava conforme a
 * maquina e o ramo nao dava para exercitar.
 */

// Nome do vendedor no checkout. Vazio, a Cakto mostrava o E-MAIL da conta
// ("Termos de uso de ...@hotmail.com") — comprador desconfia.
const PRODUTOR = 'Veloxis Editorial';

// Comissao de afiliado (decisao do dono em 16/09/2026): sem trafego proprio,
// afiliado so encontra o produto se ele estiver na vitrine com comissao.
const COMISSAO_AFILIADO = 50;

// E-mail de suporte que vai no checkout (conta da editora, nao o pessoal).
const SUPORTE = 'mrovariz@hotmail.com';

module.exports = { PRODUTOR, COMISSAO_AFILIADO, SUPORTE };
