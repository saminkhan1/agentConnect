# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

RUN corepack enable

# Install all deps (includes drizzle-kit for migrations)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Compiled output
COPY --from=builder /app/dist ./dist

# Migration files + config (needed by drizzle-kit migrate at startup)
COPY src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000

# Railway overrides this via startCommand in railway.toml (runs migrations first)
CMD ["node", "dist/api/server.js"]
