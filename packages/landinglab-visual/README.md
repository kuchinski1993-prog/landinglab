# @blackshop/landinglab-visual

**Propósito:** Squad 3 (Visual & Brand Forge) do pipeline LandingLab. A partir do PIR (Squad 1) e do CopyDeck (Squad 2), gera assets visuais: logo, paleta, tipografia, hero, lifestyle, ícones e social proof.

## API pública

```ts
import {
  runVisualSquad,
  VisualAssetsSchema,
  validateVisualAssets,
} from '@blackshop/landinglab-visual';
```

### `runVisualSquad(input, deps)`

Orquestra 6 agents (Visual Director, Brand Forge, Hero Designer, Lifestyle Composer, Icon Generator, Social Proof Designer). Retorna `VisualAssets` validado.

```ts
const output = await runVisualSquad(
  { landingPageId, pir, copyDeck, brandTone: 'trustworthy-modern' },
  { freepik, higgsfield, claudeText },
);
// output.visualAssets → VisualAssets validado; output.trace → VisualTraceEntry[]
```

### `VisualAssetsSchema` / `validateVisualAssets(data)` / `VisualAssetsValidationError`

Schema Zod completo (Brand, LogoUrls, BrandPalette, BrandTypography, Assets, Hero, HeroUrlsBySize, Icon). Consumido por Squad 4 (Build).

### `rejectsBannedBrands(text)` / `BANNED_BRAND_TERMS`

Guard anti-plágio de marca. Rejeita outputs que mencionem termos proibidos (concorrentes/trademarks). Aplicado dentro do orchestrator antes de aceitar assets.

### Providers

- `createFreepikProvider(config)` — imagens realistas (hero, lifestyle) via Freepik Mystic/Seedream
- `createHiggsfieldProvider(config)` — hero cinematográfico alternativo
- `createClaudeTextClient(config)` — prompts de direção visual (Brand Forge, Visual Director)

Erros tipados: `ProviderConfigError`, `ProviderHttpError`, `FreepikProviderError`, `HiggsFieldProviderError`, `NotImplementedError`.

### Agent runners individuais

`runVisualDirector`, `runBrandForge`, `runHeroDesigner`, `runLifestyleComposer`, `runIconGenerator`, `runSocialProofDesigner`.

### Prompt builders

`buildBrandForgeSystemPrompt`, `buildHeroDesignerSystemPrompt`, `buildLifestyleComposerSystemPrompt`, `buildIconGeneratorSystemPrompt`, `buildSocialProofDesignerSystemPrompt`.

## Deps externos

- Freepik — `FREEPIK_API_KEY` — image generation (custo por imagem, ~$0.02-0.10)
- HiggsField — `HIGGSFIELD_API_KEY` — hero video/still generation
- Anthropic Claude — `ANTHROPIC_API_KEY` — Opus 4.7 (Visual Director) + Haiku 3.5 (agents de direção)

## Como testar

```bash
pnpm --filter @blackshop/landinglab-visual test
```

## Ver também

- Story: `docs/stories/13.5.landinglab-visual-squad.story.md`
- Worker processor: `apps/worker/src/processors/landinglab-visual.processor.ts`
