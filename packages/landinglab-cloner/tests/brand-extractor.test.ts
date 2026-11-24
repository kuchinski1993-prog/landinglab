import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  collectCheerioColorHits,
  extractBrand,
  hexToHue,
  hueDelta,
  kmeans,
  mergePalette,
  type BrandExtractInput,
} from '../src/agents/brand-extractor.js';

// ─── DB mock (drizzle-shaped) ───────────────────────────────────────────────
// Minimalista o suficiente pra emular select().from().where().limit() +
// insert().values().onConflictDoNothing(). Retorna hit ou miss controlado.

// Extrai valor literal de um SQL clause do drizzle-orm.
// Formato observado: queryChunks contém StringChunk('...'), PgVarchar (col),
// StringChunk(' = '), Param(value), StringChunk(''). Extraímos .value do Param.
function extractQueryValue(clause: unknown): string | null {
  if (!clause || typeof clause !== 'object') return null;
  const chunks = (clause as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return null;
  for (const chunk of chunks) {
    if (typeof chunk === 'string') return chunk;
    if (chunk && typeof chunk === 'object') {
      const ctor = (chunk as { constructor?: { name?: string } }).constructor?.name;
      if (ctor === 'Param') {
        const value = (chunk as { value?: unknown }).value;
        if (typeof value === 'string') return value;
      }
    }
  }
  return null;
}

function makeMockDb(fixtureRows: Map<string, { google: string; llm: boolean }>) {
  const inserts: Array<{ source: string; google: string }> = [];

  const db = {
    select: () => ({
      from: () => ({
        where: (whereClause: unknown) => ({
          limit: async (_n: number) => {
            const value = extractQueryValue(whereClause);
            if (value && fixtureRows.has(value)) {
              const val = fixtureRows.get(value)!;
              return [
                {
                  sourceFontFamily: value,
                  googleFontFamily: val.google,
                  llmGenerated: val.llm,
                  weightMapping: '400,700',
                  notes: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (row: { sourceFontFamily: string; googleFontFamily: string }) => ({
        onConflictDoNothing: async (_opts?: unknown) => {
          inserts.push({ source: row.sourceFontFamily, google: row.googleFontFamily });
        },
      }),
    }),
    __inserts: inserts,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function writeTestScreenshot(colors: Array<[number, number, number]>): Promise<string> {
  // Gera imagem 100x100 divida em bandas horizontais com cores fixas —
  // permite testar k-means com centroids esperáveis.
  const width = 100;
  const height = 100;
  const bandHeight = Math.floor(height / colors.length);
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const bandIdx = Math.min(colors.length - 1, Math.floor(y / bandHeight));
    const color = colors[bandIdx];
    if (!color) continue;
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 3;
      buf[off] = color[0];
      buf[off + 1] = color[1];
      buf[off + 2] = color[2];
    }
  }
  const path = join(tmpdir(), `brand-extract-test-${Date.now()}-${Math.random()}.png`);
  await sharp(buf, { raw: { width, height, channels: 3 } }).png().toFile(path);
  return path;
}

// ─── Tests: k-means ─────────────────────────────────────────────────────────

describe('kmeans (AC4b)', () => {
  it('retorna k centroids ordenados por tamanho do cluster (dominante primeiro)', () => {
    // 100 pixels vermelhos + 50 azuis + 20 verdes → expected order red, blue, green
    const pixels = [
      ...Array(100).fill({ r: 250, g: 5, b: 5 }),
      ...Array(50).fill({ r: 5, g: 5, b: 250 }),
      ...Array(20).fill({ r: 5, g: 250, b: 5 }),
    ];
    const centroids = kmeans(pixels, 3);
    expect(centroids).toHaveLength(3);
    // Primeiro centroid ~vermelho
    expect(centroids[0]!.r).toBeGreaterThan(200);
    expect(centroids[0]!.g).toBeLessThan(50);
    expect(centroids[0]!.b).toBeLessThan(50);
  });

  it('determinístico — mesma seed → mesmo resultado', () => {
    const pixels = Array.from({ length: 200 }, (_, i) => ({
      r: (i * 7) % 255,
      g: (i * 13) % 255,
      b: (i * 19) % 255,
    }));
    const r1 = kmeans(pixels, 5, 42);
    const r2 = kmeans(pixels, 5, 42);
    expect(r1).toEqual(r2);
  });

  it('lida com k > pixels (retorna no máximo N centroids)', () => {
    const pixels = [{ r: 10, g: 10, b: 10 }, { r: 200, g: 200, b: 200 }];
    const centroids = kmeans(pixels, 5);
    expect(centroids.length).toBeLessThanOrEqual(2);
  });

  it('pixels vazios → array vazio', () => {
    expect(kmeans([], 3)).toEqual([]);
  });
});

// ─── Tests: hue delta (AC5) ─────────────────────────────────────────────────

describe('hue delta (AC5)', () => {
  it('vermelho puro tem hue 0', () => {
    expect(hexToHue('#ff0000')).toBeCloseTo(0, 0);
  });

  it('verde puro tem hue 120', () => {
    expect(hexToHue('#00ff00')).toBeCloseTo(120, 0);
  });

  it('azul puro tem hue 240', () => {
    expect(hexToHue('#0000ff')).toBeCloseTo(240, 0);
  });

  it('cinza tem hue 0 (achromatic — max===min)', () => {
    expect(hexToHue('#808080')).toBe(0);
  });

  it('hueDelta simétrico em relação à ordem', () => {
    expect(hueDelta(10, 350)).toBeCloseTo(hueDelta(350, 10), 5);
  });

  it('hueDelta trata wrap-around 0/360 (10° e 350° = 20° apart, não 340°)', () => {
    expect(hueDelta(10, 350)).toBe(20);
  });

  it('Δmatiz ≥30° separa vermelho (0°) de laranja (30°)', () => {
    expect(hueDelta(hexToHue('#ff0000'), hexToHue('#ff8000'))).toBeGreaterThanOrEqual(30);
  });
});

// ─── Tests: cheerio color hits (AC4a) ───────────────────────────────────────

describe('collectCheerioColorHits (AC4a)', () => {
  it('extrai hex de <style> inline', () => {
    const html = `<html><head><style>
      .cta { background: #ff6600; }
      .hero { color: #123456; }
    </style></head><body></body></html>`;
    const hits = collectCheerioColorHits(html);
    expect(hits.get('#ff6600')).toBeGreaterThan(0);
    expect(hits.get('#123456')).toBeGreaterThan(0);
  });

  it('extrai rgb() e converte pra hex', () => {
    const html = `<style>.foo { background: rgb(255, 102, 0); }</style>`;
    const hits = collectCheerioColorHits(html);
    expect(hits.get('#ff6600')).toBeGreaterThan(0);
  });

  it('pesa hex em CTA/header mais alto que <style> genérico', () => {
    const html = `
      <style>.random { color: #111111; }</style>
      <button class="cta" style="background:#ff6600">Buy</button>
    `;
    const hits = collectCheerioColorHits(html);
    const random = hits.get('#111111') ?? 0;
    const cta = hits.get('#ff6600') ?? 0;
    expect(cta).toBeGreaterThan(random);
  });

  it('normaliza hex de 3 dígitos pra 6 dígitos', () => {
    const html = `<style>.a { color: #f60; }</style>`;
    const hits = collectCheerioColorHits(html);
    expect(hits.has('#ff6600')).toBe(true);
  });
});

// ─── Tests: mergePalette (AC5) ─────────────────────────────────────────────

describe('mergePalette (AC5)', () => {
  it('primary = hex com mais hits em cheerio (>3 hits threshold)', () => {
    const cheerioHits = new Map([
      ['#ff6600', 10], // dominante colorido
      ['#333333', 5], // neutro — ignorado como primary
      ['#0066ff', 4], // secundário candidato (>3)
    ]);
    const palette = mergePalette({
      cheerioHits,
      kmeansCentroids: [],
      candidateColors: [],
    });
    expect(palette.primary).toBe('#ff6600');
  });

  it('secondary tem Δmatiz ≥30° do primary', () => {
    const cheerioHits = new Map([
      ['#ff0000', 10], // primary — vermelho
      ['#00ff00', 8], // secondary candidate — verde (Δ 120°)
      ['#ff0800', 6], // rejected — quase igual ao primary (Δ ~2°)
    ]);
    const palette = mergePalette({
      cheerioHits,
      kmeansCentroids: [],
      candidateColors: [],
    });
    expect(palette.primary).toBe('#ff0000');
    expect(palette.secondary).toBe('#00ff00');
  });

  it('bg = cor mais clara do k-means; text = mais escura', () => {
    const cheerioHits = new Map([['#ff6600', 10]]);
    const palette = mergePalette({
      cheerioHits,
      kmeansCentroids: [
        { r: 255, g: 255, b: 255 }, // branco → bg
        { r: 10, g: 10, b: 10 }, // quase preto → text
        { r: 128, g: 128, b: 128 }, // meio
      ],
      candidateColors: [],
    });
    // #ffffff é o mais claro → deve virar bg (ou algo bem próximo após WCAG)
    expect(palette.bg.toLowerCase()).toBe('#ffffff');
  });
});

// ─── Tests: extractBrand integration ───────────────────────────────────────

describe('extractBrand — integration (AC1/AC3/AC10/AC11)', () => {
  let screenshotPath: string;

  beforeAll(async () => {
    // Screenshot com paleta conhecida: laranja predominante + branco + azul
    screenshotPath = await writeTestScreenshot([
      [255, 255, 255], // branco (bg)
      [255, 102, 0], // laranja (brand)
      [0, 102, 255], // azul (secondary)
      [20, 20, 20], // quase preto (text)
    ]);
  });

  afterAll(async () => {
    try {
      await fs.unlink(screenshotPath);
    } catch {
      // ignore
    }
  });

  it('retorna todos os campos exigidos por AC3', async () => {
    const html = `
      <html>
        <head>
          <style>
            body { font-family: "Inter", sans-serif; }
            h1 { font-family: "Poppins", serif; }
            .cta { background: #ff6600; color: #ffffff; }
            .btn { background: #ff6600; }
            button.hero-cta { background: #ff6600; }
          </style>
        </head>
        <body>
          <header>
            <img src="/assets/mylogo.png" alt="Brand logo" />
          </header>
          <h1>Buy Now</h1>
          <button class="cta">Order</button>
        </body>
      </html>
    `;

    const db = makeMockDb(
      new Map([
        ['Inter', { google: 'Inter', llm: false }],
        ['Poppins', { google: 'Poppins', llm: false }],
      ]),
    );

    const input: BrandExtractInput = {
      html,
      screenshotPath,
      db,
    };

    const result = await extractBrand(input);

    // AC3: todos os campos presentes
    expect(result).toHaveProperty('primary');
    expect(result).toHaveProperty('secondary');
    expect(result).toHaveProperty('accent');
    expect(result).toHaveProperty('bg');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('headline_font');
    expect(result).toHaveProperty('body_font');
    expect(result).toHaveProperty('logo_url');
    expect(result).toHaveProperty('logo_source');
    expect(result).toHaveProperty('fonts_substituted');
    expect(result).toHaveProperty('contrast_adjustments');
    expect(result).toHaveProperty('trace');

    // AC1: hex format sane
    expect(result.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result.bg).toMatch(/^#[0-9a-f]{6}$/i);

    // AC6/AC7: fonts mapeadas
    expect(result.headline_font).toBe('Poppins');
    expect(result.body_font).toBe('Inter');

    // AC8: logo detectado
    expect(result.logo_url).toBe('/assets/mylogo.png');
    expect(result.logo_source).toBe('extracted_from_fonte');

    // AC11: trace com pelo menos steps de cor + font + logo
    expect(result.trace.length).toBeGreaterThan(0);
    const steps = result.trace.map((t) => t.step);
    expect(steps).toContain('color.cheerio');
    expect(steps).toContain('color.merge');
    expect(steps).toContain('contrast.adjust');
    expect(steps).toContain('logo.detect');
    for (const t of result.trace) {
      expect(typeof t.latency_ms).toBe('number');
      expect(t.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('AC5: paleta com cor dominante detecta primary corretamente', async () => {
    const html = `
      <style>
        button, .cta, .btn, .hero, header { background: #ff6600; }
        button, .cta { background: #ff6600; }
        .hero { background: #ff6600; }
        .btn { background: #ff6600; }
      </style>
      <button class="cta" style="background:#ff6600">Buy</button>
      <div class="hero" style="background:#ff6600"></div>
    `;
    const db = makeMockDb(new Map([['Arial', { google: 'Arial', llm: false }]]));

    const result = await extractBrand({
      html,
      screenshotPath,
      db,
    });

    // Primary deve ser #ff6600 ou muito próximo (possivelmente ajustado por WCAG)
    // Como #ff6600 tem contraste ~2.9:1 vs bg branco, WCAG pode ter escurecido.
    // Verificamos que o hue é aproximadamente laranja (0-40°).
    const hue = hexToHue(result.primary);
    expect(hue < 40 || hue > 320).toBe(true); // laranja/vermelho
  });

  it('AC8: logo não encontrado → logo_source=not_found', async () => {
    const html = `<html><body><h1>Sem logo aqui</h1></body></html>`;
    const db = makeMockDb(new Map([['Inter', { google: 'Inter', llm: false }]]));

    const result = await extractBrand({
      html,
      screenshotPath,
      db,
    });

    expect(result.logo_url).toBeNull();
    expect(result.logo_source).toBe('not_found');
  });

  it('AC7: font hit no DB retorna llm_generated=false', async () => {
    const html = `<style>body { font-family: "Roboto"; } h1 { font-family: "Montserrat"; }</style>`;
    const db = makeMockDb(
      new Map([
        ['Roboto', { google: 'Roboto', llm: false }],
        ['Montserrat', { google: 'Montserrat', llm: false }],
      ]),
    );

    const result = await extractBrand({
      html,
      screenshotPath,
      db,
    });

    const headline = result.fonts_substituted.find((f) => f.source_family === 'Montserrat');
    expect(headline?.llm_generated).toBe(false);
    expect(headline?.google_family).toBe('Montserrat');
  });

  it('screenshot ausente → segue com só cheerio (não trava)', async () => {
    const html = `<style>.cta { background: #123456; } .btn { background: #123456; } button { background:#123456; }</style>`;
    const db = makeMockDb(new Map([['Inter', { google: 'Inter', llm: false }]]));

    const result = await extractBrand({
      html,
      screenshotPath: '/nonexistent/path/xyz.png',
      db,
    });

    // Deve ter trace de skip
    const skipStep = result.trace.find((t) => t.step === 'color.kmeans.skipped');
    expect(skipStep).toBeDefined();
    // E ainda retorna paleta válida
    expect(result.primary).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
