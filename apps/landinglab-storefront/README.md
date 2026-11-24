# @blackshop/landinglab-storefront

Storefront público Next.js 14 (app router) das landing pages LandingLab. Serve
landings por multi-domain routing — 1 hostname = 1 landing.

## Portas

- **Dev:** `3011`

## Rodando localmente

```bash
# Da raiz do monorepo:
pnpm install
pnpm --filter @blackshop/landinglab-storefront dev

# Abrir http://localhost:3011
```

## Variáveis de ambiente

Ver `.env.example`. Env vars vivem em `.env` / `.env.local` na raiz do monorepo.

### Rate-limit por cliente nas chamadas storefront → API (QA 15.3 PERF-002 / 15.4 SEC-001)

| Variável | Onde | Padrão | Uso |
|---|---|---|---|
| `LANDINGLAB_PROXY_SECRET` | storefront (Vercel) **e** API (Railway), mesmo valor | — (desligado) | Segredo (≥ 32 caracteres) com que o storefront assina o IP do cliente (`x-ll-client-ip` + `x-ll-client-ip-sig`, HMAC-SHA256 de `ll-client-ip:<ip>`). A API usa esse IP no rate-limit. Sem o segredo, todas as chamadas server-side do storefront caem no bucket do IP de saída da Vercel. |
| `TRUST_PROXY_HOPS` | API | `1` em produção, desligado fora dela | Nº de proxies confiáveis à frente da API (Fastify `trustProxy`). Railway = 1. Nunca use `true`: o IP mais à esquerda do `X-Forwarded-For` é escolhido pelo cliente. |

Gere o segredo com `openssl rand -hex 32` e configure nos dois serviços antes do deploy.

## Comandos

```bash
pnpm --filter @blackshop/landinglab-storefront dev         # dev server (porta 3011)
pnpm --filter @blackshop/landinglab-storefront build       # build de produção
pnpm --filter @blackshop/landinglab-storefront start       # roda o build (porta 3011)
pnpm --filter @blackshop/landinglab-storefront typecheck   # tsc --noEmit
pnpm --filter @blackshop/landinglab-storefront lint        # next lint
```

## Escopo desta story (13.1)

Apenas scaffolding + placeholder de middleware. Multi-domain routing (13.5),
render de landing + sanitize real (13.6) e Stripe Checkout (13.8) virão nas
próximas stories.
