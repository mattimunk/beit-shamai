# Beit Shamai – web app + API + scheduled data jobs in one container.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun test && bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
# OCR for printed Madlan / Yad2 pages: page rendering, Hebrew OCR, strike-through removal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-heb tesseract-ocr-eng imagemagick \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/beit-shamai.sqlite \
    DATA_DIR=/data \
    SOURCES_PATH=/app/config/sources.json \
    APP_FILE=/app/dist/index.html \
    SCHEDULER=1 \
    TZ=Asia/Jerusalem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "server/main.ts"]
