# @blackshop/landinglab-research

**Propósito:** Squad 1 (Product Research) do pipeline LandingLab AI Autopilot. Gera o PIR (Product Intelligence Report) a partir de uma URL de produto — insumo pras squads Copy/Visual/Build.

## API pública

```ts
import {
  runProductResearch,
  pirSchema,
  validatePir,
  calcOpportunityScore,
} from '@blackshop/landinglab-research';
```

### `runProductResearch(input, deps)`

Orquestra 6 agents (Spec Hunter, Review Miner, Market Analyst, Lens Scout, Vision Verifier, PIR Synthesizer) e retorna um PIR validado.

```ts
const output = await runProductResearch(
  { landingPageId, productUrl, marketRegion: 'BR' },
  { serpapi, firecrawl, apify, perplexity, claudeVision, geminiVision, cheerio },
);
// output.pir → Pir validado; output.trace → BuildAgentTrace[]
```

### `pirSchema` / `validatePir(data)` / `PirValidationError`

Schema Zod do PIR + validador com erro tipado. Consumido por Squad 2 (Copy), Squad 3 (Visual) e Squad 4 (Build).

### `calcOpportunityScore(pir)`

Score 0-100 combinando `identity.confidence`, `market.opportunity` e sinais de VoC. Usado no gate `Unknown Product` do orchestrator.

### Providers

`createSerpApiClient`, `createFirecrawlClient`, `createApifyClient`, `createPerplexityClient`, `createClaudeVisionClient`, `createGeminiVisionClient`, `createCheerioClient` — factories dos clients HTTP. Cada uma valida env vars no boot; erros tipados via `ProviderConfigError` / `ProviderHttpError`.

### Agent runners (uso avançado)

`runSpecHunter`, `runReviewMiner`, `runMarketAnalyst`, `runLensScout`, `runVisionVerifier`, `runPirSynthesizer` — expostos pra testes e composição custom.

## Deps externos

- SerpAPI — `SERPAPI_KEY` — busca Google/Amazon (rate limit por plano)
- Firecrawl — `FIRECRAWL_KEY` — scraping com JS render (429 backoff embutido)
- Apify — `APIFY_TOKEN` — Actors de review (Amazon/AliExpress/Mercado Livre)
- Perplexity — `PERPLEXITY_KEY` — market intel via sonar-pro
- Anthropic Claude — `ANTHROPIC_API_KEY` — Vision + Sage (PIR Synthesizer, Opus 4.7)
- Google Gemini — `GEMINI_API_KEY` — Vision fallback (flash)
- Cheerio (in-process) — sem env var, fallback local pra scraping simples

## Como testar

```bash
pnpm --filter @blackshop/landinglab-research test
```

Smoke E2E manual: `scripts/2026-09-03-smoke-test-landinglab-keys/` e `scripts/2026-09-04-parijan-e2e/`.

## Ver também

- `docs/runbooks/landinglab-e2e-setup.md`
- Story: `docs/stories/13.3.landinglab-ai-foundation.story.md`
- Orquestração no worker: `apps/worker/src/processors/landinglab-research.processor.ts`
