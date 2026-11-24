import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  detectTheme,
  extractCheerioBase,
  extractSkeleton,
  ExtractedSourceJsonSchema,
  type SkeletonExtractResult,
  type SkeletonVisionCaller,
} from '../src/agents/skeleton-extractor.js';

const FIXTURES = join(__dirname, '__fixtures__');

async function loadFixture(name: string): Promise<string> {
  return await fs.readFile(join(FIXTURES, name), 'utf8');
}

describe('detectTheme (AC6)', () => {
  it('classifica bepurex landing como bepurex', async () => {
    const html = await loadFixture('bepurex-landing.html');
    expect(detectTheme(html)).toBe('bepurex');
  });
  it('classifica bepurex advertorial como bepurex', async () => {
    const html = await loadFixture('bepurex-advertorial.html');
    expect(detectTheme(html)).toBe('bepurex');
  });
  it('classifica kaching landing como kaching', async () => {
    const html = await loadFixture('kaching-landing.html');
    expect(detectTheme(html)).toBe('kaching');
  });
  it('classifica aurivita landing como aurivita', async () => {
    const html = await loadFixture('aurivita-landing.html');
    expect(detectTheme(html)).toBe('aurivita');
  });
  it('classifica HTML sem markers conhecidos como unknown', () => {
    expect(detectTheme('<html><body><h1>Plain</h1></body></html>')).toBe('unknown');
  });
  it('detecta shopify-default via cdn.shopify.com', () => {
    const html = '<html><body><img src="//cdn.shopify.com/x.jpg"></body></html>';
    expect(detectTheme(html)).toBe('shopify-default');
  });
});

describe('extractCheerioBase — Bepurex Landing (AC5)', () => {
  it('extrai copy, imagery, commerce e brand hints', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const base = extractCheerioBase(html, 'bepurex');
    expect(base.copy.hero_headline).toContain('Bepurex Formula');
    expect(base.copy.benefit_bullets.length).toBeGreaterThanOrEqual(3);
    expect(base.copy.faq.length).toBe(3);
    expect(base.copy.faq[0]!.q).toContain('Come si assume');
    expect(base.commerce.reviews.length).toBe(2);
    expect(base.commerce.reviews[0]!.rating).toBe(5);
    expect(base.commerce.bundles.length).toBe(3);
    expect(base.commerce.bundles[0]!.price_cents).toBe(4900);
    expect(base.commerce.bundles[1]!.compare_at_cents).toBe(14700);
    expect(base.commerce.currency).toBe('EUR');
    expect(base.commerce.badges.length).toBeGreaterThan(0);
    expect(base.imagery.hero_url).toContain('main.jpg');
    expect(base.imagery.gallery_urls.length).toBeGreaterThanOrEqual(3);
    expect(base.imagery.logo_url).toContain('logo.svg');
  });

  it('produz schema válido', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const base = extractCheerioBase(html, 'bepurex');
    const parsed = ExtractedSourceJsonSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });
});

describe('extractCheerioBase — Bepurex Advertorial (AC5)', () => {
  it('captura seções advertorial (timeline, doctors)', async () => {
    const html = await loadFixture('bepurex-advertorial.html');
    const base = extractCheerioBase(html, 'bepurex');
    expect(base.copy.hero_headline).toContain('Marco');
    expect(base.copy.faq.length).toBe(3);
    expect(base.commerce.reviews.length).toBe(3);
    // lifestyle URLs vem de .cc-cis__image e .cc-expert-quote__image
    expect(base.imagery.lifestyle_urls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('extractCheerioBase — Kaching Landing (AC5)', () => {
  it('extrai bundles Kaching corretamente', async () => {
    const html = await loadFixture('kaching-landing.html');
    const base = extractCheerioBase(html, 'kaching');
    expect(base.commerce.bundles.length).toBe(3);
    expect(base.commerce.bundles[0]!.price_cents).toBe(3900);
    expect(base.commerce.bundles[1]!.price_cents).toBe(9900);
    expect(base.commerce.bundles[1]!.compare_at_cents).toBe(11700);
    // spr-review parsing
    expect(base.commerce.reviews.length).toBe(3);
  });
});

describe('extractCheerioBase — Aurivita Landing (AC5+AC6)', () => {
  it('extrai bundles em alemão e detecta aurivita', async () => {
    const html = await loadFixture('aurivita-landing.html');
    expect(detectTheme(html)).toBe('aurivita');
    const base = extractCheerioBase(html, 'aurivita');
    expect(base.commerce.bundles.length).toBe(3);
    expect(base.commerce.bundles[0]!.price_cents).toBe(4500);
    expect(base.copy.benefit_bullets.length).toBeGreaterThanOrEqual(3);
    expect(base.imagery.logo_url).toContain('logo.svg');
  });
});

// ─── extractSkeleton — full pipeline via htmlOverride (AC2+AC12+AC4) ─────────

describe('extractSkeleton — htmlOverride path (AC2, FR-30)', () => {
  it('retorna resultado válido com Vision desativado', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      targetSkeleton: 'landing',
      disableVision: true,
    });
    expectValidResult(result);
    expect(result.themeFingerprint).toBe('bepurex');
    expect(result.raw.detectedLanguage).toBe('it');
    expect(result.extracted.meta.partial).toBe(true);
    expect(result.degradedFields).toContain('vision.hero_url');
    // Trace tem passos esperados
    const steps = result.trace.map((t) => t.step);
    expect(steps).toContain('render-override');
    expect(steps).toContain('cheerio-extract');
    expect(steps).toContain('vision-skipped');
    expect(steps).toContain('zod-validate');
  });

  it('detecta alemão via <html lang="de"> (AC9)', async () => {
    const html = await loadFixture('aurivita-landing.html');
    const result = await extractSkeleton({
      url: 'https://example.com/aurivita/landing-de',
      htmlOverride: html,
      targetSkeleton: 'landing',
      disableVision: true,
    });
    expect(result.raw.detectedLanguage).toBe('de');
    expect(result.extracted.meta.detected_language).toBe('de');
  });
});

describe('extractSkeleton — Vision path mocked (AC7, AC11)', () => {
  it('injeta dynamic_extras retornados pelo Vision mock', async () => {
    const html = await loadFixture('bepurex-advertorial.html');
    const visionCaller: SkeletonVisionCaller = vi.fn().mockResolvedValue(
      JSON.stringify({
        hero_url_candidate: null,
        logo_url_candidate: null,
        detected_language: 'it',
        dynamic_extras: [
          {
            kind: 'story',
            heading: 'Timeline settimanale',
            payload: { steps: 3 },
            llm_verdict: 'recommended',
            llm_reason: 'Reforço narrativo settimana 1 → 6',
          },
          {
            kind: 'stats',
            heading: 'Numeri chiave',
            payload: {},
            llm_verdict: 'optional',
            llm_reason: 'Adicional mas não crítico',
          },
        ],
      }),
    );

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/advertorial-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'advertorial',
      visionCaller,
    });

    expect(visionCaller).toHaveBeenCalledTimes(1);
    expect(result.extracted.dynamic_extras.length).toBe(2);
    expect(result.extracted.dynamic_extras[0]!.kind).toBe('story');
    expect(result.extracted.dynamic_extras[0]!.llm_verdict).toBe('recommended');
    expect(result.extracted.meta.partial).toBe(false);
    expect(result.degradedFields).not.toContain('vision.hero_url');
    // Trace tem passo vision-gemini
    const visionStep = result.trace.find((t) => t.step === 'vision-gemini');
    expect(visionStep).toBeDefined();
    expect(visionStep!.provider).toBe('vision-gemini');
  });

  it('limita dynamic_extras a max 3 (AC4)', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const visionCaller: SkeletonVisionCaller = vi.fn().mockResolvedValue(
      JSON.stringify({
        dynamic_extras: [
          { kind: 'story', heading: 'A', payload: {}, llm_verdict: 'recommended', llm_reason: 'a' },
          { kind: 'stats', heading: 'B', payload: {}, llm_verdict: 'recommended', llm_reason: 'b' },
          { kind: 'gallery', heading: 'C', payload: {}, llm_verdict: 'optional', llm_reason: 'c' },
          { kind: 'comparison', heading: 'D', payload: {}, llm_verdict: 'skip', llm_reason: 'd' },
          { kind: 'before_after', heading: 'E', payload: {}, llm_verdict: 'recommended', llm_reason: 'e' },
        ],
      }),
    );

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'landing',
      visionCaller,
    });
    expect(result.extracted.dynamic_extras.length).toBeLessThanOrEqual(3);
  });
});

describe('extractSkeleton — Vision fallback + retry (AC8, ADDENDUM v1.2)', () => {
  it('retenta 1x e depois entra em modo degradado', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const visionCaller = vi.fn(async () => {
      throw new Error('rate limited');
    });

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'landing',
      visionCaller,
    });

    expect(visionCaller).toHaveBeenCalledTimes(2); // 1 primary + 1 backoff retry
    expect(result.extracted.meta.partial).toBe(true);
    expect(result.degradedFields).toContain('vision.hero_url');
    expect(result.degradedFields).toContain('vision.dynamic_extras_verdict');
    // Cheerio-derived fields sobrevivem
    expect(result.extracted.commerce.bundles.length).toBe(3);
    expect(result.extracted.copy.faq.length).toBe(3);
    // Trace registra a falha
    const failStep = result.trace.find((t) => t.step === 'vision-failed');
    expect(failStep).toBeDefined();
  }, 15_000);

  it('tolera Vision retornando JSON inválido (partial vazio)', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const visionCaller: SkeletonVisionCaller = vi
      .fn()
      .mockResolvedValue('not json at all');

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'landing',
      visionCaller,
    });

    expect(visionCaller).toHaveBeenCalledTimes(1);
    // JSON inválido → parsed vazio (não trata como falha total)
    expect(result.extracted.dynamic_extras).toEqual([]);
    expect(result.extracted.meta.partial).toBe(false);
  });
});

describe('extractSkeleton — storage uploader (AC10)', () => {
  it('chama uploader com bucket e path corretos', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const uploader = vi.fn().mockResolvedValue({ path: 'test/x/screenshot.jpg' });

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'landing',
      landingId: 'landing-abc123',
      storageUploader: uploader,
      disableVision: true,
    });

    expect(uploader).toHaveBeenCalledTimes(1);
    const call = uploader.mock.calls[0]![0]!;
    expect(call.bucket).toBe('skeleton-source-snapshots');
    expect(call.path).toMatch(/^landing-abc123\/\d+\/screenshot\.jpg$/);
    expect(call.contentType).toBe('image/jpeg');
    expect(result.raw.screenshotPath).toBe('test/x/screenshot.jpg');
  });

  it('degrada silenciosamente quando uploader falha', async () => {
    const html = await loadFixture('bepurex-landing.html');
    const uploader = vi.fn().mockRejectedValue(new Error('bucket unavailable'));

    const result = await extractSkeleton({
      url: 'https://example.com/bepurex/landing-it',
      htmlOverride: html,
      screenshotOverride: makeFakeScreenshot(),
      targetSkeleton: 'landing',
      storageUploader: uploader,
      disableVision: true,
    });

    expect(result.raw.screenshotPath).toBe('');
    expect(result.degradedFields).toContain('storage.screenshot');
    expect(result.extracted.meta.partial).toBe(true);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function expectValidResult(result: SkeletonExtractResult): void {
  expect(result).toBeDefined();
  expect(result.raw).toBeDefined();
  expect(result.extracted).toBeDefined();
  expect(result.themeFingerprint).toBeDefined();
  expect(result.trace).toBeDefined();
  expect(Array.isArray(result.trace)).toBe(true);
  const parsed = ExtractedSourceJsonSchema.safeParse(result.extracted);
  expect(parsed.success).toBe(true);
}

/** Buffer JPEG mínimo válido (header FF D8 FF + magic-like body) —
 * suficiente pra detectImageMime distinguir e passar guard de size. */
function makeFakeScreenshot(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}
