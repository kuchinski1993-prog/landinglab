// Import inteligente: localização de recursos, troca do player, remoção de rastreadores e política sem bloqueio.
// Fixture sintética equivalente ao ZIP real do owner (página Astro de VSL com Panda Video, Google Fonts,
// imagens externas, CSS do build ausente no ZIP, pixel Meta, carregador ofuscado do UTMify).
import { describe, expect, it } from 'vitest';

import { analyze, type Analysis } from '../analysis.js';
import { extractSource, type SourceFiles } from '../archive.js';
import { localizeResources, urlKey } from '../localize.js';
import { classifyInlineTracker, snapAspectRatio } from '../page-intelligence.js';
import type { SafeFetcher } from '../safe-fetch.js';

import { fakeFetcher, webp, woff2, zip, type Resource } from './helpers.js';

const REV = '00000000-0000-4000-8000-000000000001';
const BASE = `/__vsl/assets/${REV}/`;

const FONT_CSS = "@font-face{font-family:'Inter';src:url(https://fonts.gstatic.com/s/inter/v20/inter-400.woff2) format('woff2')}\n" +
  "@font-face{font-family:'Inter';font-weight:700;src:url(/s/inter/v20/inter-700.woff2) format('woff2')}";
const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="canonical" href="https://vsl.example.com/">
<link rel="stylesheet" href="/_astro/global.DAmxavnM.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
<script type="module">(function(){function m(n){var e=document.cookie.match(new RegExp("(?:^|; )"+n+"=([^;]*)"));return e?e[1]:null}
function l(n){if(typeof window.fbq=="function")window.fbq("track",n,{},{eventID:"1"});navigator.sendBeacon("https://x.supabase.co/functions/v1/meta-track-event",m("_fbp"))}
window.metaTrack=l;l("PageView")})();</script>
<script>(function(){const pixelIds=["123"];!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
for(var i=0;i<pixelIds.length;i++){fbq('init',pixelIds[i])}fbq('track','PageView')})();</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
</head><body>
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=123&ev=PageView&noscript=1"></noscript>
<img class="logo" src="https://i.postimg.cc/abc/logo.webp" alt="Logo">
<img src="https://cdn.example.net/hero.webp" srcset="https://cdn.example.net/hero.webp 1x, https://cdn.example.net/hero@2x.webp 2x" alt="">
<img data-img-f="https://cdn.example.net/f.webp" data-img-m="https://cdn.example.net/m.webp" src="https://cdn.example.net/f.webp" alt="">
<div class="vslwrap" id="qzVsl"><div style="position:relative;padding-top:177.77777777777777%;"><iframe id="panda-1" src="https://player-vz-bbe2952a-d06.tv.pandavideo.com/embed/?v=d0046db3" style="border:none;position:absolute;top:0;left:0;" allowfullscreen width="100%" height="100%"></iframe></div></div>
<a class="cta" href="/checkout">Quiero mi plan</a>
<iframe src="https://widgets.example.org/reviews"></iframe>
<script>(function(){var f=atob("AAAA");var z=document.createElement("script");z.src=f;z.async=true;(document.head||document.documentElement).appendChild(z);})();</script>
<script>var quiz={step:1};document.getElementById('qzVsl').classList.add('on');</script>
</body></html>`;

const RESOURCES: Record<string, Resource> = {
  'https://vsl.example.com/_astro/global.DAmxavnM.css': { contentType: 'text/css', body: 'body{background:url(/img/bg.webp)}' },
  'https://vsl.example.com/img/bg.webp': { contentType: 'image/webp', body: webp() },
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap': { contentType: 'text/css; charset=utf-8', body: FONT_CSS },
  'https://fonts.gstatic.com/s/inter/v20/inter-400.woff2': { contentType: 'font/woff2', body: woff2() },
  'https://fonts.googleapis.com/s/inter/v20/inter-700.woff2': { contentType: 'font/woff2', body: woff2() },
  'https://i.postimg.cc/abc/logo.webp': { contentType: 'image/webp', body: webp() },
  'https://cdn.example.net/hero.webp': { contentType: 'image/webp', body: webp() },
  'https://cdn.example.net/hero@2x.webp': { contentType: 'image/webp', body: webp() },
  'https://cdn.example.net/f.webp': { contentType: 'image/webp', body: webp() },
  'https://cdn.example.net/m.webp': { contentType: 'application/octet-stream', body: webp() },
};

async function smart(files: SourceFiles, fetcher: SafeFetcher, sourceUrl?: string): Promise<Analysis> {
  const { files: all, localization } = await localizeResources(files, 'index.html', { fetcher, sourceUrl });
  return analyze(all, 'index.html', { requiredTargets: [], allowForms: true, assetBasePath: BASE, runtimeTrackerRemoval: true, smartImport: true, localization });
}
const html = (result: Analysis) => result.files.find((file) => file.path === 'index.html')!.bytes.toString();

describe('import inteligente', () => {
  it('traz CSS, fontes (Google Fonts) e imagens para a revisão e reescreve as URLs', async () => {
    const fetcher = fakeFetcher(RESOURCES);
    const result = await smart(extractSource(Buffer.from(PAGE), 'html'), fetcher);
    const out = html(result);
    expect(result.report.pending).toEqual([]);
    expect(result.report.findings.some((finding) => finding.severity === 'blocking')).toBe(false);
    // CSS do build ausente: recuperado da origem canônica no mesmo caminho.
    expect(result.manifest.files['_astro/global.DAmxavnM.css']).toBeTruthy();
    expect(out).toContain(`href="${BASE}_astro/global.DAmxavnM.css"`);
    const globalCss = result.files.find((file) => file.path === '_astro/global.DAmxavnM.css')!.bytes.toString();
    expect(globalCss).toContain(`${BASE}img/bg.webp`);
    // Google Fonts css2 → CSS local + woff2 locais (absolutos e relativos ao CSS baixado).
    expect(out).not.toContain('href="https://fonts.googleapis.com/css2');
    const fontCssPath = Object.keys(result.manifest.files).find((file) => file.startsWith('_external/fonts.googleapis.com/') && file.endsWith('.css'))!;
    const fontCss = result.files.find((file) => file.path === fontCssPath)!.bytes.toString();
    expect(fontCss).not.toMatch(/https:\/\/fonts\.gstatic\.com|url\(\/s\//);
    expect(fontCss.match(new RegExp(`${BASE}_external/fonts\\.(?:gstatic|googleapis)\\.com/[0-9a-f]{10}-inter-[47]00\\.woff2`, 'g'))).toHaveLength(2);
    // Imagens (src, srcset, data-*) locais.
    expect(out).not.toMatch(/https:\/\/(?:i\.postimg\.cc|cdn\.example\.net)/);
    expect(out).toMatch(new RegExp(`data-img-m="${BASE}_external/cdn\\.example\\.net/[0-9a-f]{10}-m\\.webp"`));
    expect(result.report.summary?.localized).toMatchObject({ images: 6, fonts: 2, styles: 2 });
    expect(result.report.summary?.recovered).toEqual([{ path: '_astro/global.DAmxavnM.css', from: 'site' }, { path: 'img/bg.webp', from: 'site' }]);
    expect(result.report.summary?.pageUrl).toBe('https://vsl.example.com/');
    expect(result.report.summary?.originFrom).toBe('canonical');
    // Rastreadores e players nunca são baixados.
    expect(fetcher.requested.some((url) => /facebook|googletagmanager|pandavideo/.test(url))).toBe(false);
  });

  it('troca o player do Panda Video pelo marcador do VSL preservando a proporção e remove rastreadores', async () => {
    const result = await smart(extractSource(Buffer.from(PAGE), 'html'), fakeFetcher(RESOURCES));
    const out = html(result);
    expect(out).toContain('<div class="vslwrap" id="qzVsl"><div data-blackshop-video data-blackshop-aspect-ratio="9:16" style="width:100%"></div></div>');
    expect(out).not.toContain('pandavideo');
    expect(result.report.summary?.player).toEqual({ provider: 'Panda Video', providerId: 'panda', aspectRatio: '9:16' });
    // Meta (CAPI + pixel), GTM e o carregador ofuscado saem; o pixel <noscript> também.
    expect(out).not.toMatch(/fbq|fbevents|googletagmanager|facebook\.com\/tr|atob\(/);
    expect(result.report.summary?.trackersRemoved).toEqual(['Meta Pixel', 'Meta Pixel', 'Google Analytics / Tag Manager', 'Carregador ofuscado de rastreador']);
    // Código da página continua.
    expect(out).toContain("var quiz={step:1}");
    // Link de navegação nunca bloqueia; iframe de terceiro fica e a origem vai para frame-src.
    expect(result.report.findings.find((finding) => finding.evidence === '/checkout')).toMatchObject({ category: 'navigation-link', severity: 'info' });
    expect(out).toContain('src="https://widgets.example.org/reviews"');
    expect(result.report.config.frameOrigins).toEqual(['https://widgets.example.org']);
    expect(result.report.findings.find((finding) => finding.category === 'iframe-authorized')?.severity).toBe('warning');
    expect(result.report.config).not.toHaveProperty('localization');
  });

  it('download que falha não bloqueia: fica externo e a origem é autorizada na CSP', async () => {
    const resources = { ...RESOURCES };
    delete resources['https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'];
    resources['https://cdn.example.net/hero.webp'] = { contentType: 'text/html', body: '<html>bloqueado</html>' };
    const result = await smart(extractSource(Buffer.from(PAGE), 'html'), fakeFetcher(resources));
    const out = html(result);
    expect(out).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"');
    expect(out).toContain('src="https://cdn.example.net/hero.webp"');
    expect(result.report.config.externalOrigins).toEqual(['https://fonts.googleapis.com']); // imagem não precisa (img-src https:)
    expect(result.report.findings.filter((finding) => finding.category === 'external-kept').every((finding) => finding.severity === 'warning')).toBe(true);
    expect(result.report.pending).toEqual([]);
    expect(result.report.summary?.keptExternal).toBe(2);
  });

  it('sem URL de origem: arquivo ausente vira aviso; com o campo "URL de origem" ele é buscado', async () => {
    const page = Buffer.from('<html><head><link rel="stylesheet" href="/_astro/app.css"></head><body><h1>Oferta</h1><img src="assets/a.webp"></body></html>');
    const fetcher = fakeFetcher({
      'https://loja.example.com/_astro/app.css': { contentType: 'text/css', body: 'h1{color:red}' },
      'https://loja.example.com/vsl/assets/a.webp': { contentType: 'image/webp', body: webp() },
    });
    const offline = await smart(extractSource(page, 'html'), fetcher);
    expect(offline.report.summary?.missing).toEqual([{ path: '_astro/app.css', file: 'index.html' }, { path: 'assets/a.webp', file: 'index.html' }]);
    expect(offline.report.findings.find((finding) => finding.category === 'missing-dependency')?.severity).toBe('warning');
    expect(offline.report.pending).toEqual([]);
    expect(fetcher.requested).toEqual([]);

    const online = await smart(extractSource(page, 'html'), fetcher, 'https://loja.example.com/vsl/');
    expect(online.report.summary?.missing).toEqual([]);
    expect(online.report.summary?.originFrom).toBe('config');
    expect(html(online)).toContain(`href="${BASE}_astro/app.css"`);
    expect(html(online)).toContain(`src="${BASE}assets/a.webp"`);
  });

  it('build com hash novo: procura o mesmo arquivo na página publicada', async () => {
    const page = Buffer.from('<html><head><link rel="canonical" href="https://vsl.example.com/"><link rel="stylesheet" href="/_astro/global.OLDHASH1.css"></head><body><h1>x</h1></body></html>');
    const fetcher = fakeFetcher({
      'https://vsl.example.com/': { contentType: 'text/html; charset=utf-8', body: '<html><head><link rel="stylesheet" href="/_astro/global.NEWHASH2.css"></head></html>' },
      'https://vsl.example.com/_astro/global.NEWHASH2.css': { contentType: 'text/css', body: 'h1{color:blue}' },
    });
    const result = await smart(extractSource(page, 'html'), fetcher);
    expect(result.files.find((file) => file.path === '_astro/global.OLDHASH1.css')?.bytes.toString()).toBe('h1{color:blue}');
    expect(result.report.summary?.missing).toEqual([]);
  });

  it('usa o mapa de ferramentas de "salvar página" (manifest.json + report.json) sem rede', async () => {
    const source = zip([
      { name: 'index.html', bytes: Buffer.from('<html><head><link rel="stylesheet" href="/_astro/global.X1Y2Z3W4.css"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap" rel="stylesheet"></head><body><h1>x</h1></body></html>') },
      { name: 'assets/css/1.css', bytes: Buffer.from('h1{font-family:Inter}') },
      { name: 'assets/css/2.css', bytes: Buffer.from("@font-face{font-family:Inter;src:url(../fonts/a.woff2)}") },
      { name: 'assets/fonts/a.woff2', bytes: woff2() },
      { name: 'report.json', bytes: Buffer.from('{"pageUrl":"https://saved.example.com/"}') },
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify({
        'https://saved.example.com/_astro/global.X1Y2Z3W4.css': 'assets/css/1.css',
        'https://fonts.googleapis.com/css2?family=Inter%3Awght%40400&display=swap': 'assets/css/2.css',
      })) },
    ]);
    const fetcher = fakeFetcher({});
    const result = await smart(extractSource(source, 'zip'), fetcher);
    expect(fetcher.requested).toEqual([]);
    const out = html(result);
    expect(out).toContain(`href="${BASE}assets/css/1.css"`);
    expect(out).toContain(`href="${BASE}assets/css/2.css"`);
    expect(result.report.summary).toMatchObject({ pageUrl: 'https://saved.example.com/', originFrom: 'saved-page',
      recovered: [{ path: '_astro/global.X1Y2Z3W4.css', from: 'saved-page' }], missing: [] });
    expect(result.manifest.files['manifest.json']).toBeUndefined();
    expect(result.report.findings.find((finding) => finding.file === 'manifest.json')?.severity).toBe('info');
  });

  it('VTurb (smartplayer) vira o marcador e os scripts do player saem; páginas com marcador não são tocadas', async () => {
    const page = Buffer.from(`<html><head><link rel="preload" href="https://scripts.converteai.net/abc/players/123/player.js" as="script">
<script>!function(i,n){i._plt=i._plt||(n&&n.timeOrigin?n.timeOrigin+n.now():Date.now())}(window,performance);</script></head><body>
<vturb-smartplayer id="vid-123" style="display:block;margin:0 auto;width:100%;max-width:400px"><div class="vturb-player-placeholder" style="position:relative;width:100%;padding:56.25% 0 0"></div></vturb-smartplayer>
<script async src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"x"}'></script>
<script type="text/javascript">var s=document.createElement("script");s.src="https://scripts.converteai.net/abc/players/123/v4/player.js",s.async=!0,document.head.appendChild(s);</script>
</body></html>`);
    const result = await smart(extractSource(page, 'html'), fakeFetcher({}));
    const out = html(result);
    expect(out).toContain('<div data-blackshop-video data-blackshop-aspect-ratio="16:9" style="width:100%;max-width:400px;margin:0 auto"></div>');
    expect(out).not.toMatch(/converteai|_plt|vturb-smartplayer/);
    expect(result.report.summary?.player?.provider).toBe('VTurb (ConverteAI)');
    expect(result.report.summary?.trackersRemoved).toEqual(['Cloudflare Web Analytics']);

    const marked = Buffer.from('<html><body><div data-blackshop-video></div><iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>');
    const kept = await smart(extractSource(marked, 'html'), fakeFetcher({}));
    expect(html(kept)).toContain('src="https://www.youtube.com/embed/abc"');
    expect(kept.report.summary?.player).toBeNull();
    expect(kept.report.config.frameOrigins).toEqual(['https://www.youtube.com']);
    expect(kept.report.findings.find((finding) => finding.category === 'video-player-kept')?.severity).toBe('warning');
  });

  it('nunca exige decisão: scripts de cookies/domínio, base, módulos externos e caminhos inválidos viram aviso', async () => {
    const page = Buffer.from(`<html><head><base href="https://orig.example.com/"></head><body>
<script>document.cookie="a=1";var app=1;</script><script type="module">import x from "lib"; console.log(x)</script>
<script>fetch("https://api.example.com/x")</script><img src="../../../etc/passwd"><form action="/buy"><button>Comprar</button></form>
<object data="https://x.example.com/a.swf"></object></body></html>`);
    const result = await smart(extractSource(page, 'html'), fakeFetcher({}));
    expect(result.report.pending).toEqual([]);
    expect(result.report.findings.every((finding) => finding.severity !== 'blocking')).toBe(true);
    expect(html(result)).not.toContain('<base');
    expect(result.report.summary?.pageUrl).toBe('https://orig.example.com/');
    // Sem `resolutions`/justificativa em lugar nenhum.
    expect(result.report.config).not.toHaveProperty('resolutions');
  });

  it('aplica limites: recursos acima do teto ficam externos', async () => {
    const page = Buffer.from('<html><body><img src="https://cdn.example.net/hero.webp"><img src="https://cdn.example.net/f.webp"></body></html>');
    const { localization } = await localizeResources(extractSource(page, 'html'), 'index.html', { fetcher: fakeFetcher(RESOURCES), limits: { maxResources: 1 } });
    expect(localization.downloaded).toHaveLength(1);
    expect(localization.failed).toEqual([expect.objectContaining({ reason: 'limit_resources' })]);
  });

  it('classifica scripts inline e proporções', () => {
    expect(classifyInlineTracker("fbq('init','1');fbq('track','PageView')")).toEqual({ kind: 'tracker', name: 'Meta Pixel' });
    expect(classifyInlineTracker("var quiz={q:1}; fbq('init','999')")).toEqual({ kind: 'mixed' });
    expect(classifyInlineTracker("gtag('config','G-1'); document.body.innerHTML='x'")).toEqual({ kind: 'mixed' });
    expect(classifyInlineTracker('console.log(1)')).toBeNull();
    expect(snapAspectRatio(100, 56.25)).toBe('16:9');
    expect(snapAspectRatio(100, 177.78)).toBe('9:16');
    expect(urlKey(new URL('https://a.com/css2?family=Inter%3Awght%40400'))).toBe(urlKey(new URL('https://a.com/css2?family=Inter:wght@400')));
  });
});
