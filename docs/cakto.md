# Cakto — por que 8.183 produtos no ar não venderam nada (auditoria de 23/09/2026)

Tudo medido pela API da conta real e pelo checkout público, não deduzido.

## O que a auditoria de 8.000 produtos mostrou

| Problema | Quantos | Efeito no comprador |
|---|---|---|
| `status: waiting_config` | 5.485 (69%) | o produto **não vende**: "Ajustar para vender" no painel |
| Sem `emailAccessLink` | 5.643 | pagaria e **não receberia** o livro |
| Sem `image` | 5.768 | checkout só com o título |
| Sem `producerName` | 8.000 | checkout dizia "Termos de uso de **\<e-mail pessoal do dono\>**" |
| Sem afiliação | 8.000 | ninguém podia divulgar por comissão |

Ou seja: a falta de vendas **não é só falta de tráfego**. Dois terços do catálogo
estavam pausados, sem arquivo e sem identidade de vendedor.

## A causa raiz

O texto do e-book **nunca foi guardado** — só o PDF, e a retenção antiga apagava
PDFs "velhos" achando que eram lixo local. Resultado medido: **5.795 dos 8.190
PDFs sumiram do disco** (e 5.033 capas). Sem arquivo, o job de entrega pausou os
produtos, corretamente.

A retenção já foi corrigida em 15/09/2026 (`src/core/retencao.js` protege o que
está publicado) e há 56 GB livres — mas o estrago anterior só se desfaz
regerando cada livro com IA, porque o texto não existe em lugar nenhum.

**Lição estrutural: guardar o conteúdo, não só o arquivo derivado.** Enquanto o
texto não for persistido, qualquer perda de PDF custa uma geração de IA inteira.

## Ritmo: o gargalo real

- `regerarPdfCakto.js` reescreve o livro com IA e rodava `--limite=1` a cada
  30 min → 48/dia → **120 dias** para 5.795.
- `capasCaktoFaltantes.js` só olha quem tem PDF.
- `entregaCakto.js` só corrige quem tem PDF.

Por isso nasceu `scripts/higieneCakto.js`: corrige o que **não** depende do PDF
(nome do vendedor, página de vendas, afiliação, capa) em todo o catálogo,
inclusive nos pausados, sem tocar em `status`. Cron a cada 20 min, 60 por rodada.

## Contratos da API (medidos)

- Sessão: cookies de `/app/data/sessions/cakto.json` + `GET /api/get-csrf-token/`
  (devolve o token **e** grava cookie novo — precisa mesclar os dois).
- Oferta (o shortcode do checkout): `GET /api/offers/{shortcode}/` → traz
  `product` (uuid).
- Produto: `GET /api/product/{uuid}/` (singular; `products/{uuid}` dá 404).
  Alterar = **PUT com o objeto inteiro** (PATCH devolve 405).
- Capa: `PUT /api/product/{uuid}/image/`, multipart, campo `image`.
  Em `product/{uuid}/` a API responde `405 Método "PATCH" não é permitido`.
- Listagem: `GET /api/products/?limit=100` com `next` — a partir de ~80 páginas
  seguidas ela devolve `429`.
- Comissão de afiliado só aceita 1 a 95; `"0.00"` gravado derruba o PUT inteiro (400).

## O que ainda depende do dono (configuração da conta)

1. **A taxa de R$ 0,99 é cobrada do comprador**: um livro de R$ 5,00 fecha em
   **R$ 5,99** no total. Em produto barato isso é 20% a mais e aparece bem na
   hora de pagar. Dá para assumir a taxa como vendedor — é decisão de dinheiro.
2. **O layout do checkout não mostra imagem do produto.** A capa foi enviada e
   serve ao marketplace/afiliados, mas este checkout exibe só título e preço.
   Se houver tema de checkout com imagem, vale trocar.

## O que já foi corrigido (medido no checkout depois)

`https://pay.cakto.com.br/qzj9ys5` passou a mostrar **"Termos de uso de Veloxis
Editorial"** no lugar do e-mail pessoal.

## Incidente de 24/09/2026: escrita fora do ar (HTTP 500)

A partir da manhã de 24/09 **todo `PUT /api/product/{uuid}/` passou a responder
`500` com HTML de "Server Error"** — inclusive um PUT devolvendo o objeto
exatamente como o `GET` entregou, sem nenhuma alteração nossa. Testado em cinco
produtos diferentes, todos 500. A criação de produto pela UI (job de backlog)
falhou junto: "Produto não criado (URL ficou em ?tab=products sem ID)".

Conclusão: é incidente da Cakto, não do nosso conteúdo — de manhã cedo o mesmo
passe corrigia 5 de 5.

O que mudou no nosso lado: `higieneCakto.ehErroDaLoja(status, corpo)` reconhece
5xx (ou HTML no lugar de JSON) e **para a rodada na hora**, em vez de registrar
60 falhas e voltar a martelar a cada 20 minutos. O resultado da rodada passa a
trazer `foraDoAr: true`.
