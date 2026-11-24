# Instalação do LandingLab (roteiro para o Claude Code)

Este arquivo é o passo a passo para instalar o LandingLab numa máquina ou num projeto novo. Siga na ordem.
Não pule a checagem de cada passo. Segredos (chaves, senhas, `DATABASE_URL`) são do usuário: peça para ele
preencher o `.env` e **nunca** imprima nem faça commit dos valores.

## 0. O que vem no repositório

| Parte | Caminho | Porta | O que faz |
|---|---|---|---|
| Backoffice (Next 14) | `apps/backoffice` | 3000 | Painel: lista de landings, editor, gerar/clonar, domínios |
| API (Fastify) | `apps/api` | 3001 | Login/sessão, lojas, enfileira jobs (`/landinglab/queues/:queue/jobs`), domínios Spaceship |
| Worker (BullMQ + Playwright) | `apps/worker` | — | Filas `landinglab.*`: clone, apply-bundle, tradução, export, squads 1–5 (gerar com IA) |
| Storefront (Next 14) | `apps/landinglab-storefront` | 3011 | Serve as landings publicadas pelo domínio (host → landing) |
| Banco | `packages/db/migrations` | — | Todas as migrations (Postgres). Aplicar todas, na ordem |
| Seed | `packages/db/scripts` | — | Exportar/importar uma landing entre bancos (`export-landing.mjs` / `seed-landing.mjs`) |

Os pacotes mantêm o nome `@blackshop/*` (vieram do monorepo original). Não renomeie: quebra imports.

## 1. Pré-requisitos

- Node **≥ 20** (recomendado 22, ver `.nvmrc`) e pnpm **9** (`corepack enable && corepack prepare pnpm@9.15.0 --activate`).
- **Postgres 15+**: um projeto Supabase novo é o caminho mais simples (o storage também é usado).
  O usuário do banco precisa de `BYPASSRLS` (o `postgres` do Supabase já tem). Sem isso a migration 0101 aborta.
- **Redis 6+** (local: `docker run -d -p 6379:6379 redis:7`; produção: Upstash/Railway).
- Chromium do Playwright para o worker clonar páginas (passo 4).

## 2. Instalar dependências

```bash
pnpm install
```

O `postinstall` roda `pnpm build:libs` (compila `landinglab-adapters`, `landinglab-cloner`, `landinglab-render` e o
html-builder do `landinglab-build`, que exportam de `dist/`). Se falhar, rode `pnpm build:libs` e leia o erro.

## 3. Variáveis de ambiente

Crie o arquivo **`.env` na raiz** (todos os apps leem dele em dev, via `dotenv-cli`). Peça ao usuário os valores.
Gere os segredos locais com `openssl rand -hex 32`.

```dotenv
# ── Núcleo (obrigatório)
NODE_ENV=development
DATABASE_URL=            # Postgres (Supabase: Settings → Database → connection string, modo session/5432)
REDIS_URL=redis://localhost:6379
SUPABASE_URL=            # https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=   # igual ao SUPABASE_URL
SESSION_SECRET=          # ≥ 32 chars
VAULT_SECRET=            # ≥ 32 chars
APP_PASSWORD_HASH=       # bcrypt de uma senha de emergência (a API não sobe sem). Ver passo 6
LEGACY_LOGIN_ENABLED=false
ADMIN_USER_IDS=          # id do owner criado no passo 6

# ── URLs / portas
PORT_API=3001
NEXT_PUBLIC_API_URL=http://localhost:3001
PUBLIC_API_URL=http://localhost:3001
BACKOFFICE_URL=http://localhost:3000
NEXT_PUBLIC_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_STOREFRONT_URL=http://localhost:3011
STOREFRONT_ORIGIN=http://localhost:3011
LANDING_DOMAIN_SUFFIXES=     # ex.: .seudominio.com (domínios das landings aceitos no CORS da API)
LANDINGLAB_PROXY_SECRET=     # ≥ 32 chars, igual no backoffice e no storefront

# ── Clonar / gerar com IA (deixe vazio o que não for usar)
LANDINGLAB_ANTHROPIC_KEY=
LANDINGLAB_GEMINI_KEY=
GEMINI_API_KEY=
LANDINGLAB_FREEPIK_KEY=
FREEPIK_API_KEY=
LANDINGLAB_FIRECRAWL_KEY=
LANDINGLAB_PERPLEXITY_KEY=
LANDINGLAB_SERPAPI_KEY=
LANDINGLAB_APIFY_TOKEN=

# ── Domínios e publicação
PORKBUN_API_KEY=
PORKBUN_SECRET_API_KEY=
LANDINGLAB_SPACESHIP_API_KEY=
VERCEL_TOKEN=                    # token com acesso ao projeto do storefront
VERCEL_TEAM_ID=                  # vazio se a conta Vercel for pessoal
VERCEL_STOREFRONT_PROJECT_ID=    # id/nome do projeto Vercel do landinglab-storefront
LANDINGLAB_VERCEL_TOKEN=
LANDINGLAB_VERCEL_PROJECT_ID=

# ── Seed
SEED_STORE_ID=           # opcional; vazio = primeira loja do banco (ou cria a loja "LandingLab")
```

A lista completa do que o código lê sai com:
`grep -rhoE "process\.env(\.|\[['\"])[A-Z0-9_]+" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules | sort -u`.

## 4. Playwright (worker)

```bash
pnpm --filter @blackshop/landinglab-cloner exec playwright install --with-deps chromium
```

## 5. Banco e storage

```bash
pnpm db:migrate
```

Aplica `packages/db/migrations` (drizzle) e depois `packages/db/post-migrations`. **Não pule migrations**: o schema
é o completo do sistema original (há tabelas fora do escopo, mas as FKs dependem delas).

No Supabase → Storage, crie os buckets (**públicos**):

- `cloned-landings`: assets e imagens das landings (obrigatório para clonar/editar)
- `landing-exports`: ZIPs do botão Exportar
- `product-images`: imagens de produto/oferta

## 6. Primeiro usuário (owner)

```bash
OWNER_PASSWORD='uma senha forte com 12+ caracteres' pnpm create-owner voce@exemplo.com "Seu Nome"
```

Coloque o id impresso em `ADMIN_USER_IDS` no `.env`. Para o `APP_PASSWORD_HASH` (obrigatório na API; com
`LEGACY_LOGIN_ENABLED=false` ele não dá acesso):
`pnpm --filter @blackshop/api exec node -e "require('bcrypt').hash(require('crypto').randomBytes(24).toString('hex'),10).then(console.log)"`.

## 7. Primeira landing (opcional)

Para criar a primeira landing, use o **Gerar ou clonar** no painel com a URL da página de origem.

Para trazer uma landing pronta de outro banco (ex.: o sistema original):

```bash
DATABASE_URL='<banco de origem>' node packages/db/scripts/export-landing.mjs <landing_id> seed/<nome>/landing.json
pnpm --filter @blackshop/db db:seed ../../seed/<nome>/landing.json   # usa o DATABASE_URL do .env (banco novo)
```

Idempotente. Entra como **rascunho**, sem domínio. As imagens continuam apontando para o storage do banco de origem.

## 8. Rodar

```bash
pnpm dev     # api :3001 + worker + backoffice :3000 + storefront :3011
```

Abra http://localhost:3000, entre com o owner, vá em **LandingLab → Landings** e clone uma página em **Gerar ou clonar**.

Checagens:
- `curl localhost:3001/health` → ok
- Worker: o log mostra os 11 workers `landinglab.*` conectados ao Redis
- "Gerar ou clonar" com uma URL → a landing aparece na lista e sai de "processando"

## 9. Produção

- **Backoffice** e **Storefront**: dois projetos Vercel (root directory `apps/backoffice` e `apps/landinglab-storefront`,
  framework Next.js, install `pnpm install`). Copie as variáveis do `.env` (sem `NODE_ENV`). O storefront precisa
  de `DATABASE_URL`, `LANDINGLAB_PROXY_SECRET`, `NEXT_PUBLIC_API_URL`. Os domínios das landings são anexados ao
  projeto do storefront (ver `VERCEL_STOREFRONT_PROJECT_ID`).
- **Worker**: Railway (ou qualquer Docker) com `apps/worker/Dockerfile` (contexto = raiz do repo; já tem `railway.json`).
- **API**: Railway/Render com start `pnpm --filter @blackshop/api start` (Node 22, contexto = raiz).
- `NEXT_PUBLIC_API_URL`/`CORS_ORIGIN`/`BACKOFFICE_URL` passam a apontar para as URLs públicas.

## 10. Testes

```bash
pnpm typecheck   # deve passar inteiro
pnpm test
```

Falhas conhecidas (já existiam no sistema original ou dependem de partes fora do escopo):
`pricing/format-price` (3), `landinglab-build/orchestrator` (2), `vsl-hosting` (import + errors-doc) e
`shared` (`external-checkout` paridade VSL, `no-raw-fetch` inventário).

## Fora do escopo (não vem neste repo)

Checkout próprio (Stripe), pedidos e pós-venda, suporte, publicar produto na Shopify, Modo esqueleto, VSL, Meta/CAPI,
catálogo de ofertas, TrustShield, importador de produtos. No storefront, as rotas `/checkout`, `/rastreio` e
`/assinatura` existem mas dependem de rotas de API que não vieram. Os botões das landings devem usar link externo
(checkout do produtor) configurado no editor.
