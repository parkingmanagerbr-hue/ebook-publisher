# GENIA EbookPublisher

Sistema autônomo de criação e publicação de e-books com IA. Gera e-books completos (texto + capa + PDF + audiobook), publica automaticamente no Hotmart, Cakto e Amazon KDP, e cria landing pages de afiliados — tudo sem intervenção humana.

## Como funciona

```
Google Trends / Banco de tópicos
         ↓
  Seleção por ML score
         ↓
  Geração de conteúdo (Gemini → Cerebras → SambaNova → ...)
         ↓
  Capa (Gemini Image → HTML/Puppeteer → Canvas)
         ↓
  PDF (PDFKit)   +   Audiobook (ElevenLabs → Edge TTS)
         ↓
  Publicação automática
  ├── Hotmart (Puppeteer)
  ├── Cakto   (Puppeteer)
  └── Amazon KDP (Puppeteer)
         ↓
  Landing Pages + Afiliados
  └── Deploy (Vercel → Netlify → VPS)
```

## Requisitos

- **Node.js 20+**
- **Python 3.10+** com `pip install edge-tts` (audiobooks)
- **Google Chrome** instalado (Puppeteer usa para publicação)
- Contas ativas no **Hotmart**, **Cakto** e/ou **Amazon KDP**
- Pelo menos uma chave de API: **Gemini** (grátis em [aistudio.google.com](https://aistudio.google.com))

---

## Setup rápido (local)

### 1. Instalar dependências

```bash
npm install
pip install edge-tts   # audiobooks
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com suas chaves e credenciais
```

Variáveis mínimas para começar:
```env
GEMINI_API_KEY=sua_chave_aqui
HOTMART_EMAIL=seu@email.com
HOTMART_PASSWORD=sua_senha
AUTO_PUBLISH_HOTMART=true
AUTO_PUBLISH_CAKTO=false
AUTO_PUBLISH_AMAZON=false
```

### 3. Exportar sessão das plataformas

```bash
# Hotmart (faça login no Chrome antes)
npm run setup:hotmart

# Cakto (faça login no Chrome antes)
npm run setup:cakto
```

### 4. Iniciar

```bash
# Dashboard + agente autônomo juntos
npm run server     # Dashboard em http://localhost:3100
node megaAgent.js  # Loop de geração (em outro terminal)

# Ou só testar geração de um e-book
npm run example
```

Acesse o dashboard: **http://localhost:3100**  
Crie sua conta na primeira vez em: **http://localhost:3100/register**

---

## Comandos disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run server` | Inicia o dashboard web (porta 3100) |
| `npm run mega` | Loop infinito de geração + publicação |
| `npm run example` | Gera um e-book de exemplo (sem publicar) |
| `npm run setup:hotmart` | Exporta sessão do Hotmart do Chrome |
| `npm run setup:cakto` | Exporta sessão do Cakto do Chrome |
| `npm run setup:sessions` | Renova todas as sessões automaticamente |
| `npm run trending` | Injeta tópicos do Google Trends no banco |
| `npm run renew` | Renova sessões Hotmart + Cakto via login |

---

## Configuração detalhada do `.env`

### IA — Provedores de texto (ordem de fallback)

| Variável | Onde obter | Grátis? |
|----------|-----------|---------|
| `GEMINI_API_KEY` (até `_5`) | [aistudio.google.com](https://aistudio.google.com/app/apikey) | ✅ 1500 req/dia |
| `CEREBRAS_API_KEY` (até `_6`) | [cloud.cerebras.ai](https://cloud.cerebras.ai) | ✅ Ilimitado |
| `SAMBANOVA_API_KEY` (até `_8`) | [cloud.sambanova.ai](https://cloud.sambanova.ai) | ✅ 400 RPM |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) | ✅ 14.400 req/dia |
| `DEEPSEEK_API_KEY` (até `_2`) | [platform.deepseek.com](https://platform.deepseek.com) | Créditos grátis |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) | Pago |

### Publicação

| Variável | Descrição |
|----------|-----------|
| `HOTMART_EMAIL` / `HOTMART_PASSWORD` | Credenciais Hotmart |
| `CAKTO_EMAIL` / `CAKTO_PASSWORD` | Credenciais Cakto |
| `KDP_EMAIL` / `KDP_PASSWORD` | Credenciais Amazon KDP |
| `AUTO_PUBLISH_HOTMART` | `true`/`false` |
| `AUTO_PUBLISH_CAKTO` | `true`/`false` |
| `AUTO_PUBLISH_AMAZON` | `true`/`false` (requer configuração extra) |
| `EBOOK_PRICE` | Preço em BRL (ex: `4.99`) |
| `KDP_PRICE_USD` | Preço em USD para Amazon (mín: `0.99`) |

### Agente autônomo

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `GENERATE_INTERVAL_MINUTES` | `180` | Intervalo entre ciclos (0 = contínuo) |
| `EBOOK_LANGUAGES` | `pt-BR` | Idiomas separados por vírgula |
| `SKIP_ILLUSTRATIONS` | `true` | Pular imagens nos capítulos (mais rápido) |
| `GENERATE_AUDIOBOOK` | `false` | Gerar MP3 de cada e-book |
| `AGENT_PAUSED` | `false` | Iniciar pausado |
| `WEB_EBOOK_FIRST` | `true` | Usar Gamma/Piktochart antes do pipeline LLM |

### Serviços web gratuitos (até 168 e-books/mês)

Configure contas Gmail para gerar e-books via Gamma, Piktochart, ebookmaker.ai e Visme:

```env
GMAIL_ACCOUNTS=conta1@gmail.com,conta2@gmail.com,conta3@gmail.com
GAMMA_MONTHLY_LIMIT=8
PIKTOCHART_MONTHLY_LIMIT=5
EBOOKMAKER_MONTHLY_LIMIT=10
VISME_MONTHLY_LIMIT=5
```

Depois configure as sessões:
```bash
npm run setup:sessions  # ou: node scripts/setup-web-sessions.js
```

### Geração de imagens (capas)

A capa é gerada automaticamente com fallback chain:

| Variável | Serviço | Qualidade | Custo |
|----------|---------|-----------|-------|
| `GEMINI_API_KEY` | Gemini Imagen 4 | ⭐⭐⭐⭐ | Grátis |
| `HIGGSFIELD_API_KEY` (até `_6`) | FLUX Pro Kontext Max | ⭐⭐⭐⭐⭐ | Pago |
| `HUGGINGFACE_API_KEY` (até `_6`) | FLUX.1-schnell | ⭐⭐⭐ | Grátis (limite) |
| `FAL_AI_API_KEY` | FLUX/schnell | ⭐⭐⭐ | Free tier |
| `TOGETHER_API_KEY` | FLUX.1-schnell | ⭐⭐⭐ | Free tier |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` | Cloudflare AI | ⭐⭐⭐ | Grátis |
| — | Pollinations.ai | ⭐⭐ | Sempre grátis (fallback) |
| — | Canvas puro | ⭐ | Sempre disponível (último recurso) |

### Audiobooks (opcional)

```env
ELEVENLABS_API_KEY=        # alta qualidade (pago)
ELEVENLABS_API_KEY_2=      # até 4 chaves rotativas
ELEVENLABS_VOICE_ID=       # ID da voz (padrão: Adam)
GENERATE_AUDIOBOOK=true
```

Sem ElevenLabs: usa **Microsoft Edge TTS** (neural, gratuito, sem limite).

### Landing Pages de Afiliados (opcional)

```env
# Cloudflare DNS (para subdomínios automáticos)
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_API_TOKEN=
BASE_DOMAIN=seudominio.com.br

# Deploy em nuvem (recomendado)
VERCEL_TOKEN=           # vercel.com/account/tokens
NETLIFY_TOKEN=          # app.netlify.com/user/applications
FORCE_CLOUD_DEPLOY=false
```

---

## Deploy com Docker

### Desenvolvimento local

```bash
# Copiar e editar .env
cp .env.example .env

# Configurar sessões das plataformas
npm run setup:hotmart
npm run setup:cakto

# Subir tudo (dashboard + megaAgent)
docker compose up -d

# Só o dashboard
docker compose up -d dashboard

# Só o loop de geração
docker compose up -d mega-agent
```

### Produção (VPS)

```bash
# Na VPS
cd /home/deploy/ebook-publisher-work
cp .env.example .env && nano .env

# Criar pasta de sessões (bind mount)
mkdir -p data/sessions

# Transferir sessões exportadas do Windows
scp data/sessions/*.json vps:/home/deploy/ebook-publisher-work/data/sessions/

# Subir
docker compose -f docker-compose.production.yml up -d
```

O CI/CD faz deploy automático ao fazer `git push` para `main`.

---

## Arquitetura

```
EbookPublisher/
├── src/
│   ├── agents/
│   │   ├── writerAgent.js        # Geração de texto (LLM)
│   │   ├── coverAgent.js         # Geração de capa
│   │   ├── pdfAgent.js           # Montagem do PDF
│   │   ├── audiobookAgent.js     # TTS (ElevenLabs / Edge TTS)
│   │   ├── publisherHotmart.js   # Publicação Hotmart (Puppeteer)
│   │   ├── publisherCakto.js     # Publicação Cakto (Puppeteer)
│   │   ├── publisherAmazon.js    # Publicação Amazon KDP (Puppeteer)
│   │   ├── affiliateAgent.js     # Descoberta de produtos afiliados
│   │   ├── landingPageAgent.js   # Geração e deploy de landing pages
│   │   ├── backlinkAgent.js      # Hub de backlinks
│   │   ├── sessionAgent.js       # Renovação automática de sessões
│   │   ├── topicExpander.js      # Banco de 500+ tópicos
│   │   ├── learningAgent.js      # ML de otimização de tópicos
│   │   └── webEbookAgents/       # Gamma, Piktochart, ebookmaker, Visme
│   ├── core/
│   │   ├── aiClient.js           # Fallback chain (8 providers, 40+ chaves)
│   │   ├── autonomousAgent.js    # Loop 24/7 principal
│   │   ├── database.js           # SQLite (tópicos, e-books, métricas)
│   │   └── logger.js
│   ├── infrastructure/
│   │   ├── db/                   # DDD Repository + Migrations
│   │   ├── session/              # SessionManager
│   │   └── queue/                # PublishingQueue (in-memory)
│   ├── domain/                   # Entidades e serviços DDD
│   ├── application/              # Orchestrator + ML PriorityScorer
│   ├── presentation/             # API routes + WebSocket
│   ├── routes/                   # Legacy API routes
│   └── server.js                 # Express + Socket.io (porta 3100)
├── public/
│   ├── dashboard.html            # Dashboard completo
│   ├── status.html               # Monitoramento público
│   ├── login.html / register.html
│   └── index.html                # Landing page
├── scripts/                      # Setup, renovação de sessões, utilidades
├── megaAgent.js                  # Loop standalone (alternativa ao autonomousAgent)
├── Dockerfile
├── docker-compose.yml            # Dev: dashboard + mega-agent
└── docker-compose.production.yml # Prod: ghcr.io image + VPS
```

### Providers de IA (ordem de fallback)

```
Gemini (5 chaves) → Cerebras (6) → SambaNova (8) → Groq → DeepSeek (2) →
HuggingFace (4) → Pollinations (grátis) → Ollama VPS → Ollama Local
```

---

## FAQ

**Como gerar meu primeiro e-book?**
```bash
npm run example
# PDF gerado em: data/pdfs/ebook_*.pdf
```

**O agente parou de publicar no Hotmart — o que fazer?**
```bash
npm run renew         # renova sessão automaticamente
# ou
npm run setup:hotmart # exportar nova sessão do Chrome
```

**Como adicionar mais contas Gmail para serviços web?**
```env
GMAIL_ACCOUNTS=conta1@gmail.com,conta2@gmail.com,conta3@gmail.com
```
Depois: `node scripts/setup-web-sessions.js`

**Como trocar o idioma dos e-books?**
```env
EBOOK_LANGUAGES=pt-BR,en,es,fr
```
O agente rotaciona sequencialmente entre os idiomas configurados.

**Como ver os logs em tempo real?**
Acesse o dashboard → aba **Logs**.  
Ou no terminal: `tail -f logs/autonomousAgent.log`

---

## Licença

Uso privado. Não redistribuir.
