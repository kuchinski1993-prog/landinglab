# @blackshop/landinglab-copy

**Propósito:** Squad 2 (Copy High-Conversion) do pipeline LandingLab. Recebe o PIR da Squad 1 e produz um `CopyDeck` validado — hooks, benefits, CTAs, FAQs, offer stack e social proof — combinando 5 frameworks de copywriting via agents especializados.

## API pública

```ts
import {
  runCopySquad,
  CopyDeckSchema,
  validateCopyDeck,
} from '@blackshop/landinglab-copy';
```

### `runCopySquad(input, deps)`

Orquestra 5 copywriters (Hormozi, Schwartz, Halbert, Cialdini, Voss) + Copy Chief que consolida os outputs num único `CopyDeck` validado.

```ts
const output = await runCopySquad(
  { landingPageId, pir, language: 'pt-BR', awarenessStage: 'problem-aware' },
  { claudeText },
);
// output.copyDeck → CopyDeck validado; output.trace → CopyTraceEntry[]
```

### `CopyDeckSchema` / `validateCopyDeck(data)` / `CopyDeckValidationError`

Schema Zod do CopyDeck + validador tipado. Consumido por Squad 3 (Visual) e Squad 4 (Build). Cobre `Hook`, `BenefitBullet`, `Cta`, `FaqItem`, `OfferStack`, `SocialProofBlock`.

### Enums exportados

`CopyLanguageEnum`, `AwarenessStageEnum`, `FrameworkSourceEnum`, `UrgencyTypeEnum`, `CtaVariantEnum`, `SocialProofTypeEnum`, `VossTechniqueEnum` — todos Zod enums pra strong typing em consumers.

### Agent runners individuais

`runHormoziAgent`, `runSchwartzAgent`, `runHalbertAgent`, `runCialdiniAgent`, `runVossAgent`, `runCopyChief` — expostos pra testes e composição custom.

### `createClaudeTextClient(config)`

Factory do client Anthropic usado por todos os 6 agents. Erros tipados: `ProviderConfigError`, `ProviderHttpError`, `NotImplementedError`.

## Deps externos

- Anthropic Claude — `ANTHROPIC_API_KEY` — Opus 4.7 (Copy Chief) + Haiku 3.5 (copywriters)
- `@blackshop/landinglab-research` — consumido pra typing do `Pir`

## Como testar

```bash
pnpm --filter @blackshop/landinglab-copy test
```

## Ver também

- Story: `docs/stories/13.4.landinglab-copy-squad.story.md`
- Worker processor consumidor: `apps/worker/src/processors/landinglab-copy.processor.ts`
- Prompts: `packages/landinglab-copy/src/prompts/`
