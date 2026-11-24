# Playwright Docker image: já vem com Chromium + todas as libs Linux instaladas.
# Ver: https://mcr.microsoft.com/en-us/product/playwright/about
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Habilita corepack pra pnpm (Node 20 tem embedded corepack)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copia workspace + repo INTEIRO. Simplicidade > cache Docker granular.
COPY . .

RUN pnpm install --frozen-lockfile

# Build workspace packages que apontam main pra dist/ — evita
# ERR_MODULE_NOT_FOUND em runtime (worker importa via package name).
RUN pnpm --filter @blackshop/landinglab-cloner build
RUN pnpm --filter @blackshop/landinglab-adapters build

CMD ["pnpm", "--filter", "@blackshop/worker", "exec", "tsx", "src/index.ts"]
