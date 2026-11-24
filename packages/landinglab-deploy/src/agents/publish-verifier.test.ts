// AC17 — Publish Verifier unit tests.

import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@blackshop/db';

import { runPublishVerifier } from './publish-verifier.js';

// ─── Mock helpers ────────────────────────────────────────────────────────

function makeDbWithHero(heroText: string | null): Database {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async limit(_n: number) {
                      if (heroText === null) return [];
                      return [
                        {
                          content: {
                            hooks: [
                              { text: heroText, awareness_stage: 'unaware' },
                            ],
                          },
                        },
                      ];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function makeHttpMock(status: number, body: string): (url: string, opts?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

const HAPPY_BODY = `
<!DOCTYPE html>
<html><head>
  <meta property="og:title" content="Aloe Serum">
  <title>Aloe Serum</title>
</head>
<body>
  <h1>Aloe Serum Nightly Ritual</h1>
  <p>Real content here.</p>
</body></html>`;

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runPublishVerifier', () => {
  it('happy path: 4/4 checks pass', async () => {
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'aloe-serum.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero('Aloe Serum Nightly Ritual'),
        httpClient: makeHttpMock(200, HAPPY_BODY),
      },
    );
    expect(result.healthCheckPassed).toBe(true);
    expect(result.status).toBe(200);
    expect(result.checksPassed).toContain('status_200');
    expect(result.checksPassed).toContain('hero_title_present');
    expect(result.checksPassed).toContain('og_title_present');
    expect(result.checksPassed).toContain('not_noindex');
    expect(result.checksFailed).toHaveLength(0);
    expect(result.warning).toBeUndefined();
  });

  it('missing hero_title in copy_deck → fallback to <h1> check + warning', async () => {
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'x.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero(null),
        httpClient: makeHttpMock(200, HAPPY_BODY),
      },
    );
    expect(result.warning).toBe('no_copy_deck_hero_fallback_h1');
    expect(result.checksPassed).toContain('h1_present_fallback');
    expect(result.healthCheckPassed).toBe(true);
  });

  it('noindex meta present → check fails', async () => {
    const noindexBody = HAPPY_BODY.replace(
      '<head>',
      '<head><meta name="robots" content="noindex,nofollow">',
    );
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'x.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero('Aloe Serum Nightly Ritual'),
        httpClient: makeHttpMock(200, noindexBody),
      },
    );
    expect(result.healthCheckPassed).toBe(false);
    expect(result.checksFailed).toContain('not_noindex');
  });

  it('HTTP 500 → healthCheckPassed=false', async () => {
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'x.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero('Aloe Serum'),
        httpClient: makeHttpMock(500, 'Server Error'),
      },
    );
    expect(result.healthCheckPassed).toBe(false);
    expect(result.status).toBe(500);
    expect(result.checksFailed).toContain('status_200');
  });

  it('httpClient throws (timeout) → returns error surface', async () => {
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'x.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero('Aloe'),
        httpClient: vi.fn(async () => {
          throw new Error('connection timeout');
        }),
      },
    );
    expect(result.healthCheckPassed).toBe(false);
    expect(result.status).toBe(-1);
    expect(result.checksFailed.some((c) => c.startsWith('error:'))).toBe(true);
  });

  it('hero title mismatch → hero_title_present fails', async () => {
    const result = await runPublishVerifier(
      {
        landingPageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        hostname: 'x.landinglab.app',
        contentLanguage: 'en',
      },
      {
        db: makeDbWithHero('EXPECTED HERO NOT PRESENT'),
        httpClient: makeHttpMock(200, HAPPY_BODY),
      },
    );
    expect(result.healthCheckPassed).toBe(false);
    expect(result.checksFailed).toContain('hero_title_present');
  });
});
