# Kiwify — como o robô publica (conhecimento verificado em 22/09/2026)

Tudo aqui foi **medido na conta real** (mrovariz@hotmail.com, loja `UvNS70d5KKT3Em7`),
não lido em documentação. Cópia deste arquivo vive em `/opt/platform/data/genia/kiwify.md`
(fora do git, sobrevive a deploy) para não ser preciso redescobrir.

## Estado da conta (bloqueio que não é técnico)

O painel exibe **"Você precisa completar o seu cadastro antes de começar a vender"**.
Criar produto funciona; **receber** não, enquanto o cadastro (CPF/dados pessoais e
dados bancários) não for completado pelo titular. Isso é ação do dono — o robô não
preenche documento nem dado pessoal.

## Sessão

- Painel: `https://dashboard.kiwify.com` (Nuxt). API: `https://admin-api.kiwify.com.br`.
- Autenticação Firebase: `POST /v1/handleAuth/getIdToken` com `refresh_token` devolve
  o idToken; o painel manda `authorization: Bearer <idToken>`.
- **Só o Bearer não basta**: a API responde `400 {"error":"DEVICE_TOKEN_INVALID"}`
  sem o token de dispositivo (`kiwi_device_token_<uid>` no localStorage). Por isso o
  agente roda **de dentro da página logada** (mesma estratégia da Hotmart), onde o
  próprio painel resolve os dois.
- `/products/new` **não existe** (404 do Nuxt). O fluxo é o botão "Criar produto" na
  lista, que abre um modal.

## Criar produto (medido)

1. `https://dashboard.kiwify.com/products` → botão "Criar produto" (canto superior direito).
2. Modal: *Tipo de pagamento* = Pagamento único; *Entrega do conteúdo* = Área de membros
   da Kiwify; *Área de membros* = Criar nova. → "Continuar".
3. Formulário: Nome, Descrição (máx. 500), Página de vendas, Preço. O campo de preço
   tem **máscara**: só aceita digitação (`keyboard.type('500')` = R$ 5,00); `value =`
   direto cai no campo errado.
4. "Criar produto" dispara:

```
POST /v1/products
{"name":"...","price":500,"payment_type":"charge","sales_page_url":"https://...",
 "type":"club","description":"...","currency":"BRL","club_id":null}
```

`price` é em **centavos**. Resposta redireciona para `/products/edit/<uuid>`.
A área de membros é criada junto, com o nome do produto e a oferta no Grupo A.

## Editar (categoria, garantia, checkout)

"Salvar produto" manda o objeto **inteiro** (como a Cakto — não há PATCH):

```
PUT /v1/products/<uuid>
{"name","currency","description","moneyback_guarantee":7,"cpf_required":true,
 "mobile_required":true,"email_confirmation_required":true,"price":500,
 "category":13,"payment_methods":3,"soft_descriptor":"...", "days_expiration":2,
 "checkout_color":"#2353ff","sales_page_url":"...", "pixels":[], ...}
```

Categorias (valor do `<select>`): 13 = Desenvolvimento Pessoal. As demais aparecem na
mesma ordem do painel (Saúde e Esportes, Finanças e Investimentos, Relacionamentos,
Negócios e Carreira, Espiritualidade, Sexualidade, Entretenimento, Culinária,
Idiomas, Direito, Apps & Software, Literatura, Casa e Construção, Desenvolvimento
Pessoal, Moda e Beleza, Animais e Plantas, Educacional, Hobbies, Internet, Ecologia,
Música e Artes, Tecnologia…).

## Moedas (o que permite "produto mundial")

O seletor de preço aceita: **AED, ARS, AUD, BRL, CAD, CLP, COP, EUR, GBP, JPY, MXN,
PEN, USD**. Um produto tem uma moeda; para vender no mundo, publica-se o mesmo livro
em moedas diferentes (ou usa-se BRL com checkout internacional).

## Atualizar produto (PUT tem LISTA BRANCA)

Devolver o objeto do `GET` inteiro dá **400**:

```
{"error":{"fields":["\"type\" must be one of [payment, membership]",
 "\"id\" is not allowed","\"created_at\" is not allowed","\"club\" is not allowed", ...]}}
```

Ou seja: `id`, `created_at`, `club`, `gateway_type`, `soft_ban`,
`has_sales_recovery_agent` e `subscriptions_bulk_cancel_allowed` **não podem ir**, e
`type` no PUT é "payment"/"membership" (no POST é "club"). O corpo é montado do zero
em `kiwifyRegras.corpoDeAtualizacao` — com PUT assim a resposta é
`{"product_updated":true}`.

## Entrega do PDF (resolvido sem upload)

O `GET /v1/products/{id}` **esconde** categoria, garantia e `approved_url`; use
`GET /v1/products/{id}?full=true`.

A entrega usa o mesmo link assinado (HMAC) que a Cakto já usa desde 15/09/2026:
`approved_url = https://publisher.veloxisit.com.br/entrega/<id>.<assinatura>`.
Medido em 22/09/2026: o link devolve `200 application/pdf` (3,3 MB) e um token
adulterado devolve `404`. Assim o arquivo sai do nosso servidor e não vira link
público.

Área de membros (caminho alternativo, mapeado mas não usado para e-book):
- `GET /v1/clubs?count=50` lista as áreas; o id do club serve de id do course.
- `GET /v1/courses/{club}` (módulos), `GET /v1/courses/{club}/classes` (turmas).
- `POST /v1/courses/{club}/modules {name, classes:[idDaTurma], free:false}`.
- `POST /v1/courses/{club}/lessons {module_id, title, delivery_type:'INSTANT'}`
  (`delivery_type` só aceita DAY, INSTANT ou DATE).

## Upload de arquivo

`GET /v1/uploads/signature` devolve `{signature, signature384, expires, store}` —
assinatura para subir arquivo (padrão tus/S3 assinado). `GET /v1/videos/signature?type=single`
faz o mesmo para vídeo. O PDF do livro entra pela **área de membros** (editor próprio),
não pelo cadastro do produto.

## Primeiro produto criado pelo robô

`df45f300-b6e7-11f1-b5cc-f12a10b4dfb6` — "Mindfulness e Produtividade Remota",
R$ 5,00, categoria Desenvolvimento Pessoal. Serve de referência do contrato.
