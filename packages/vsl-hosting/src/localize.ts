// Import inteligente — etapa de localização (antes da análise): descobre a URL original da página, resolve
// referências por (1) arquivos do ZIP, (2) mapa de ferramentas "salvar página" (manifest.json URL → arquivo) e
// (3) download protegido (safe-fetch) de CSS, fontes, imagens e scripts de CDN conhecidas — inclusive arquivos
// locais que não vieram no ZIP (ex.: /_astro/*.css) quando a origem é conhecida. O resultado é um mapa
// URL absoluta → caminho na revisão; `analyze` reescreve as referências para /__vsl/assets/<rev>/...
// Falha de download nunca bloqueia: o recurso fica externo (a análise autoriza a origem na CSP, com aviso).
import { createHash } from 'node:crypto';
import path from 'node:path';

import { parse } from 'parse5';
// @ts-expect-error -- parse-srcset 1.x publishes no types; the boundary below is explicitly typed.
import parseSrcsetUntyped from 'parse-srcset';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import { validateFile, type SourceFile, type SourceFiles } from './archive.js';
import { isStaticCdnScript, isTrackerHost, isTrackerPixelUrl, playerByHost } from './page-intelligence.js';
import { parsePublicHttpUrl, safeFetch, SafeFetchError, type SafeFetcher, type SafeFetchOptions } from './safe-fetch.js';
import { safePath } from './storage.js';

const parseSrcset = parseSrcsetUntyped as (value: string) => Array<{ url: string }>;

export const LOCALIZE_LIMITS = {
  /** Recursos baixados por import. */
  maxResources: 300,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  timeoutMs: 12_000,
  /** Orçamento total de rede do import (o lease do job é renovado durante a etapa). */
  budgetMs: 120_000,
  maxRedirects: 3,
  concurrency: 6,
  /** CSS baixado que importa CSS que importa ... */
  maxDepth: 3,
};

export type ResourceKind = 'style' | 'font' | 'image' | 'script';
export type OriginSource = 'config' | 'canonical' | 'og:url' | 'base' | 'saved-page';

export interface LocalizedResource { path: string; url: string; kind: ResourceKind; recovered: boolean }
export interface FailedResource { url: string; kind: ResourceKind; reason: string }

export interface Localization {
  /** Chave canônica (urlKey) da URL absoluta → caminho do arquivo na revisão. */
  urlMap: Record<string, string>;
  /** Caminho na revisão → URL absoluta de onde veio (base para referências relativas). */
  fileUrls: Record<string, string>;
  pageUrl: string | null;
  originFrom: OriginSource | null;
  downloaded: LocalizedResource[];
  failed: FailedResource[];
  /** Arquivos de bibliotecas baixadas de CDN: não passam pela análise de scripts. */
  vendorPaths: string[];
}

export interface LocalizeOptions {
  sourceUrl?: string | null;
  fetcher?: SafeFetcher;
  /** Injeção para testes (resolver DNS, portas, bloqueio). */
  fetchOptions?: Partial<SafeFetchOptions>;
  limits?: Partial<typeof LOCALIZE_LIMITS>;
  /** Chamado a cada recurso processado (o job renova o lease aqui). Pode lançar para abortar. */
  onProgress?: (done: number, queued: number) => Promise<void> | void;
}

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/** Chave estável de uma URL (ignora #fragmento e diferenças de codificação: `Inter:wght@400` = `Inter%3Awght%40400`). */
export function urlKey(url: URL): string {
  const search = url.search ? `?${url.search.slice(1).split('&').map((part) => decode(part.replace(/\+/g, ' '))).join('&')}` : '';
  return `${url.protocol}//${url.host.toLowerCase()}${decode(url.pathname)}${search}`;
}

const SKIP_SCHEME = /^(?:data:|mailto:|tel:|blob:|javascript:|about:|sms:|whatsapp:)/i;

/** Resolve referências de arquivos da revisão para URLs absolutas (mesma regra na localização e na análise). */
export class ReferenceResolver {
  constructor(readonly entryPath: string, readonly pageUrl: string | null, readonly fileUrls: Record<string, string> = {}) {}

  /** URL de onde o arquivo veio (ou onde estaria no site original, pela posição relativa à página principal). */
  fileUrl(filePath: string): URL | null {
    const known = this.fileUrls[filePath];
    if (known) return new URL(known);
    if (!this.pageUrl) return null;
    if (filePath === this.entryPath) return new URL(this.pageUrl);
    const relative = path.posix.relative(path.posix.dirname(this.entryPath), filePath);
    try { return new URL(relative.split('/').map(encodeURIComponent).join('/'), this.pageUrl); } catch { return null; }
  }

  absolute(filePath: string, raw: string): URL | null {
    const value = raw.trim();
    if (!value || value.startsWith('#') || SKIP_SCHEME.test(value)) return null;
    let url: URL;
    try {
      if (/^\/\//.test(value)) url = new URL(`https:${value}`);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) url = new URL(value);
      else {
        const base = this.fileUrl(filePath);
        if (!base) return null;
        url = new URL(value, base);
      }
    } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url;
  }
}

/** Caminho no ZIP de uma referência relativa (null se for externa/inválida). */
export function localPath(filePath: string, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('#') || SKIP_SCHEME.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return null;
  const clean = value.split(/[?#]/)[0]!;
  if (!clean) return null;
  try {
    const base = clean.startsWith('/') ? '' : path.posix.dirname(filePath);
    return safePath(path.posix.normalize(path.posix.join(base, decode(clean).replace(/^\/+/, ''))));
  } catch { return null; }
}

interface Reference { raw: string; kind: ResourceKind }

type Node = {
  nodeName: string; tagName?: string; attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[]; content?: Node; value?: string;
};

const FONT_EXT = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico)(?:[?#]|$)/i;

/** Referências de CSS: @import → estilo; url() em @font-face ou com extensão de fonte → fonte; resto → imagem. */
export function cssReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  let tree: postcss.Root;
  try { tree = postcss.parse(text); } catch { return refs; }
  tree.walkAtRules('import', (rule) => {
    const first = valueParser(rule.params).nodes[0];
    if (first?.type === 'string') refs.push({ raw: first.value, kind: 'style' });
    else if (first?.type === 'function' && first.value.toLowerCase() === 'url' && first.nodes[0])
      refs.push({ raw: first.nodes[0].value, kind: 'style' });
  });
  tree.walkDecls((decl) => {
    const inFontFace = decl.parent?.type === 'atrule' && (decl.parent as postcss.AtRule).name.toLowerCase() === 'font-face';
    valueParser(decl.value).walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url' && node.nodes[0]) {
        const raw = node.nodes[0].value;
        refs.push({ raw, kind: inFontFace || FONT_EXT.test(raw) ? 'font' : 'image' });
      }
    });
  });
  return refs;
}

export interface PageHints { canonical?: string; ogUrl?: string; base?: string }

/** Referências de um HTML que vale trazer para o servidor + pistas da URL original (canonical, og:url, base). */
export function htmlReferences(text: string): { refs: Reference[]; hints: PageHints } {
  const refs: Reference[] = [];
  const hints: PageHints = {};
  const tree = parse(text) as unknown as Node;
  const walk = (node: Node, parentTag?: string): void => {
    const tag = node.tagName ?? '';
    const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
    if (tag === 'link') {
      const rel = (attrs['rel'] ?? '').toLowerCase().split(/\s+/);
      const as = (attrs['as'] ?? '').toLowerCase();
      const href = attrs['href'];
      if (rel.includes('canonical') && href) hints.canonical ??= href;
      else if (href && rel.includes('stylesheet')) refs.push({ raw: href, kind: 'style' });
      else if (href && (rel.includes('preload') || rel.includes('prefetch') || rel.includes('modulepreload'))) {
        if (as === 'style') refs.push({ raw: href, kind: 'style' });
        else if (as === 'font') refs.push({ raw: href, kind: 'font' });
        else if (as === 'image') refs.push({ raw: href, kind: 'image' });
        else if (as === 'script' || rel.includes('modulepreload')) refs.push({ raw: href, kind: 'script' });
      } else if (href && rel.some((item) => ['icon', 'apple-touch-icon', 'shortcut'].includes(item))) refs.push({ raw: href, kind: 'image' });
    }
    if (tag === 'meta' && /^og:url$/i.test(attrs['property'] ?? '') && attrs['content']) hints.ogUrl ??= attrs['content'];
    if (tag === 'base' && attrs['href']) hints.base ??= attrs['href'];
    if (tag === 'script' && attrs['src']) refs.push({ raw: attrs['src'], kind: 'script' });
    if ((tag === 'img' || (tag === 'source' && parentTag === 'picture') || (tag === 'input' && /^image$/i.test(attrs['type'] ?? ''))) && attrs['src'])
      refs.push({ raw: attrs['src'], kind: 'image' });
    if ((tag === 'img' || (tag === 'source' && parentTag === 'picture')) && attrs['srcset'])
      for (const candidate of parseSrcset(attrs['srcset'])) refs.push({ raw: candidate.url, kind: 'image' });
    if (tag === 'video' && attrs['poster']) refs.push({ raw: attrs['poster'], kind: 'image' });
    for (const attr of node.attrs ?? []) {
      if (attr.name === 'style') refs.push(...cssReferences(`vsl{${attr.value}}`));
      // Imagens trocadas por script (data-src, data-img-*, data-bg ...): só URLs absolutas com extensão de imagem.
      if (attr.name.startsWith('data-') && /^(?:https?:)?\/\//i.test(attr.value.trim()) && IMAGE_EXT.test(attr.value.trim()))
        refs.push({ raw: attr.value.trim(), kind: 'image' });
    }
    if (tag === 'style') for (const child of node.childNodes ?? []) if (child.value) refs.push(...cssReferences(child.value));
    for (const child of node.childNodes ?? []) walk(child, tag || parentTag);
    if (node.content) walk(node.content, tag);
  };
  walk(tree);
  return { refs, hints };
}

const MIME_EXT: Array<[RegExp, string, ResourceKind]> = [
  [/^text\/css\b/, 'css', 'style'],
  [/^font\/woff2\b|application\/font-woff2/, 'woff2', 'font'],
  [/^font\/woff\b|application\/(?:x-)?font-woff\b/, 'woff', 'font'],
  [/^font\/ttf\b|application\/(?:x-)?font-ttf|application\/x-font-truetype/, 'ttf', 'font'],
  [/^font\/otf\b|application\/(?:x-)?font-otf|application\/x-font-opentype|font\/opentype/, 'otf', 'font'],
  [/^image\/png\b/, 'png', 'image'],
  [/^image\/jpe?g\b/, 'jpg', 'image'],
  [/^image\/gif\b/, 'gif', 'image'],
  [/^image\/webp\b/, 'webp', 'image'],
  [/^image\/avif\b/, 'avif', 'image'],
  [/^image\/svg\+xml\b/, 'svg', 'image'],
  [/^image\/(?:x-icon|vnd\.microsoft\.icon)\b/, 'ico', 'image'],
  [/^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b/, 'js', 'script'],
];
const EXT_KIND: Record<string, ResourceKind> = {
  css: 'style', woff2: 'font', woff: 'font', ttf: 'font', otf: 'font', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', avif: 'image', svg: 'image', ico: 'image', js: 'script', mjs: 'script',
};

/** Extensão do arquivo baixado: pelo content-type; se genérico (octet-stream), pela extensão da URL. */
function extensionFor(contentType: string, url: URL, kind: ResourceKind): string | null {
  const byMime = MIME_EXT.find(([pattern]) => pattern.test(contentType));
  if (byMime) return byMime[2] === kind || (kind === 'image' && byMime[2] === 'image') ? byMime[1] : null;
  if (contentType && !/^(?:application|binary)\/octet-stream\b|^text\/plain\b/.test(contentType)) return null;
  const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  return EXT_KIND[ext] === kind ? (ext === 'jpeg' ? 'jpg' : ext === 'mjs' ? 'js' : ext) : null;
}

const RESERVED = (candidate: string) => candidate === 'manifest.json' || candidate.split('/').some((part) => part === '__vsl' || part === '.sealed' || part.startsWith('.'));

/** Descobre a URL original: campo do import → canonical → og:url → base → relatório de ferramenta de "salvar página". */
function discoverPageUrl(files: SourceFiles, entry: SourceFile, sourceUrl: string | null | undefined, allowedPorts: string[]):
  { pageUrl: string | null; originFrom: OriginSource | null } {
  const candidates: Array<[OriginSource, string | undefined]> = [['config', sourceUrl ?? undefined]];
  const { hints } = htmlReferences(entry.bytes.toString('utf8'));
  candidates.push(['canonical', hints.canonical], ['og:url', hints.ogUrl], ['base', hints.base]);
  const report = files.find((file) => file.path === 'report.json');
  if (report) {
    try {
      const value = JSON.parse(report.bytes.toString('utf8')) as { pageUrl?: unknown; url?: unknown };
      const pageUrl = typeof value.pageUrl === 'string' ? value.pageUrl : typeof value.url === 'string' ? value.url : undefined;
      candidates.push(['saved-page', pageUrl]);
    } catch { /* não é relatório de ferramenta */ }
  }
  for (const [from, raw] of candidates) {
    if (!raw || !/^https?:\/\//i.test(raw.trim())) continue;
    try { return { pageUrl: parsePublicHttpUrl(raw, allowedPorts).href, originFrom: from }; } catch { /* próxima pista */ }
  }
  return { pageUrl: null, originFrom: null };
}

/** Mapa de ferramentas de "salvar página": `manifest.json` na raiz com { "<url original>": "<arquivo no ZIP>" }. */
function savedPageMap(files: SourceFiles, names: Set<string>): Record<string, string> {
  const raw = files.discarded?.find((item) => item.path === 'manifest.json' && item.bytes)?.bytes;
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
    if (typeof target !== 'string' || !/^https?:\/\//i.test(key)) continue;
    let file: string;
    try { file = safePath(target.replace(/^\.?\//, '')); } catch { continue; }
    if (!names.has(file)) continue;
    try { map[urlKey(new URL(key))] = file; } catch { /* URL inválida */ }
  }
  return map;
}

interface Task { url: URL; kind: ResourceKind; depth: number; recovered: boolean; wanted?: string }

/** Localiza recursos (ver cabeçalho). Não lança por falha de rede: falhas vão em `failed`. */
export async function localizeResources(input: SourceFiles, entryPath: string, options: LocalizeOptions = {}):
  Promise<{ files: SourceFiles; localization: Localization }> {
  const limits = { ...LOCALIZE_LIMITS, ...options.limits };
  const fetcher = options.fetcher ?? safeFetch;
  const allowedPorts = options.fetchOptions?.allowedPorts ?? [];
  const files: SourceFiles = [...input];
  if (input.discarded) files.discarded = input.discarded;
  const names = new Set(files.map((file) => file.path));
  const lower = new Set(files.map((file) => file.path.toLowerCase()));
  const entry = files.find((file) => file.path === entryPath);
  const { pageUrl, originFrom } = entry ? discoverPageUrl(files, entry, options.sourceUrl, allowedPorts) : { pageUrl: null, originFrom: null };
  const pageOrigin = pageUrl ? new URL(pageUrl).origin : null;
  const localization: Localization = {
    urlMap: savedPageMap(files, names), fileUrls: {}, pageUrl, originFrom, downloaded: [], failed: [], vendorPaths: [],
  };
  const resolver = new ReferenceResolver(entryPath, pageUrl, localization.fileUrls);
  const queued = new Set<string>(Object.keys(localization.urlMap));
  const tasks: Task[] = [];
  const started = Date.now();
  let totalBytes = 0;
  let attempted = 0;

  const enqueue = (filePath: string, ref: Reference, depth: number) => {
    const raw = ref.raw.trim();
    const local = localPath(filePath, raw);
    if (local && names.has(local)) return;
    const url = resolver.absolute(filePath, raw);
    if (!url) return;
    const key = urlKey(url);
    if (queued.has(key)) return;
    if (isTrackerHost(url.href) || isTrackerPixelUrl(url.href) || playerByHost(url.href)) return;
    const sameOrigin = pageOrigin !== null && url.origin === pageOrigin;
    // Scripts: só bibliotecas de CDN pública ou arquivos do próprio site que não vieram no ZIP.
    if (ref.kind === 'script' && !isStaticCdnScript(url.href) && !sameOrigin) return;
    queued.add(key);
    tasks.push({ url, kind: ref.kind, depth, recovered: Boolean(local) && sameOrigin, wanted: local && sameOrigin ? local : undefined });
  };

  for (const file of files) {
    if (file.mime === 'text/html') for (const ref of htmlReferences(file.bytes.toString('utf8')).refs) enqueue(file.path, ref, 0);
    else if (file.mime === 'text/css') for (const ref of cssReferences(file.bytes.toString('utf8'))) enqueue(file.path, ref, 0);
  }

  const choosePath = (task: Task, finalUrl: URL, ext: string): string => {
    const fits = (candidate: string) => !names.has(candidate) && !lower.has(candidate.toLowerCase()) && !RESERVED(candidate) &&
      candidate.split('.').pop()?.toLowerCase() === ext && ![...names].some((name) => name.startsWith(`${candidate}/`) || candidate.startsWith(`${name}/`));
    if (task.wanted && fits(task.wanted)) return task.wanted;
    const hash = createHash('sha256').update(urlKey(finalUrl)).digest('hex').slice(0, 10);
    const base = (decode(finalUrl.pathname.split('/').pop() ?? '').replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'arquivo').slice(0, 40);
    const host = finalUrl.hostname.replace(/[^a-z0-9.-]/gi, '-');
    return `_external/${host}/${hash}-${base}.${ext}`;
  };

  // HTML atual da página original (uma vez por import), para achar arquivos de build cujo hash mudou.
  let livePage: Promise<Reference[]> | null = null;
  const currentHashedName = async (missing: URL): Promise<URL | null> => {
    const match = /^(.*\/)?([^/]+)\.[A-Za-z0-9_-]{6,}\.(css|js|mjs)$/.exec(missing.pathname);
    if (!match || !pageUrl || missing.origin !== pageOrigin) return null;
    livePage ??= fetcher(pageUrl, { maxBytes: 5 * 1024 * 1024, timeoutMs: limits.timeoutMs, maxRedirects: limits.maxRedirects,
      accept: 'text/html', ...options.fetchOptions })
      .then((page) => (/^(?:text\/html|application\/xhtml\+xml)\b/.test(page.contentType) ? htmlReferences(page.bytes.toString('utf8')).refs : []))
      .catch(() => []);
    const [, dir = '/', name, ext] = match;
    for (const ref of await livePage) {
      let candidate: URL;
      try { candidate = new URL(ref.raw, pageUrl); } catch { continue; }
      const other = /^(.*\/)?([^/]+)\.[A-Za-z0-9_-]{6,}\.(css|js|mjs)$/.exec(candidate.pathname);
      if (candidate.origin === pageOrigin && other && (other[1] ?? '/') === dir && other[2] === name && other[3] === ext && candidate.pathname !== missing.pathname)
        return candidate;
    }
    return null;
  };

  const fail = (task: Task, reason: string): void => { localization.failed.push({ url: task.url.href, kind: task.kind, reason }); };

  const run = async (task: Task): Promise<void> => {
    if (attempted >= limits.maxResources) return fail(task, 'limit_resources');
    attempted++;
    if (Date.now() - started > limits.budgetMs) return fail(task, 'limit_time');
    if (totalBytes >= limits.maxTotalBytes) return fail(task, 'limit_total_bytes');
    const get = (url: string) => fetcher(url, {
      maxBytes: Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes), timeoutMs: limits.timeoutMs, maxRedirects: limits.maxRedirects,
      accept: task.kind === 'style' ? 'text/css,*/*;q=0.1' : task.kind === 'image' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : '*/*',
      ...options.fetchOptions,
    });
    let response;
    try {
      response = await get(task.url.href);
    } catch (error) {
      // Build com hash (Astro/Vite: global.DAmxavnM.css) que mudou no site: procura o mesmo arquivo com o hash atual.
      const renamed = error instanceof SafeFetchError && error.status === 404 && task.recovered ? await currentHashedName(task.url) : null;
      if (renamed) {
        try { response = await get(renamed.href); } catch { /* cai na falha abaixo */ }
      }
      if (!response) return fail(task, error instanceof SafeFetchError ? (error.reason === 'too_large' ? 'limit_file_bytes' : error.reason) : 'network');
    }
    const ext = extensionFor(response.contentType, response.url, task.kind);
    if (!ext) return fail(task, 'content_type');
    const target = choosePath(task, response.url, ext);
    let file: SourceFile;
    try { file = validateFile(target, response.bytes); }
    catch { return fail(task, 'invalid_content'); }
    if (names.has(file.path)) return fail(task, 'path_conflict');
    totalBytes += file.bytes.length;
    names.add(file.path);
    lower.add(file.path.toLowerCase());
    files.push(file);
    localization.urlMap[urlKey(task.url)] = file.path;
    localization.urlMap[urlKey(response.url)] ??= file.path;
    localization.fileUrls[file.path] = response.url.href;
    localization.downloaded.push({ path: file.path, url: task.url.href, kind: task.kind, recovered: task.recovered });
    if (task.kind === 'script' && !task.recovered) localization.vendorPaths.push(file.path);
    if (file.mime === 'text/css' && task.depth < limits.maxDepth)
      for (const ref of cssReferences(file.bytes.toString('utf8'))) enqueue(file.path, ref, task.depth + 1);
  };

  let done = 0;
  while (tasks.length) {
    const batch = tasks.splice(0, limits.concurrency);
    await Promise.all(batch.map(run));
    done += batch.length;
    await options.onProgress?.(done, done + tasks.length);
  }
  return { files, localization };
}
