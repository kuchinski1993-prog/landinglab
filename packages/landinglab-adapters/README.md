# @blackshop/landinglab-adapters

Foundation package pra Theme Adapters do Landing Lab. Consumido pelo worker
(a partir da sub-fase 10.4) e futuramente pelo backoffice/editor.

**Status:** Foundation (Fase 10.2). Nenhum adapter concreto implementado
ainda — apenas tipos, resolver e registry.

**ADR:** `docs/architecture/adr-001-theme-adapter-contract.md`

---

## O que este package é

Um contrato explícito de como landings clonadas são **classificadas
semanticamente**. Adapter reconhece o tema (Kaching, Aurivita, PSS, …) e extrai
regiões, campos editáveis e elementos não classificados — **sem mutar HTML,
sem tocar dados canônicos, sem renderizar**.

## O que este package NÃO é

- Não é renderer. Renderers (`renderBundleOffers`, `renderProductJson`,
  `renderCurrencyConfig`) permanecem no `apps/worker`.
- Não é editor. Editor consome `EditableField[]` que este package produz,
  mas UI vive em `apps/backoffice`.
- Não conhece Shopify.
- Não faz PDP stripping.

Ver ADR-001 §4 pra separação de responsabilidades.

---

## API pública

```
import {
  // Types
  type PageFamily,
  type SemanticRegion,
  type SemanticRegionKind,
  type EditableField,
  type DetectionResult,
  type ExtractionResult,
  // Contract
  type ThemeAdapter,
  type AdapterInput,
  // Resolver
  resolve,
  INITIAL_THRESHOLDS,
  // Registry
  createAdapterRegistry,
} from '@blackshop/landinglab-adapters';
```

## Uso previsto (sub-fase 10.4+)

```
const registry = createAdapterRegistry();
registry.register(kachingAdapter); // 10.3
registry.freeze();

const result = resolve(
  { html: sourceHtml, hintedAdapterId: landing.bundleAdapter },
  registry.list(),
);

if (result.resolution === 'confident') {
  const extraction = result.chosen.extract({ html: sourceHtml });
  // → regions, editableFields, unclassified, warnings
} else {
  // 'ambiguous' | 'no_match' → fallback pipeline legado (Fase 10)
  // Log obrigatório com adapterResolution + authority + fallbackReason (A4)
}
```

## Thresholds

`INITIAL_THRESHOLDS` são **valores iniciais de calibração** — não invariantes
permanentes. Shadow mode (10.4) coletará evidência estrutural
(`adapterInputFingerprint` distintos) + operacional (comparison.match) antes
de qualquer ajuste. Ver ADR-001 A1, A2 e §8.3.

## Testes

```
pnpm --filter @blackshop/landinglab-adapters test
pnpm --filter @blackshop/landinglab-adapters typecheck
```
