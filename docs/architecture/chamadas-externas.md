# Chamadas externas — inventário de `fetch(` (Story 18.2)

Toda chamada da BlackShop a um serviço de terceiros deve ter **prazo**, **retry só quando é seguro**
e **erro classificado**. O padrão é o cliente de `@blackshop/shared/http`:

```ts
import { createHttpClient } from '@blackshop/shared/http';

const shopify = createHttpClient({ label: 'shopify-admin', timeoutMs: 15_000 }); // prazo obrigatório
const { response, attempts } = await shopify.request(url, { method: 'POST', body }, { idempotent: false });
```

- **429** → repete sempre (o terceiro não processou), esperando `max(backoff, Retry-After)` com teto.
- **5xx / rede / timeout** → repete **só** em chamada idempotente (GET/HEAD/OPTIONS, `idempotent: true`
  ou header `Idempotency-Key`). Não idempotente → **uma** tentativa e erro `kind: 'uncertain'`
  (nunca reenviar às cegas; reconciliação é da 18.3).
- **4xx (≠ 429)** → nunca repete: `UpstreamRejectedError` (`kind: 'permanent'`).
- Erros: `UpstreamTimeoutError` (504), `UpstreamRateLimitedError` (503 + `Retry-After`),
  `UpstreamUnavailableError` (503), `UpstreamRejectedError` (502) — todos `UpstreamError` com
  `label`, `kind`, `attempts`; mensagens sem URL, token ou corpo. Nas rotas, a resposta tipada sai por
  `replyUpstreamFailure` (`apps/api/src/lib/integration-mode.ts`); códigos em `docs/architecture/erros.md`.
- `httpErrors: 'return'` mantém o contrato de um cliente antigo: o cliente cuida do prazo e do retry e
  devolve a resposta final para o chamador mapear nas mensagens de sempre.
- URL vinda do usuário (import, "Importar de um link") → `safeFetch` de `@blackshop/shared/http/safe-fetch`
  (SSRF: DNS checado, conexão no IP validado, redirects revalidados, corpo limitado). Só servidor.

## Clientes já no padrão

| Arquivo | Serviço | Como |
|---|---|---|
| `packages/shared/src/http/client.ts` | — | o próprio cliente (`createHttpClient`) |
| `packages/shared/src/http/safe-fetch.ts` | URL pública do usuário | `safeFetch` (o VSL reexporta: `packages/vsl-hosting/src/safe-fetch.ts`) |
| `packages/shopify-adapter/src/real.adapter.ts` | Shopify Admin GraphQL (publicação, preços) | 4 tentativas em 429/503, backoff sem jitter, Retry-After ≤ 60 s; mutation com timeout/503 → `uncertain`, sem retry. **Nota (Story 18.3b):** a republicação (`existingProductGid`) casa variantes por `mirror_variant_id` — regras R1 vínculo → R2 opções normalizadas únicas → R3 1↔1 → R4 criar novas/remover órfãs (só órfã do BlackShop — SKU da família do produto `BS-xxxxxx-NNN`; variante criada à mão na Shopify → recusa `shopify.variant_plan_foreign_orphan`, QA 18.3b); plano calculado antes de qualquer escrita, plano recusado (`ShopifyVariantPlanError`) não escreve nada; chamador sem o campo (LandingLab) segue posicional |
| `packages/shopify-storefront/src/real.client.ts` | Shopify Storefront (`cartCreate`) | 1 tentativa (não idempotente); 429/5xx/4xx tipados |
| `apps/api/src/lib/shopify-admin-client.ts` | Shopify Admin GraphQL (rotas `/admin/shopify/*`, disputes) | 1 tentativa; erros classificados (`httpErrors: 'throw'`) |
| `packages/vault/src/vault.ts` | Shopify OAuth (renovação do token Admin) | 1 tentativa, idempotente (timeout não incerto); mensagens de sempre |
| `apps/worker/src/processors/orders-backfill.processor.ts` | Shopify Admin REST (backfill de pedidos) | 4 tentativas por página em 429/5xx/rede/timeout; esperas fatiadas com `job.updateProgress` via `sleep` |
| `packages/importer/src/layers/shopify.layer.ts` (+ `importer.ts`) | JSON público da loja de origem / HTML | 1 tentativa; `fetchWithTimeout(url, timeoutMs)` exportado mantido |
| `packages/landinglab-domains/src/vercel.ts` | Vercel Domains API | 3 tentativas em 429/5xx (500 ms, 1 s); attach/remove declarados idempotentes |
| `apps/worker/src/lib/frankfurter.ts` | Frankfurter (câmbio ECB) | 1 tentativa; mensagens `FxProviderError` de sempre |
| `apps/api/src/routes/products.routes.ts` | Supabase Storage (limpeza de imagens na exclusão definitiva de produto — Story 18.6a) | 1 tentativa (DELETE sem retry), 10 s (`SUPABASE_STORAGE_TIMEOUT_MS`), `httpErrors: 'return'`; falha vira `warn` (`count`/`status`) e `storageCleanup: 'failed'` na resposta, sem derrubar a exclusão |
| `apps/api/src/lib/atendimento-readiness.ts` | Resend Domains API (prontidão do Atendimento, Story 17.6d) | 1 tentativa, 3 s, `httpErrors: 'return'`; qualquer falha vira item `unknown` (nunca 5xx) |
| `apps/worker/src/lib/meta-capi-sender.ts` | Meta Conversions API do Marketing (Purchase Stripe, Lead, `/tracking/event` — Story 18.8) | 1 tentativa, 10 s, `httpErrors: 'return'`, idempotente (`event_id`); versão `META_GRAPH_API_VERSION` (default `v26.0`); o retry é do job `marketing-capi-queue` |

## Inventário de `fetch(` cru (código de produção)

Gerado pela mesma varredura do teste `packages/shared/src/__tests__/no-raw-fetch.test.ts`
(apps/* e packages/*, sem testes, builds e linhas de comentário; uma ocorrência por linha). O teste
falha se esta tabela e o código divergirem — `fetch(` novo precisa ser classificado aqui (ou, melhor,
usar o cliente).

Status: **protegido** = zona protegida, sem diff; **interno** = chamada à própria API da BlackShop
(navegador/SSR ou script injetado), não é terceiro; **pendente → story** = terceiro, migra na story do
módulo; **fora** = decisão registrada de não migrar.

| Arquivo | `fetch(` | Destino | Status |
|---|---|---|---|
| `apps/api/src/routes/reviews.routes.ts` | 1 | Anthropic (geração de reviews) | pendente → 18.6 |
| `apps/api/src/scripts/vsl-video.ts` | 1 | VSL (capability de upload TUS) | fora — VSL fica como está (Decisão 7) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/StripeSubsConfig.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/SubsConfig.tsx` | 3 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/edit/EditorClient.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/edit/VersionsModal.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/EditorPanel.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/BundlesSection.tsx` | 5 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/CheckoutAppearance.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/CheckoutSection.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/CtasSection.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/DomainsSection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/HistorySection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/LanguageSection.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/PriceSection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/ProductImagesSection.tsx` | 4 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/editor/sections/PublishSection.tsx` | 4 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/publish-client.ts` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/semantic/SemanticShellPanel.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/skeleton-edit/modals/IdentityModal.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/[id]/skeleton-edit/modals/LogoOptionsModal.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/domains/PurchaseDomainModal.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/domains/page.tsx` | 4 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/landing-pages/new/page.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/(dashboard)/skeleton-mode/SkeletonModeClient.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/app/api/admin/shopify-auth-check/route.ts` | 1 | Shopify Admin (rota server do backoffice) | pendente → 18.6 |
| `apps/backoffice/src/app/api/admin/shopify/selling-plans/route.ts` | 1 | Shopify Admin (rota server do backoffice) | pendente → 18.6 |
| `apps/backoffice/src/app/api/landing-cta/auto-bind/route.ts` | 1 | Script injetado no HTML da landing → API da BlackShop | interno (roda no navegador do comprador) |
| `apps/backoffice/src/app/api/landing-domains/porkbun-configure-dns/route.ts` | 2 | Porkbun / Vercel (domínios LandingLab) | pendente → 18.9 |
| `apps/backoffice/src/lib/api-client.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/lib/porkbun/client.ts` | 1 | Porkbun / Vercel (domínios LandingLab) | pendente → 18.9 |
| `apps/backoffice/src/lib/session.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/backoffice/src/lib/vsl-tus.ts` | 1 | VSL (capability de upload TUS) | fora — VSL fica como está (Decisão 7) |
| `apps/landinglab-storefront/src/app/api/apple-pay-domain/route.ts` | 1 | Stripe (arquivo de domínio Apple Pay) | pendente → 18.9 |
| `apps/landinglab-storefront/src/app/assinatura/SubscriptionClient.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/landinglab-storefront/src/app/checkout/[token]/CheckoutClient.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/landinglab-storefront/src/app/landing/[host]/[[...slug]]/route.ts` | 3 | Script injetado no HTML da landing → API da BlackShop | interno (roda no navegador do comprador) |
| `apps/landinglab-storefront/src/app/rastreio/TrackingClient.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/landinglab-storefront/src/lib/checkout-api.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/app/api/fx-rates/route.ts` | 1 | open.er-api.com (câmbio da vitrine) | pendente → 18.6 |
| `apps/storefront/src/app/cart/page.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/app/portal/lib/api.ts` | 6 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/app/refunds/RefundForm.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/app/refunds/[ticketId]/RefundStatus.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/CartDrawer.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/CartItemImage.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/CartProvider.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/ContactForm.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/DiscountPopup.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/PixelScript.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/PixelTracker.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/SizeGuideLinks.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/TrackOrderForm.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/CollectionProductsClientSection.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/ProductCarouselSection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/ProductDetailsPreviewSection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/ProductDetailsSection.tsx` | 5 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/ProductGridClientSection.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/product-details/PairWellWith.tsx` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/components/sections/product-details/SizeGuideModal.tsx` | 2 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/lib/api.ts` | 7 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/lib/attribution.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/lib/store-settings.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/storefront/src/lib/theme.ts` | 1 | API da BlackShop (navegador/SSR do próprio produto) | interno (não é terceiro) |
| `apps/worker/src/processors/image.processor.ts` | 1 | Download de imagem externa (import) | pendente → 18.6 |
| `apps/worker/src/processors/landinglab-apply-bundle.processor.ts` | 1 | Script injetado no HTML da landing → API da BlackShop | interno (roda no navegador do comprador) |
| `packages/email/src/provider.ts` | 1 | Resend (e-mail) | protegido (zona protegida — sem diff) |
| `packages/landinglab-cloner/src/agents/asset-downloader.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/agents/checkout-handler-injector.ts` | 1 | Script injetado no HTML da landing → API da BlackShop | interno (roda no navegador do comprador) |
| `packages/landinglab-cloner/src/agents/image-ocr-metadata.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/agents/image-relevance-classifier.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/agents/image-translator.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/orchestrator.ts` | 2 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/providers/freepik.ts` | 2 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/providers/gemini-image-edit.ts` | 2 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/providers/gemini-text.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-cloner/src/providers/gemini-vision.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-deploy/src/providers/porkbun.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-deploy/src/providers/spaceship.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-research/src/providers/apify.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-research/src/providers/firecrawl.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-research/src/providers/gemini-vision.ts` | 2 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-research/src/providers/perplexity.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-research/src/providers/serpapi.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-visual/src/providers/freepik.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/landinglab-visual/src/providers/higgsfield.ts` | 1 | LandingLab (IA, pesquisa, clone, domínio) | pendente → 18.9 |
| `packages/tracking/src/capi.client.ts` | 1 | Meta CAPI (`RealCAPIClient`, também do `tracker-capi`) | protegido (zona protegida — sem diff) |
| `packages/vault/src/testers/anthropic.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |
| `packages/vault/src/testers/resend.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |
| `packages/vault/src/testers/shopify-admin.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |
| `packages/vault/src/testers/shopify-app-credentials.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |
| `packages/vault/src/testers/shopify-storefront.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |
| `packages/vault/src/testers/supabase.tester.ts` | 1 | Teste de credencial (tela de Credenciais) | pendente → backlog (sem story; chamada única disparada pelo dono) |

## Exceções explícitas (zonas protegidas)

Nunca migradas nem editadas por esta story (decisão futura do owner, P1 da 18.2):
`packages/email/**`, `apps/api/src/routes/inbound-email.routes.ts`, `packages/tracking/src/capi.client.ts`
(`RealCAPIClient`/`createCAPIClient`, também usado pelo worker `tracker-capi`),
`apps/worker/src/processors/{tracker-capi,send-email,analyze-inbound}.processor.ts`, `apps/api/src/routes/tracker/*`,
`packages/tracker-engine/**`, `packages/trustshield/**`. Os chamadores livres da CAPI (Purchase, `/tracking/event`,
Lead) seguem com prazo via `createCapiClientFromEnv` (`packages/tracking/src/capi-env.ts`, story 0.8) — desde a
18.8 com o remetente próprio `apps/worker/src/lib/meta-capi-sender.ts` injetado em `realClient`, no worker.

## Pontos de rota ainda sem resposta tipada

Rotas `/admin/shopify/*` que não capturam o erro (`GET /admin/shopify/webhooks`,
`DELETE /admin/shopify/webhooks/:webhookId` e `GET /admin/shopify/selling-plans`) caem no fallback
intocado: 429 da Shopify agora sai **503** (efeito do `statusCode` do `UpstreamRateLimitedError`) em
vez de 500, sem corpo da Shopify na mensagem — **pendente → 18.5/18.7**. Observação: esses plugins são
registrados antes do `setErrorHandler` de `apps/api/src/server.ts`, então quem responde é o handler
padrão do Fastify (`{ statusCode, code, error, message }`), como já acontecia antes da 18.2.
