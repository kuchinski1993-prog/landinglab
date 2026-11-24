# @blackshop/landinglab-build

**Propósito:** Squad 4 (Build HTML) do pipeline LandingLab. Combina CopyDeck (Squad 2) + VisualAssets (Squad 3) num HTML final estático, otimizado e SEO-ready — pronto pra deploy pela Squad 5.

## API pública

```ts
import {
  runBuildSquad,
  validateBuildOutput,
  BuildOutputSchema,
} from '@blackshop/landinglab-build';
```

### `runBuildSquad(input, deps)`

Orquestra 5 agents (Template Selector, Content Composer, HTML Builder, SEO Optimizer, Performance Optimizer) + Build Chief que consolida o resultado final.

```ts
const output = await runBuildSquad(
  { landingPageId, pir, copyDeck, visualAssets, targetLocale: 'pt-BR' },
  { claudeHaiku },
);
// output.buildOutput → BuildOutput validado (html + metadata + seoTags)
// output.trace → BuildTraceEntry[]
```

### `BuildOutputSchema` / `validateBuildOutput(data)` / `BuildOutputValidationError`

Schema Zod do resultado final. Cobre `TemplateName`, `BuildMetadata`, `SeoScores`, `SeoTags` (OpenGraph, TwitterCard, hreflang).

### Agent runners individuais

`selectTemplate`, `composeSlots`, `buildHtml`, `generateSeoTags`, `optimizePerformance`, `runBuildChief` — expostos pra testes e composição custom.

### `createClaudeHaikuClient(config)`

Factory do client Anthropic Haiku 3.5 usado pelos 5 agents (Build Chief usa Opus 4.7 injetado separadamente). Erro tipado: `NotImplementedError` (Wave 1 stub).

## Deps externos

- Anthropic Claude — `ANTHROPIC_API_KEY` — Haiku 3.5 (agents) + Opus 4.7 (Build Chief)
- React 18 (SSR) — usado internamente pro render dos templates
- html-minifier-terser — minificação HTML/CSS/JS inline

## Como testar

```bash
pnpm --filter @blackshop/landinglab-build test
```

## Ver também

- Story: `docs/stories/13.6.landinglab-build-squad.story.md`
- Sanitizer HTML: `@blackshop/landinglab-render`
- Worker processor: `apps/worker/src/processors/landinglab-build.processor.ts`
