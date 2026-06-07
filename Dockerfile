FROM node:20-bookworm-slim

# Instalar dependências do sistema (Puppeteer + Canvas + PDFKit + Edge TTS)
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
    python3-pip \
    python3-venv \
    ffmpeg \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --break-system-packages edge-tts 2>/dev/null || pip3 install edge-tts || true

# Puppeteer usa o Chromium instalado pelo sistema (não baixa o próprio)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage" \
    NODE_ENV=production

WORKDIR /app

# Copiar package.json primeiro (melhor uso do cache de camadas)
COPY package*.json ./

# Instalar dependências Node (sem devDependencies)
RUN npm install --omit=dev

# Copiar código fonte
COPY src/        ./src/
COPY public/     ./public/
COPY scripts/    ./scripts/
COPY megaAgent.js ./
COPY start.sh    ./

# Tornar entrypoint executável
RUN chmod +x start.sh

# Criar diretórios de dados com permissões corretas
RUN mkdir -p data/pdfs data/covers data/sessions data/audiobooks data/db logs && \
    chmod -R 777 data logs

EXPOSE 3100

# Healthcheck — verifica /api/status (endpoint público, sem auth)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/api/status',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Entrypoint com suporte a DASHBOARD_ONLY / MEGA_ONLY / FULL
CMD ["sh", "start.sh"]
