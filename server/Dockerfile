FROM node:20-slim

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates fonts-noto-cjk \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxshmfence1 \
    libxfixes3 libxext6 libx11-6 libx11-xcb1 \
    libxcb1 libxcursor1 libxi6 libxtst6 \
    libglib2.0-0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
RUN npx playwright install --with-deps chromium

COPY server.mjs .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
