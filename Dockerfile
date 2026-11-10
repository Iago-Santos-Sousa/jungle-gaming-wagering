# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.4.4

# Base comum: imagem slim do Bun com fuso horário brasileiro
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app
ENV TZ=America/Sao_Paulo

# Dependências de produção, em camada própria para aproveitar cache
FROM base AS deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# Ambiente de desenvolvimento e testes, com todas as dependências
FROM base AS dev
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY tsconfig.json bunfig.toml ./
COPY src ./src
COPY test ./test
CMD ["bun", "test"]

# Runtime enxuto: o Bun executa TypeScript direto, sem etapa de build
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "src/main.ts"]
