# Stage 1: Install dependencies
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Build
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: Production runner
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Resume PDF export (puppeteer-core): @sparticuz/chromium is x86_64-only, so
# arm64 hosts need a system Chromium — CHROMIUM_PATH takes precedence in
# pdfService. Font packages are required or PDF text renders as empty boxes.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto \
 && { command -v chromium-browser >/dev/null 2>&1 || ln -s "$(command -v chromium)" /usr/bin/chromium-browser; }
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Create recording storage directory
RUN mkdir -p /data/recordings && chown nextjs:nodejs /data/recordings

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
