# @blackshop/landinglab-cloner

**Propósito:** Squad 0 (Landing Cloner) da Fase 5. Clona uma landing existente por URL — renderiza com Playwright, baixa assets, reescreve URLs, sanitiza HTML — e opcionalmente traduz texto + imagens pra outro idioma.

## API pública

```ts
import { cloneLanding } from '@blackshop/landinglab-cloner';

const result = await cloneLanding({
  landingId,
  url: 'https://competitor.com/oferta',
  storageRoot: '/tmp/clones',
  publicPathPrefix: '/clones/abc',
});
// result.htmlPath, result.assets[], result.stats
```

### Fase 5.A — Clone literal

- `cloneLanding(input)` — orquestrador end-to-end. Emite `CloneProgressEvent` (opcional callback) e retorna `CloneResult` com paths de HTML + assets baixados.
- `renderPage(input)` — snapshot da página via Playwright (`RenderInput` → `RenderOutput`).
- `downloadAssets(input)` — baixa `<img>`, CSS, fontes; retorna `DownloadResult` com `DownloadedAsset[]`.
- `rewriteUrls(...)` — reescreve URLs absolutas no HTML pros paths locais/públicos.

### Fase 5.B — Text translator

- `translateHtml(input)` — traduz nós de texto do HTML preservando markup, via Gemini Flash.

```ts
const { html } = await translateHtml({ html: raw, sourceLang: 'en', targetLang: 'pt-BR' });
```

### Fase 5.C — Image translator (OCR + regen)

- `translateImages(input)` — pipeline OCR (Tesseract) → tradução (Gemini) → regen (Freepik Seedream) pra imagens com texto embutido. Emite `ImageTranslatorProgressEvent`.
- `editImageWithSeedream(input)` — chamada low-level do Seedream (edit por prompt).
- `runOcr(buffer, lang)` — Tesseract worker singleton; usa `toTesseractLang(bcp47)` pra converter locale.
- `terminateOcrWorkers()` — cleanup pra shutdown / teardown de testes.

## Deps externos

- Playwright (Chromium) — sem env var; requer `playwright install chromium` na primeira vez
- Tesseract.js — sem env var; workers rodam in-process (chame `terminateOcrWorkers()` em shutdown)
- Sharp — sem env var; usado pra crop/resize antes do OCR
- Cheerio + parse5 — parsing/rewrite de HTML
- Google Gemini — `GEMINI_API_KEY` — tradução de texto e prompts de imagem (flash)
- Freepik Seedream — `FREEPIK_API_KEY` — regeneração de imagens traduzidas (custo por edição)

## Como testar

```bash
pnpm --filter @blackshop/landinglab-cloner test
```

## Ver também

- Story: `docs/stories/13.x.landinglab-cloner-*` (fase 5.A/B/C)
- Sanitizer HTML: `@blackshop/landinglab-render`
