FROM node:20-bookworm-slim

# Instalar dependências do sistema (Puppeteer + Canvas + PDFKit)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    build-essential \
    python3 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Dizer ao Puppeteer para usar o Chromium instalado pelo sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"

WORKDIR /app

# Copiar package.json primeiro (cache de camadas)
COPY package*.json ./

# Instalar dependências (sem devDependencies)
RUN npm ci --omit=dev

# Copiar código fonte
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Criar diretórios de dados com permissões corretas
RUN mkdir -p data/pdfs data/covers logs && \
    chmod -R 777 data logs

EXPOSE 3100

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
