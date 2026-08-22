FROM node:22-slim AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg python3 make g++ curl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY services ./services

RUN npm ci
RUN npm run build

# --- Runtime Image ---
FROM node:22-slim

WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg curl python3 && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/apps /app/apps
COPY --from=builder /app/services /app/services

# Default to bot, but can be overridden
ENV NODE_ENV=production
CMD ["node", "apps/bot/dist/index.js"]
