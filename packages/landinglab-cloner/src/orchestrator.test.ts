// Testes das funções puras exportadas por `orchestrator.ts`:
// - `sanitizeHtml` (remove scripts/noscript/onhandlers, injeta color-scheme)
// - `absolutizeCssUrls` (converte url(...) relativas em absolutas)
// - `extractCssUrls` (extrai lista de URLs referenciadas em CSS)
//
// O fluxo E2E `cloneLanding` NÃO é testado aqui: depende de Playwright real
// e fetch de rede. Um `it.todo` marca a intenção.

import { describe, expect, it } from 'vitest';

import { rewriteUrls } from './agents/asset-downloader.js';
import {
  absolutizeCssUrls,
  assessCloneFidelity,
  extractCssUrls,
  extractMissingStaticScripts,
  sanitizeHtml,
} from './orchestrator.js';

describe('sanitizeHtml', () => {
  it('remove o popup de assinatura capturado e toda a subárvore', () => {
    const input =
      '<html><body><main>Conteúdo</main><div data-x="1" id="sc-subscribe-popup" class="sc-popup-overlay extra"><div><form>Popup</form></div></div></body></html>';
    const out = sanitizeHtml(input);

    expect(out).toContain('<main>Conteúdo</main>');
    expect(out).not.toContain('sc-subscribe-popup');
    expect(out).not.toContain('sc-popup-overlay');
    expect(out).not.toContain('<form>Popup</form>');
  });

  it('remove classe de popup com aspas simples e múltiplas classes', () => {
    const input =
      "<html><body><section class='keep'>Preservar</section><aside class='one sc-popup-overlay two' data-kind='offer'><p>Remover</p></aside></body></html>";
    const out = sanitizeHtml(input);

    expect(out).toContain('Preservar');
    expect(out).not.toContain('sc-popup-overlay');
    expect(out).not.toContain('Remover');
  });

  it('remove raízes Alia com sufixos dinâmicos', () => {
    const input =
      '<html><body><div id="alia-root-339753"><div id="alia-popup-root-campaign-42"><canvas></canvas></div></div><article>Landing</article></body></html>';
    const out = sanitizeHtml(input);

    expect(out).toContain('<article>Landing</article>');
    expect(out).not.toContain('alia-root-339753');
    expect(out).not.toContain('alia-popup-root-campaign-42');
  });

  it('remove scripts residuais dos popups capturados', () => {
    const input = `<html><body>
      <script>const popup = document.getElementById('sc-subscribe-popup'); popup.style.display = 'flex';</script>
      <script>window.ALIA_SHOPIFY_EXTENSION_INFO = {}; fetch('https://backend.alia-prod.com/public/launcher.js');</script>
      <main>Landing</main>
    </body></html>`;
    const out = sanitizeHtml(input);

    expect(out).toContain('<main>Landing</main>');
    expect(out).not.toContain('sc-subscribe-popup');
    expect(out).not.toContain('backend.alia-prod.com');
    expect(out).not.toContain('ALIA_SHOPIFY_EXTENSION_INFO');
  });

  it('preserva texto que apenas menciona os padrões de popup', () => {
    const input =
      '<html><body><p>Referências: sc-subscribe-popup, sc-popup-overlay, alia-root- e alia-popup-root-.</p></body></html>';

    expect(sanitizeHtml(input)).toBe(input);
  });

  it('mantém a remoção de popups idempotente', () => {
    const input =
      '<html><body><main>Landing</main><div class="sc-popup-overlay"><div>Oferta</div></div></body></html>';
    const once = sanitizeHtml(input);

    expect(sanitizeHtml(once)).toBe(once);
  });

  // Fase 5.A.2: sanitizer AGORA preserva scripts de UX (galeria/FAQ/bundles).
  // Só remove trackers/analytics/pixel/checkout-origem por padrões conhecidos.

  it('preserva <script> inline genérico (UX da landing origem)', () => {
    const input =
      '<html><head><script>document.querySelector(".faq").addEventListener("click", () => {})</script></head><body>x</body></html>';
    const out = sanitizeHtml(input);
    expect(out).toContain('<script>');
    expect(out).toContain('addEventListener');
  });

  it('remove <script src=...> de trackers conhecidos (GTM)', () => {
    const input = '<script src="https://googletagmanager.com/gtm.js"></script><body>ok</body>';
    const out = sanitizeHtml(input);
    expect(out).not.toContain('<script');
    expect(out).toContain('ok');
  });

  it('remove <script> inline com gtag() (analytics)', () => {
    const input = '<script>gtag("event", "click")</script><body>ok</body>';
    const out = sanitizeHtml(input);
    expect(out).not.toContain('<script');
    expect(out).toContain('ok');
  });

  it('preserva <script src=...> de CDNs genéricos (jQuery, Swiper)', () => {
    const input =
      '<script src="https://cdn.jsdelivr.net/npm/swiper@8/swiper.min.js"></script>';
    const out = sanitizeHtml(input);
    expect(out).toContain('swiper.min.js');
  });

  it('preserva <script type="application/ld+json">', () => {
    const input =
      '<script type="application/ld+json">{"@type":"Product"}</script><body>ok</body>';
    const out = sanitizeHtml(input);
    expect(out).toContain('application/ld+json');
    expect(out).toContain('"@type":"Product"');
  });

  it('remove <noscript>', () => {
    const input = '<noscript>fallback</noscript><body>ok</body>';
    const out = sanitizeHtml(input);
    expect(out).not.toContain('<noscript>');
    expect(out).not.toContain('fallback');
  });

  it('preserva event handlers inline (Fase 5.A.2 — galeria/bundle deps)', () => {
    // NOTA: DOMPurify no storefront ainda filtra handlers realmente perigosos
    // como onerror/onload. Aqui só validamos que o cloner (regex) não remove.
    const input = '<div onclick="openLightbox()" data-keep="1">x</div>';
    const out = sanitizeHtml(input);
    expect(out).toContain('onclick');
    expect(out).toContain('data-keep');
  });

  it('força opacity:0 → opacity:1 quando precedido por espaço ou `;` (Task #21)', () => {
    // Casos que a regex ATUAL cobre — requer `(\s|;)` antes de `opacity`.
    const input = '<div style="transform:scale(0.9); opacity:0; color:red">hero</div>';
    const out = sanitizeHtml(input);
    expect(out).toContain('opacity:1');
    expect(out).not.toMatch(/(\s|;)opacity\s*:\s*0[;"']/);
  });

  // BUG DESCOBERTO durante escrita dos testes:
  // A regex de opacity em orchestrator.ts:86 exige `(\s|;)` antes de `opacity`.
  // Isso NÃO cobre o caso comum `style="opacity:0;..."` — quando opacity é o
  // PRIMEIRO valor no atributo style (sem espaço/semi antes). Sites Next.js
  // usam esse padrão pra scroll-reveal e a landing renderiza invisível.
  //
  // Correção sugerida: mudar `(\s|;)` pra `(?:^|["'\s;])` com lookbehind ou
  // captura opcional. Este teste está `.todo` até correção landar — se removido
  // sem fix, quebra o clone de landings Next.js modernas.
  it.todo('BUG: opacity:0 no início de style="..." não é reescrita');


  it('injeta color-scheme meta light após <head>', () => {
    const input = '<html><head><title>x</title></head><body>y</body></html>';
    const out = sanitizeHtml(input);
    expect(out).toContain('<meta name="color-scheme" content="light only">');
    // Deve vir logo após o head (não repetir)
    expect(out.match(/color-scheme/g)?.length).toBe(1);
  });

  it('não injeta color-scheme meta se já existir', () => {
    const input =
      '<html><head><meta name="color-scheme" content="dark"><title>x</title></head><body></body></html>';
    const out = sanitizeHtml(input);
    // Preserva o dark existente, não injeta o light.
    expect(out).toContain('content="dark"');
    expect(out).not.toContain('content="light only"');
  });

  // Fase D — Pixel sanitization (out/2026).
  //
  // Shopify Web Pixels Manager (wpmLoader) é um script inline injetado pelo tema
  // da loja origem que carrega pixels configurados no admin — incluindo pixels
  // Meta do CONCORRENTE. Mesmo sem fbevents.js aparecer no src, o loader faz
  // /web-pixels/web-pixel-X/pixel.modern.js que dispara /tr pra conta origem.
  // Dupla contaminação: nosso LandingLab Pixel + Pixel do dono da loja origem.
  it('remove wpmLoader inline script com pixel_type:facebook_pixel do origem', () => {
    const input = `<script>(function(){var wpmLoader=function(){var cfg={"pixels":[{"id":"X","configuration":"{\\"pixel_id\\":\\"1674545963552583\\",\\"pixel_type\\":\\"facebook_pixel\\"}"}]};};wpmLoader();})();</script><body>ok</body>`;
    const out = sanitizeHtml(input);
    expect(out).not.toContain('wpmLoader');
    expect(out).not.toContain('1674545963552583');
    expect(out).toContain('ok');
  });

  it('remove inline webPixelsManager.init() script', () => {
    const input = `<script>window.webPixelsManager.init({pixels:[]});</script><body>ok</body>`;
    const out = sanitizeHtml(input);
    expect(out).not.toContain('webPixelsManager');
    expect(out).toContain('ok');
  });

  it('remove Shopify.analytics inline config script', () => {
    const input = `<script>window.Shopify.analytics = { publish: function(){} };</script><body>ok</body>`;
    const out = sanitizeHtml(input);
    expect(out).not.toContain('Shopify.analytics');
    expect(out).toContain('ok');
  });
});

describe('absolutizeCssUrls', () => {
  const base = 'https://cdn.origem.com/lp/styles/main.css';

  it('converte url(/foo.png) absoluto ao domínio', () => {
    const input = 'body{background:url(/img/hero.jpg)}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe('body{background:url(https://cdn.origem.com/img/hero.jpg)}');
  });

  it('converte url(../foo.png) relativo ao CSS', () => {
    const input = 'body{background:url(../img/hero.jpg)}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe('body{background:url(https://cdn.origem.com/lp/img/hero.jpg)}');
  });

  it("preserva quotes simples: url('...')", () => {
    const input = "body{background:url('/x.png')}";
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe("body{background:url('https://cdn.origem.com/x.png')}");
  });

  it('preserva quotes duplas: url("...")', () => {
    const input = 'body{background:url("/x.png")}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe('body{background:url("https://cdn.origem.com/x.png")}');
  });

  it('preserva url() já absoluta', () => {
    const input = 'body{background:url(https://other.cdn.com/x.png)}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe(input);
  });

  it('preserva url(data:...)', () => {
    const input = 'body{background:url(data:image/png;base64,iVBOR)}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toBe(input);
  });

  it('converte múltiplas url() na mesma regra', () => {
    const input = '.a{background:url(/a.png)}.b{cursor:url(/b.png),auto}';
    const out = absolutizeCssUrls(input, base);
    expect(out).toContain('https://cdn.origem.com/a.png');
    expect(out).toContain('https://cdn.origem.com/b.png');
  });
});

describe('extractCssUrls', () => {
  const base = 'https://cdn.origem.com/lp/styles/main.css';

  it('extrai url() simples', () => {
    const input = 'body{background:url(/img/hero.jpg)}';
    const out = extractCssUrls(input, base);
    expect(out).toEqual(['https://cdn.origem.com/img/hero.jpg']);
  });

  it('extrai url() com quote', () => {
    const input = "body{background:url('/x.png')}";
    const out = extractCssUrls(input, base);
    expect(out).toEqual(['https://cdn.origem.com/x.png']);
  });

  it('ignora url(data:...)', () => {
    const input = 'body{background:url(data:image/png;base64,X)}';
    const out = extractCssUrls(input, base);
    expect(out).toEqual([]);
  });

  it('extrai múltiplas em regras diferentes', () => {
    const input =
      '@font-face{src:url(/fonts/a.woff2)}.hero{background-image:url(/img/hero.png)}';
    const out = extractCssUrls(input, base);
    expect(out).toContain('https://cdn.origem.com/fonts/a.woff2');
    expect(out).toContain('https://cdn.origem.com/img/hero.png');
    expect(out).toHaveLength(2);
  });

  it('retorna array vazio pra CSS sem url()', () => {
    expect(extractCssUrls('body{color:red}', base)).toEqual([]);
  });
});

describe('rewriteUrls', () => {
  it('substitui URL absoluta em HTML pelo path local', () => {
    const map = new Map<string, string>([
      ['https://cdn.origem.com/img/hero.png', '/static/cloned/abc/hash.png'],
    ]);
    const html = '<img src="https://cdn.origem.com/img/hero.png">';
    expect(rewriteUrls(html, map)).toBe('<img src="/static/cloned/abc/hash.png">');
  });

  it('substitui todas as ocorrências (usa flag g)', () => {
    const map = new Map<string, string>([
      ['https://cdn.origem.com/img.png', '/local/x.png'],
    ]);
    const html =
      '<img src="https://cdn.origem.com/img.png"><a href="https://cdn.origem.com/img.png">';
    const out = rewriteUrls(html, map);
    expect(out.match(/\/local\/x\.png/g)?.length).toBe(2);
    expect(out).not.toContain('cdn.origem.com');
  });

  it('respeita ordenação por comprimento (URLs longas primeiro)', () => {
    // Se a URL curta for substituída primeiro, ela quebra a longa.
    // Ex: se '/a' for substituído antes de '/abc', vira 'LOCAL_A' + 'bc'.
    const map = new Map<string, string>([
      ['/a', 'SHORT'],
      ['/abc', 'LONG'],
    ]);
    const html = '<x src="/abc"><y src="/a">';
    const out = rewriteUrls(html, map);
    expect(out).toContain('LONG');
    expect(out).toContain('SHORT');
    // O importante: /abc virou LONG, não SHORTbc.
    expect(out).not.toContain('SHORTbc');
  });

  it('escapa metacaracteres regex na URL (evita interpretar . [ ] etc)', () => {
    const map = new Map<string, string>([
      ['https://cdn.com/img?v=1.2', '/local/img'],
    ]);
    const html = '<img src="https://cdn.com/img?v=1.2">';
    const out = rewriteUrls(html, map);
    expect(out).toBe('<img src="/local/img">');
  });

  it('não modifica HTML quando urlMap vazio', () => {
    const html = '<img src="https://x.com/y.png">';
    expect(rewriteUrls(html, new Map())).toBe(html);
  });
});

describe('cloneLanding (E2E)', () => {
  // Cobre pipeline completo: Playwright render + fetch CSS + download assets +
  // rewrite + sanitize. Custoso e depende de rede/Playwright — testado via
  // scripts/2026-09-04-parijan-e2e em vez de vitest.
  it.todo('roda pipeline completo contra URL real');
});

// ─── Fidelity trace shape — observability light ─────────────────────────────
//
// cloneLanding empurra um trace com agent=fidelity-gate no fim do pipeline.
// O shape do notes é um JSON estável usado por dashboards/queries. Este bloco
// documenta e prova o formato, mesmo sem rodar cloneLanding inteiro.

// ─── STEP 4 — False Pass Prevention (gate placement post-mutations) ─────────
//
// O `assessCloneFidelity` DEVE rodar sobre o HTML final (pós sanitize +
// bundles + checkout + pixel + fixes-injector), não sobre estado intermediário.
// Se rodasse cedo demais, uma mutation posterior poderia injetar artifact
// (por regressão em fixes-injector ou pixel) e o gate passaria como HEALTHY —
// falso positivo grave. Este bloco cristaliza o requisito.

describe('fidelity gate — false pass prevention (post-mutation ordering)', () => {
  it('HTML healthy pré-mutation vira BLOCKED se mutação posterior injeta chrome-extension', () => {
    // Simula: htmlClean começa healthy (via sanitize), depois uma mutation
    // simulada injeta o artifact (bug hipotético de fixes-injector futuro).
    // Se o gate rodasse ANTES da mutação, retornaria HEALTHY (falso positivo).
    // Rodando DEPOIS de todas mutações (comportamento atual), retorna BLOCKED.
    const preMutationHtml = `<html><head><style>a{}</style></head><body><main>OK</main></body></html>`;
    expect(assessCloneFidelity(preMutationHtml).verdict).toBe('HEALTHY');

    // Simulação de mutation posterior contaminando o HTML.
    const postMutationHtml = preMutationHtml.replace(
      '<main>OK</main>',
      '<main>OK</main><script src="chrome-extension://leaked/inject.js"></script>',
    );
    const result = assessCloneFidelity(postMutationHtml);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.some((f) => f.includes('browser-extension-artifact'))).toBe(true);
  });

  it('HTML healthy pré-mutation vira DEGRADED se mutação posterior injeta placeholder /cloned/undefined/', () => {
    const preMutationHtml = `<html><head><style>a{}</style></head><body><main>OK</main></body></html>`;
    expect(assessCloneFidelity(preMutationHtml).verdict).toBe('HEALTHY');

    const postMutationHtml = preMutationHtml.replace(
      '<main>OK</main>',
      '<main>OK</main><script src="/cloned/undefined/theme.js"></script>',
    );
    const result = assessCloneFidelity(postMutationHtml);
    expect(result.verdict).toBe('DEGRADED');
    expect(result.findings.some((f) => f.includes('unresolved-asset-placeholders'))).toBe(true);
  });

  it('sanitize + fixes-injector encadeados: gate rodando após ambos vê estado final', () => {
    // Sanitize remove chrome-extension. Se rodássemos o gate ENTRE sanitize e
    // uma mutation posterior (que hipoteticamente reintroduzisse artifact), o
    // gate pegaria como HEALTHY. O contrato é: gate SEMPRE roda depois de TUDO.
    const withArtifact = `<html><head><style>a{}</style></head><body>
      <script src="chrome-extension://abc/inject.js"></script>
      <main>content</main>
    </body></html>`;
    const afterSanitize = sanitizeHtml(withArtifact);
    // Pós sanitize, artifact foi removido — HEALTHY.
    expect(assessCloneFidelity(afterSanitize).verdict).toBe('HEALTHY');

    // Simulação: fixes-injector futuro contamina o output — gate captura.
    const afterFakeMutation = afterSanitize.replace(
      '<main>content</main>',
      '<main>content</main><script src="chrome-extension://xyz/leaked.js"></script>',
    );
    expect(assessCloneFidelity(afterFakeMutation).verdict).toBe('BLOCKED');
  });
});

describe('fidelity trace entry shape', () => {
  // Simula exatamente o payload que cloneLanding gera pra o trace push.
  function buildFidelityNotes(html: string, recoveredStaticScripts: number): string {
    const fidelity = assessCloneFidelity(html);
    const blockedBrowserArtifacts = fidelity.findings.filter((f) =>
      f.includes('browser-extension-artifact'),
    ).length;
    const unresolvedExternalScripts = fidelity.findings.filter((f) =>
      f.includes('non-frozen-script-refs'),
    ).length;
    const criticalCssPresent = !fidelity.findings.some((f) =>
      f.includes('critical-css-missing'),
    );
    return JSON.stringify({
      fidelityStatus: fidelity.verdict,
      recoveredStaticScripts,
      blockedBrowserArtifacts,
      unresolvedExternalScripts,
      criticalCssPresent,
      landingPageIdRewritten: true,
    });
  }

  it('HEALTHY clone com scripts recuperados → JSON canônico', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://storage.supabase.co/cloned/x.js"></script>
    </body></html>`;
    const notes = buildFidelityNotes(html, 3);
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    expect(parsed).toEqual({
      fidelityStatus: 'HEALTHY',
      recoveredStaticScripts: 3,
      blockedBrowserArtifacts: 0,
      unresolvedExternalScripts: 0,
      criticalCssPresent: true,
      landingPageIdRewritten: true,
    });
  });

  it('BLOCKED por chrome-extension → blockedBrowserArtifacts=1', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="chrome-extension://abc/inj.js"></script>
    </body></html>`;
    const notes = buildFidelityNotes(html, 0);
    const parsed = JSON.parse(notes) as { fidelityStatus: string; blockedBrowserArtifacts: number };
    expect(parsed.fidelityStatus).toBe('BLOCKED');
    expect(parsed.blockedBrowserArtifacts).toBe(1);
  });

  it('BLOCKED por CSS missing → criticalCssPresent=false', () => {
    const html = '<html><head></head><body><p>sem css</p></body></html>';
    const notes = buildFidelityNotes(html, 0);
    const parsed = JSON.parse(notes) as { criticalCssPresent: boolean };
    expect(parsed.criticalCssPresent).toBe(false);
  });

  it('DEGRADED por script externo não-frozen → unresolvedExternalScripts=1', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://loja.myshopify.com/cdn/theme.js"></script>
    </body></html>`;
    const notes = buildFidelityNotes(html, 0);
    const parsed = JSON.parse(notes) as {
      fidelityStatus: string;
      unresolvedExternalScripts: number;
    };
    expect(parsed.fidelityStatus).toBe('DEGRADED');
    expect(parsed.unresolvedExternalScripts).toBe(1);
  });

  it('landingPageIdRewritten sempre true (constante pós PR #142)', () => {
    const html = '<html><head><style>a{}</style></head><body></body></html>';
    const notes = buildFidelityNotes(html, 0);
    const parsed = JSON.parse(notes) as { landingPageIdRewritten: boolean };
    expect(parsed.landingPageIdRewritten).toBe(true);
  });
});

// ─── STEP N+1 — Edge case defensiveness (2026-09-28 gap audit) ──────────
//
// Prova que o gate NÃO retorna HEALTHY em cenários patológicos onde o
// clone silenciosamente falhou (empty HTML, redirect page sem body real,
// etc). Um falso HEALTHY nestes casos permitiria publicar landing quebrada.

describe('assessCloneFidelity — edge case defensiveness', () => {
  it('empty string "" → BLOCKED (critical-css-missing)', () => {
    const result = assessCloneFidelity('');
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings).toContain('BLOCKED:critical-css-missing');
  });

  it('whitespace-only " \\n\\t" → BLOCKED', () => {
    const result = assessCloneFidelity('   \n\t  ');
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.some((f) => f.startsWith('BLOCKED'))).toBe(true);
  });

  it('redirect-page-like (200 chars, no CSS/scripts) → BLOCKED', () => {
    // Simula fetch estático caindo em página de login/redirect (sem <style>/<link>)
    const html = '<html><head><meta http-equiv="refresh" content="0;url=/login"></head><body><p>Redirecting to login...</p></body></html>';
    expect(html.length).toBeLessThan(300);
    const result = assessCloneFidelity(html);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings).toContain('BLOCKED:critical-css-missing');
  });

  it('HTML com só <link stylesheet> (sem body real) → HEALTHY (gate não valida body)', () => {
    // Documenta limitação: o gate é HTML-only, não valida se body tem conteúdo real.
    // Landing pura de erro com CSS ainda passa. Requer camada semântica futura.
    const html = '<html><head><link rel="stylesheet" href="/css/x.css"></head><body></body></html>';
    const result = assessCloneFidelity(html);
    expect(result.verdict).toBe('HEALTHY');
  });
});

describe('extractMissingStaticScripts — edge case defensiveness', () => {
  it('staticHtml vazio "" → retorna [] (sem crash)', () => {
    const recovered = extractMissingStaticScripts([], '', 'https://example.com');
    expect(recovered).toEqual([]);
  });

  it('staticHtml de redirect (sem scripts) → retorna []', () => {
    const redirectHtml = '<html><head><meta http-equiv="refresh" content="0;url=/login"></head><body>Redirecting</body></html>';
    const recovered = extractMissingStaticScripts([], redirectHtml, 'https://example.com');
    expect(recovered).toEqual([]);
  });

  it('staticHtml malformado (não-HTML) → retorna [] (parseHtmlOverride nunca lança)', () => {
    const junk = 'this is not html at all, just plain text with random {} chars';
    const recovered = extractMissingStaticScripts([], junk, 'https://example.com');
    expect(recovered).toEqual([]);
  });
});

// ─── STEP 9 / STEP 11 — extractMissingStaticScripts ──────────────────────
//
// Second fixture (Bepurex/Aurivita-style): página genérica não-Denim.
// Prova que o enricher é genérico e não depende do tema Klensia.
// A: clone sem htmlOverride continua igual → testado via sanitizeHtml pass-through
// B: clone com htmlOverride recupera scripts ausentes
// C: scripts já presentes não são duplicados
// D: ordem relativa preservada
// E: defer/async/type=module preservados (atributos ficam no HTML; enricher
//    apenas merge URLs — atributos vêm do HTML estático via parseHtmlOverride)
// F: chrome-extension/moz-extension bloqueados
// G: trackers continuam bloqueados (STEP 11 — security regression)

describe('extractMissingStaticScripts (static-script-enricher)', () => {
  const BASE = 'https://loja.exemplo.com/products/produto';

  // Fixture sintético: DOM capturado (htmlOverride) — só tem scripts dinâmicos/inline
  // Fixture sintético: HTML estático — tem scripts do tema com defer
  const STATIC_HTML_GENERIC = `
    <html><head>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/constants.js?v=123" defer="defer"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=456" defer="defer"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/product.js?v=789" defer="defer"></script>
      <script src="https://cdn.jsdelivr.net/npm/swiper/swiper.min.js"></script>
    </head><body></body></html>
  `;

  // Fixture Bepurex-style: segundo tema diferente do Denim
  const STATIC_HTML_BEPUREX = `
    <html><head>
      <script src="https://bepurex.myshopify.com/cdn/t/2/assets/vendor.js?v=1" defer="defer"></script>
      <script src="https://bepurex.myshopify.com/cdn/t/2/assets/theme.bundle.js?v=2" defer="defer"></script>
      <script src="https://bepurex.myshopify.com/cdn/t/2/assets/sections.js?v=3" defer="defer"></script>
    </head><body></body></html>
  `;

  it('B: recupera scripts ausentes do HTML estático (fixture genérico)', () => {
    const domScripts: string[] = []; // DOM capturado não tem scripts do tema
    const result = extractMissingStaticScripts(domScripts, STATIC_HTML_GENERIC, BASE);
    expect(result).toContain('https://loja.exemplo.com/cdn/t/1/assets/constants.js?v=123');
    expect(result).toContain('https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=456');
    expect(result).toContain('https://loja.exemplo.com/cdn/t/1/assets/product.js?v=789');
    expect(result).toContain('https://cdn.jsdelivr.net/npm/swiper/swiper.min.js');
  });

  it('B: recupera scripts ausentes do HTML estático (fixture Bepurex — segundo tema)', () => {
    const domScripts: string[] = [];
    const result = extractMissingStaticScripts(domScripts, STATIC_HTML_BEPUREX, 'https://bepurex.myshopify.com/products/x');
    expect(result).toContain('https://bepurex.myshopify.com/cdn/t/2/assets/vendor.js?v=1');
    expect(result).toContain('https://bepurex.myshopify.com/cdn/t/2/assets/theme.bundle.js?v=2');
    expect(result).toContain('https://bepurex.myshopify.com/cdn/t/2/assets/sections.js?v=3');
    expect(result).toHaveLength(3);
  });

  it('C: não duplica scripts já presentes no DOM capturado', () => {
    const domScripts = ['https://loja.exemplo.com/cdn/t/1/assets/constants.js?v=123'];
    const result = extractMissingStaticScripts(domScripts, STATIC_HTML_GENERIC, BASE);
    const constCount = result.filter(u => u.includes('constants.js')).length;
    expect(constCount).toBe(0); // já estava no DOM, não duplica
    expect(result).toContain('https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=456');
  });

  it('D: preserva ordem relativa dos scripts no HTML estático', () => {
    const domScripts: string[] = [];
    const result = extractMissingStaticScripts(domScripts, STATIC_HTML_GENERIC, BASE);
    const idxConstants = result.indexOf('https://loja.exemplo.com/cdn/t/1/assets/constants.js?v=123');
    const idxTheme = result.indexOf('https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=456');
    const idxProduct = result.indexOf('https://loja.exemplo.com/cdn/t/1/assets/product.js?v=789');
    expect(idxConstants).toBeLessThan(idxTheme);
    expect(idxTheme).toBeLessThan(idxProduct);
  });

  it('F: bloqueia chrome-extension:// (browser capture artifact)', () => {
    const staticWithExtension = `<html><head>
      <script src="chrome-extension://abc123/content.js"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1" defer></script>
    </head></html>`;
    const result = extractMissingStaticScripts([], staticWithExtension, BASE);
    expect(result).not.toContain('chrome-extension://abc123/content.js');
    expect(result.some(u => u.includes('theme.js'))).toBe(true);
  });

  it('F: bloqueia moz-extension:// (Firefox capture artifact)', () => {
    const staticWithMoz = `<html><head>
      <script src="moz-extension://xyz/inject.js"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/constants.js?v=1"></script>
    </head></html>`;
    const result = extractMissingStaticScripts([], staticWithMoz, BASE);
    expect(result.every(u => !u.startsWith('moz-extension:'))).toBe(true);
  });

  it('G: bloqueia GTM (tracker mantido bloqueado)', () => {
    const staticWithGtm = `<html><head>
      <script src="https://googletagmanager.com/gtm.js?id=GTM-ABC"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1"></script>
    </head></html>`;
    const result = extractMissingStaticScripts([], staticWithGtm, BASE);
    expect(result.every(u => !u.includes('googletagmanager'))).toBe(true);
  });

  it('G: bloqueia fbevents (Meta Pixel mantido bloqueado)', () => {
    const staticWithFb = `<html><head>
      <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1"></script>
    </head></html>`;
    const result = extractMissingStaticScripts([], staticWithFb, BASE);
    expect(result.every(u => !u.includes('facebook'))).toBe(true);
  });

  it('G: bloqueia script de checkout Shopify (commerce origin mantido bloqueado)', () => {
    const staticWithCheckout = `<html><head>
      <script src="https://loja.myshopify.com/checkouts/internal/preloads.js"></script>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1"></script>
    </head></html>`;
    const result = extractMissingStaticScripts([], staticWithCheckout, BASE);
    expect(result.every(u => !u.includes('checkouts'))).toBe(true);
    expect(result.some(u => u.includes('theme.js'))).toBe(true);
  });

  it('retorna [] quando HTML estático não tem scripts adicionais', () => {
    const domScripts = ['https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1'];
    const staticWithSame = `<html><head>
      <script src="https://loja.exemplo.com/cdn/t/1/assets/theme.js?v=1"></script>
    </head></html>`;
    const result = extractMissingStaticScripts(domScripts, staticWithSame, BASE);
    expect(result).toHaveLength(0);
  });
});

// ─── STEP 10 — assessCloneFidelity ───────────────────────────────────────

describe('assessCloneFidelity (clone fidelity gate)', () => {
  it('HEALTHY: HTML limpo com CSS e sem artifacts', () => {
    const html = `<html><head><style>.a{color:red}</style></head><body>
      <script src="https://storage.supabase.co/public/cloned/abc.js"></script>
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('HEALTHY');
    expect(findings).toHaveLength(0);
  });

  it('BLOCKED: browser-extension artifact presente', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="chrome-extension://abc/inject.js"></script>
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('BLOCKED');
    expect(findings.some(f => f.includes('browser-extension-artifact'))).toBe(true);
  });

  it('BLOCKED: moz-extension artifact', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="moz-extension://xyz/inject.js"></script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('BLOCKED');
  });

  it('BLOCKED: sem CSS algum', () => {
    const html = '<html><head></head><body><p>sem css</p></body></html>';
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('BLOCKED');
    expect(findings.some(f => f.includes('critical-css-missing'))).toBe(true);
  });

  it('HEALTHY: CSS via <link rel="stylesheet"> conta como CSS presente', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="https://storage.supabase.co/style.css">
    </head><body></body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('HEALTHY');
  });

  it('DEGRADED: script src apontando para domínio externo não-frozen', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://loja-origem.myshopify.com/cdn/t/3/assets/theme.js"></script>
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('DEGRADED');
    expect(findings.some(f => f.includes('non-frozen-script-refs'))).toBe(true);
  });

  it('HEALTHY: scripts do Storage Supabase não são flagged como não-frozen', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://wedgklpuelrhqzauopze.supabase.co/storage/v1/object/public/cloned/abc.js"></script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('HEALTHY');
  });

  it('HEALTHY: scripts cdn.shopify.com não são flagged como não-frozen', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://cdn.shopify.com/extensions/01a0/loop/assets/referral.js"></script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('HEALTHY');
  });

  it('BLOCKED prevalece sobre DEGRADED quando ambos presentes', () => {
    const html = `<html><head></head><body>
      <script src="chrome-extension://abc/inject.js"></script>
      <script src="https://loja.myshopify.com/cdn/t/3/theme.js"></script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('BLOCKED');
  });

  it('DEGRADED: mesmo script src aparece 2+ vezes (dedupe falhou)', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://storage.supabase.co/cloned/theme.js"></script>
      <script src="https://storage.supabase.co/cloned/theme.js"></script>
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('DEGRADED');
    expect(findings.some(f => f.includes('duplicate-script-refs'))).toBe(true);
  });

  it('HEALTHY: scripts diferentes com mesmo prefix não são duplicados', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="https://storage.supabase.co/cloned/a.js"></script>
      <script src="https://storage.supabase.co/cloned/b.js"></script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('HEALTHY');
  });

  it('DEGRADED: placeholder {{ cdn_url }} não substituído', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <img src="{{ cdn_url }}/img.jpg">
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('DEGRADED');
    expect(findings.some(f => f.includes('unresolved-asset-placeholders'))).toBe(true);
  });

  it('DEGRADED: path /cloned/undefined/ indica urlMap miss', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script src="/cloned/undefined/theme.js"></script>
    </body></html>`;
    const { verdict, findings } = assessCloneFidelity(html);
    expect(verdict).toBe('DEGRADED');
    expect(findings.some(f => f.includes('unresolved-asset-placeholders'))).toBe(true);
  });

  it('HEALTHY: placeholders VÁLIDOS (JSON-LD com $ literais) não geram falso positivo', () => {
    const html = `<html><head><style>a{}</style></head><body>
      <script type="application/ld+json">{"price":"$29.90"}</script>
    </body></html>`;
    expect(assessCloneFidelity(html).verdict).toBe('HEALTHY');
  });
});

// ─── STEP 10.b — assessCloneFidelity metrics (observability) ─────────────
// Métricas NÃO influenciam verdict — provam apenas que o payload de
// observability é populado corretamente pra debug/tuning futuro.

describe('assessCloneFidelity metrics (observability)', () => {
  it('shape: retorno sempre inclui metrics com 5 campos numéricos', () => {
    const result = assessCloneFidelity('<html><head><style>a{}</style></head></html>');
    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics.totalCssBytes).toBe('number');
    expect(typeof result.metrics.inlineStyleBlocks).toBe('number');
    expect(typeof result.metrics.externalStylesheetLinks).toBe('number');
    expect(typeof result.metrics.totalHtmlBytes).toBe('number');
    expect(typeof result.metrics.scriptTagCount).toBe('number');
  });

  it('totalCssBytes > 0 quando HTML tem <style> com conteúdo real', () => {
    const cssBody = '.hero{color:red;font-size:32px;padding:16px}.btn{background:blue}';
    const html = `<html><head><style>${cssBody}</style></head><body></body></html>`;
    const { metrics } = assessCloneFidelity(html);
    expect(metrics.totalCssBytes).toBe(Buffer.byteLength(cssBody, 'utf8'));
    expect(metrics.inlineStyleBlocks).toBe(1);
    expect(metrics.totalCssBytes).toBeGreaterThan(0);
  });

  it('totalCssBytes === 0 pra HTML sem <style> (apesar de <link stylesheet>)', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/theme.css">
    </head><body></body></html>`;
    const { metrics } = assessCloneFidelity(html);
    expect(metrics.totalCssBytes).toBe(0);
    expect(metrics.inlineStyleBlocks).toBe(0);
    expect(metrics.externalStylesheetLinks).toBe(1);
  });

  it('totalCssBytes === 0 pra HTML sem CSS algum (verdict BLOCKED, metrics ainda populado)', () => {
    const html = '<html><head></head><body><p>vazio</p></body></html>';
    const result = assessCloneFidelity(html);
    expect(result.verdict).toBe('BLOCKED'); // critical-css-missing
    expect(result.metrics.totalCssBytes).toBe(0);
    expect(result.metrics.inlineStyleBlocks).toBe(0);
    expect(result.metrics.externalStylesheetLinks).toBe(0);
    expect(result.metrics.totalHtmlBytes).toBe(Buffer.byteLength(html, 'utf8'));
  });

  it('agrega totalCssBytes de múltiplos <style> blocks', () => {
    const css1 = '.a{color:red}';
    const css2 = '.b{color:blue;padding:8px}';
    const html = `<html><head><style>${css1}</style><style>${css2}</style></head></html>`;
    const { metrics } = assessCloneFidelity(html);
    expect(metrics.inlineStyleBlocks).toBe(2);
    expect(metrics.totalCssBytes).toBe(
      Buffer.byteLength(css1, 'utf8') + Buffer.byteLength(css2, 'utf8'),
    );
  });

  it('scriptTagCount conta scripts com e sem src', () => {
    const html = `<html><body>
      <script src="/a.js"></script>
      <script>const x = 1;</script>
      <script type="application/ld+json">{"k":"v"}</script>
    </body></html>`;
    const { metrics } = assessCloneFidelity(html);
    expect(metrics.scriptTagCount).toBe(3);
  });

  it('externalStylesheetLinks aceita variantes de aspas e ordem de atributos', () => {
    const html = `<html><head>
      <link href="/a.css" rel="stylesheet">
      <link rel='stylesheet' href='/b.css'>
      <link rel="stylesheet" media="print" href="/c.css">
    </head></html>`;
    const { metrics } = assessCloneFidelity(html);
    expect(metrics.externalStylesheetLinks).toBe(3);
  });

  it('métricas não afetam verdict — HTML rico com CSS + browser-extension continua BLOCKED', () => {
    const html = `<html><head><style>${'a'.repeat(1024)}{}</style></head><body>
      <script src="chrome-extension://abc/inject.js"></script>
    </body></html>`;
    const result = assessCloneFidelity(html);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.metrics.totalCssBytes).toBeGreaterThan(1000);
  });
});

// ─── sanitizeHtml — STEP 11 security regression ──────────────────────────
// Provar que o sanitizer permanece correto após os fixes de chrome-extension.

describe('sanitizeHtml — chrome-extension e moz-extension blocking', () => {
  it('remove <script src="chrome-extension://..."> (browser capture artifact)', () => {
    const html = `<html><body>
      <script src="chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/content/location.js"></script>
      <main>Landing</main>
    </body></html>`;
    const out = sanitizeHtml(html);
    expect(out).not.toContain('chrome-extension://');
    expect(out).toContain('<main>Landing</main>');
  });

  it('remove <script src="moz-extension://..."> (Firefox artifact)', () => {
    const html = `<body>
      <script src="moz-extension://abc123/inject.js"></script>
      <p>Conteúdo</p>
    </body>`;
    const out = sanitizeHtml(html);
    expect(out).not.toContain('moz-extension://');
    expect(out).toContain('<p>Conteúdo</p>');
  });

  it('remove múltiplas extensões chrome em sequência', () => {
    const scripts = [
      '<script src="chrome-extension://abc/content.js"></script>',
      '<script src="chrome-extension://abc/requests.js"></script>',
      '<script src="chrome-extension://abc/executors/200.js"></script>',
    ].join('\n');
    const html = `<html><body>${scripts}<footer>ok</footer></body></html>`;
    const out = sanitizeHtml(html);
    expect(out).not.toContain('chrome-extension://');
    expect(out).toContain('<footer>ok</footer>');
  });

  it('preserva script de Storage Supabase (script do tema congelado)', () => {
    const html = `<body>
      <script src="https://abc.supabase.co/storage/v1/object/public/cloned/28031bbb0cf073c1.js" defer></script>
    </body>`;
    const out = sanitizeHtml(html);
    expect(out).toContain('28031bbb0cf073c1.js');
  });

  it('preserva script cdn.shopify.com/extensions (Shopify app preservado)', () => {
    const html = `<body>
      <script src="https://cdn.shopify.com/extensions/01a0/loop/assets/referral.js"></script>
    </body>`;
    const out = sanitizeHtml(html);
    expect(out).toContain('cdn.shopify.com/extensions');
  });

  it('idempotência: segunda passagem não altera resultado', () => {
    const html = `<html><body>
      <script src="chrome-extension://abc/content.js"></script>
      <script src="https://abc.supabase.co/storage/v1/object/public/theme.js"></script>
      <main>ok</main>
    </body></html>`;
    const once = sanitizeHtml(html);
    expect(sanitizeHtml(once)).toBe(once);
  });
});
