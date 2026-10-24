# 1.4.4 carries the Brotli decoder fix (CVE-2026-111497, "Node2Shell"). The exact tag, not the floating
# `1-alpine`, so a rebuild can't reuse an older cached base image.
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src ./src
EXPOSE 8787
CMD ["bun", "run", "src/index.js"]
