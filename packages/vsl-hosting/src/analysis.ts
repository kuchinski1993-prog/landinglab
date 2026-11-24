import path from 'node:path';

import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { selectAll } from 'css-select';
// @ts-expect-error -- parse-srcset 1.x publishes no types; the boundary below is explicitly typed.
import parseSrcsetUntyped from 'parse-srcset';
import { parse as parseJs } from 'acorn';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import { digest, safePath, type Manifest } from './storage.js';
import { ArchiveError, type SourceFile, type SourceFiles } from './archive.js';
import { validateExternalHttps } from './funnel-config.js';
import { ReferenceResolver, urlKey, type Localization, type OriginSource } from './localize.js';
import {
  classifyInlineTracker, inlinePlayerScript, isTrackerHost, isTrackerPixelUrl, playerByElement, playerByHost, snapAspectRatio,
  trackerName, type VideoPlayerProvider,
} from './page-intelligence.js';
const parseSrcset = parseSrcsetUntyped as (
  value: string
) => Array<{ url: string; w?: number; h?: number; d?: number }>;
export interface Finding {
  id: string;
  file: string;
  location: string;
  category: string;
  severity: 'info' | 'warning' | 'blocking';
  action: string;
  reason: string;
  evidence: string;
  beforeHash: string;
  afterHash?: string;
  trackerClassification?: string;
  change?: { start: number; end: number; before: string; after: string };
}
export interface ImportConfig {
  entryPath?: string;
  videoSelector?: string;
  ctaSelectors?: string[];
  offerSelectors?: string[];
  resolutions?: Record<string, string>;
  /** Legacy imports require all targets; independent VSL pages may select requirements per step. */
  requiredTargets?: Array<'video' | 'offer' | 'checkout'>;
  allowForms?: boolean;
  /** Internal immutable URL namespace for independent page revisions. */
  assetBasePath?: string;
  /** Explicitly authorized HTTPS resource origins for the public CSP. */
  externalOrigins?: string[];
  /**
   * Interno (G3, nunca vem da API): o runtime público remove os pixels originais ao servir
   * (`tracking.keepOriginalTrackers=false`), então pixel inline misturado vira aviso, não bloqueio.
   */
  runtimeTrackerRemoval?: boolean;
  /** URL original da página (opcional, vem da API): base para buscar arquivos que não vieram no ZIP. */
  sourceUrl?: string;
  /**
   * Interno (G3, nunca vem da API): política do import inteligente. Nenhum achado bloqueia — só entrada
   * inválida lança erro; o resto recebe a ação padrão segura (localizar, substituir player, remover
   * rastreador, autorizar origem) e vira aviso legível.
   */
  smartImport?: boolean;
  /** Interno (G3): resultado da etapa de localização (não é gravado no relatório). */
  localization?: Localization;
  /** Origens autorizadas em `frame-src` (iframes de terceiros mantidos). Gravado no relatório pelo import inteligente. */
  frameOrigins?: string[];
}
/** Resumo amigável do import inteligente (o que foi trazido, substituído, removido ou ficou faltando). */
export interface ImportSummary {
  localized: { images: number; fonts: number; styles: number; scripts: number; other: number };
  /** Arquivos que não vieram no ZIP e foram recuperados (do site original ou do mapa da ferramenta que salvou a página). */
  recovered: Array<{ path: string; from: 'site' | 'saved-page' }>;
  /** Arquivos que não vieram no ZIP e não puderam ser recuperados (sem URL de origem). */
  missing: Array<{ path: string; file: string }>;
  player: { provider: string; providerId: string; aspectRatio: string | null } | null;
  /** Nome de cada rastreador removido (um item por script/elemento). */
  trackersRemoved: string[];
  /** Origens mantidas externas e autorizadas na política de segurança da página. */
  externalOrigins: string[];
  frameOrigins: string[];
  /** Recursos externos que não puderam ser baixados (ficaram carregando do site de origem). */
  keptExternal: number;
  pageUrl: string | null;
  originFrom: OriginSource | null;
}
export interface Analysis {
  files: SourceFile[];
  manifest: Manifest;
  report: {
    version: 1;
    entryPath: string;
    findings: Finding[];
    pending: string[];
    versions: typeof VERSIONS;
    config: ImportConfig;
    summary?: ImportSummary;
  };
}
export const VERSIONS = { transformer: 'vsl-1', manifest: 'vsl-1', policies: 'vsl-1' };
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const trackerHosts = new Set(['www.google-analytics.com', 'connect.facebook.net']);
type HtmlNode = {
  nodeName: string;
  parentNode?: HtmlNode | null;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  value?: string;
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    attrs?: Record<string, { startOffset: number; endOffset: number }>;
  };
};
interface PlayerReplacement { node: HtmlNode; provider: VideoPlayerProvider; aspectRatio: string | null; evidence: string; style: string }

const paddingRatio = (node: HtmlNode): string | null => {
  const style = node.attrs?.find((attr) => attr.name === 'style')?.value ?? '';
  const match = /padding(?:-top|-bottom)?\s*:\s*(?:0\s+0\s+)?([\d.]+)%/i.exec(style);
  return match ? snapAspectRatio(100, Number(match[1])) : null;
};

/**
 * Primeiro player de vídeo de terceiros da página (ordem do documento), se a página ainda não tem o marcador
 * `data-blackshop-video`. Sobe pelos invólucros responsivos (div com padding em % e só o player dentro) para que
 * o marcador ocupe o lugar do bloco inteiro; a proporção vem do padding ou de width/height do iframe.
 */
function findPlayerToReplace(tree: HtmlNode, text: string): PlayerReplacement | null {
  if (/\sdata-blackshop-video\b/i.test(text)) return null;
  let found: { node: HtmlNode; provider: VideoPlayerProvider; evidence: string } | null = null;
  const scan = (node: HtmlNode): void => {
    if (found) return;
    const tag = node.tagName ?? '';
    const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
    const src = attrs['src'] ?? '';
    const provider = (['iframe', 'embed'].includes(tag) && src ? playerByHost(src.trim()) : null) ?? (tag ? playerByElement(tag, attrs) : null);
    if (provider && node.sourceCodeLocation) {
      found = { node, provider, evidence: src ? src.split('?')[0]! : tag };
      return;
    }
    node.childNodes?.forEach(scan);
    if (node.content) scan(node.content);
  };
  scan(tree);
  if (!found) return null;
  const hit = found as { node: HtmlNode; provider: VideoPlayerProvider; evidence: string };
  let target = hit.node;
  const attrs = Object.fromEntries((target.attrs ?? []).map((attr) => [attr.name, attr.value]));
  let aspectRatio = paddingRatio(target) ?? snapAspectRatio(Number(attrs['width']), Number(attrs['height']));
  for (let level = 0; level < 3; level++) {
    const parent = target.parentNode;
    if (!parent?.tagName || ['body', 'html', 'head'].includes(parent.tagName) || !parent.sourceCodeLocation) break;
    const elements = (parent.childNodes ?? []).filter((child) => child.tagName);
    const ratio = paddingRatio(parent);
    if (elements.length !== 1 || !ratio) break;
    target = parent;
    aspectRatio = ratio;
  }
  // Embeds por script (VTurb/Wistia) guardam a proporção num placeholder interno.
  const inner = (node: HtmlNode, depth: number): string | null => {
    if (depth > 3) return null;
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      const found = paddingRatio(child) ?? inner(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  aspectRatio ??= inner(hit.node, 1);
  // Tamanho do bloco original (largura máxima e centralização) passa para o marcador.
  const original = attrs['style'] ?? '';
  const keep = ['max-width', 'margin']
    .map((property) => new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(original)?.[1]?.trim())
    .map((value, index) => (value && /^[\w\s.%()+-]+$/.test(value) ? `${['max-width', 'margin'][index]}:${value}` : ''))
    .filter(Boolean);
  return { node: target, provider: hit.provider, aspectRatio, evidence: hit.evidence, style: ['width:100%', ...keep].join(';') };
}

export function analyze(
  files: SourceFiles,
  entryPath: string,
  config: ImportConfig = {}
): Analysis {
  if (!files.some((f) => f.path === entryPath && f.mime === 'text/html'))
    throw new ArchiveError('A página principal escolhida não existe no ZIP ou não é um arquivo .html.');
  const names = new Set(files.map((f) => f.path));
  const findings: Finding[] = [],
    output: SourceFile[] = [];
  const smart = config.smartImport === true;
  const localization = smart ? config.localization : undefined;
  const resolver = localization ? new ReferenceResolver(entryPath, localization.pageUrl, localization.fileUrls) : null;
  const downloadedPaths = new Set((localization?.downloaded ?? []).map((item) => item.path));
  const vendorPaths = new Set(localization?.vendorPaths ?? []);
  const localizedTargets = new Set<string>();
  const recovered = new Map<string, 'site' | 'saved-page'>();
  const missing = new Map<string, string>();
  const autoOrigins = new Set<string>();
  const frameOrigins = new Set<string>(config.frameOrigins ?? []);
  const trackersRemoved: string[] = [];
  const keptExternal = new Set<string>();
  let player: ImportSummary['player'] = null;
  const assetUrl = (file: SourceFile, target: string) =>
    config.assetBasePath
      ? `${config.assetBasePath}${target.split('/').map(encodeURIComponent).join('/')}`
      : path.posix.relative(path.posix.dirname(file.path), target).split('/').map(encodeURIComponent).join('/');
  /** Autoriza a origem na CSP da página (só https válidas; nunca rastreador/player). */
  const authorize = (url: URL | null, into: Set<string>) => {
    if (!url || isTrackerHost(url.href) || playerByHost(url.href)) return;
    try { const valid = validateExternalHttps(url.origin); if (!valid.port) into.add(valid.origin); } catch { /* http/IP: não autorizável */ }
  };
  function finding(
    file: SourceFile,
    location: string,
    category: string,
    severity: Finding['severity'],
    action: string,
    reason: string,
    evidence: string
  ): void {
    const id = digest(`${file.path}:${location}:${category}:${evidence}`).slice(0, 24);
    // Import inteligente: nada exige decisão; o item fica com a ação padrão segura e vira aviso.
    if (smart && severity === 'blocking') {
      severity = 'warning';
      if (action === 'requires-resolution') action = 'preserved';
    }
    const resolution = smart ? undefined : config.resolutions?.[id];
    if (resolution && resolution.trim().length < 8)
      throw new ArchiveError('A justificativa para manter um item precisa ter pelo menos 8 caracteres.');
    findings.push({
      id,
      file: file.path,
      location,
      category,
      severity: resolution && severity === 'blocking' ? 'warning' : severity,
      action: resolution ? 'operator-reclassified' : action,
      reason: resolution ?? reason,
      evidence,
      beforeHash: digest(file.bytes),
      trackerClassification:
        category === 'tracker-removable'
          ? 'REMOVÍVEL COM SEGURANÇA'
          : category === 'tracker-mixed'
            ? 'MISTO / NÃO SEPARÁVEL'
            : category === 'unknown-script'
              ? 'DESCONHECIDO'
              : undefined,
    });
  }
  /** `imageOnly`: referência de imagem (img-src já aceita https) — não precisa autorizar a origem na CSP. */
  function reference(file: SourceFile, url: string, location: string, essential = true, imageOnly = false): string {
    if (!url || url.startsWith('#') || /^(?:data:|mailto:|tel:|blob:)/i.test(url)) return url;
    if (smart && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      if (!essential || /^javascript:/i.test(url)) return url;
      const absolute = resolver?.absolute(file.path, url) ?? (() => { try { return new URL(url.startsWith('//') ? `https:${url}` : url); } catch { return null; } })();
      const target = absolute && localization ? localization.urlMap[urlKey(absolute)] : undefined;
      if (target && names.has(target)) {
        localizedTargets.add(target);
        return assetUrl(file, target);
      }
      keptExternal.add(absolute?.href ?? url);
      if (!imageOnly) authorize(absolute, autoOrigins);
      finding(file, location, 'external-kept', 'warning', 'kept-external',
        'External resource could not be downloaded; kept external and its origin authorized in the page CSP', url);
      return url;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      const allowed = (() => { try { return config.externalOrigins?.includes(new URL(url.startsWith('//') ? `https:${url}` : url).origin) ?? false; } catch { return false; } })();
      finding(
        file,
        location,
        'external-reference',
        essential && !allowed ? 'blocking' : 'warning',
        'preserved',
        'External resources are not downloaded',
        url
      );
      return url;
    }
    const clean = url.split(/[?#]/)[0]!;
    if (!essential && (clean.endsWith('/') || ['.', '..'].includes(clean))) {
      finding(
        file,
        location,
        'navigation-reference',
        'warning',
        'preserved',
        'Directory navigation cannot be resolved automatically inside a revision',
        url
      );
      return url;
    }
    let normalized: string;
    try {
      let decoded = clean;
      for (let n = 0; n < 4; n++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (decoded.includes('\\') || decoded.includes('\0') || /^[a-z]:/i.test(decoded))
        throw new Error('Invalid path');
      const base = clean.startsWith('/') ? '' : path.posix.dirname(file.path);
      normalized = safePath(
        path.posix.normalize(path.posix.join(base, decoded.replace(/^\//, '')))
      );
    } catch {
      if (smart) {
        finding(file, location, 'invalid-reference', 'warning', 'preserved', 'Reference to an invalid path kept as is', url);
        return url;
      }
      throw new ArchiveError(`O arquivo ${file.path} referencia um caminho inválido (ex.: "../" para fora do ZIP).`);
    }
    if (smart && !names.has(normalized)) {
      if (!essential) {
        finding(file, location, 'navigation-link', 'info', 'preserved', 'Navigation link to a page outside the import; the VSL CTA handles navigation', url);
        return url;
      }
      const absolute = resolver?.absolute(file.path, url) ?? null;
      const target = absolute && localization ? localization.urlMap[urlKey(absolute)] : undefined;
      if (target && names.has(target)) {
        localizedTargets.add(target);
        if (!downloadedPaths.has(normalized) && !downloadedPaths.has(file.path) && !recovered.has(normalized))
          recovered.set(normalized, downloadedPaths.has(target) ? 'site' : 'saved-page');
        finding(file, location, 'missing-recovered', 'info', 'localized',
          downloadedPaths.has(target) ? 'Missing file downloaded from the original site' : 'Missing file found in the saved page map', url);
        return assetUrl(file, target);
      }
      if (absolute && (localization?.fileUrls[file.path] || localization?.pageUrl)) {
        // Origem conhecida, mas o download falhou: carrega direto do site original (origem autorizada na CSP).
        keptExternal.add(absolute.href);
        if (!imageOnly) authorize(absolute, autoOrigins);
        finding(file, location, 'external-kept', 'warning', 'kept-external',
          'Missing file could not be downloaded; it is loaded from the original site', absolute.href);
        return absolute.href;
      }
      missing.set(normalized, file.path);
      finding(file, location, 'missing-dependency', 'warning', 'preserved', 'File not included in the ZIP and no source URL to fetch it', url);
    } else if (!names.has(normalized))
      finding(
        file,
        location,
        'missing-dependency',
        essential ? 'blocking' : 'warning',
        'requires-resolution',
        'Missing local dependency',
        url
      );
    if (config.assetBasePath && essential)
      return `${config.assetBasePath}${normalized.split('/').map(encodeURIComponent).join('/')}${url.slice(clean.length)}`;
    // Root references become relative to their containing file, retaining the grant prefix.
    return clean.startsWith('/')
      ? `${path.posix.relative(path.posix.dirname(file.path), normalized).split('/').map(encodeURIComponent).join('/')}${url.slice(clean.length)}`
      : url;
  }
  function css(file: SourceFile, text: string, location = 'css'): string {
    const tree = postcss.parse(text, { from: file.path });
    tree.walkDecls((decl) => {
      const parsed = valueParser(decl.value);
      const fontFace = decl.parent?.type === 'atrule' && (decl.parent as postcss.AtRule).name.toLowerCase() === 'font-face';
      parsed.walk((node) => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          const target = node.nodes[0];
          if (target && (target.type === 'word' || target.type === 'string'))
            target.value = reference(file, target.value, `${location}:${decl.source?.start?.line}`, true, !fontFace);
        }
      });
      decl.value = parsed.toString();
    });
    tree.walkAtRules('import', (rule) => {
      const parsed = valueParser(rule.params);
      const first = parsed.nodes[0];
      if (first?.type === 'string')
        first.value = reference(file, first.value, `${location}:import`);
      else if (first?.type === 'function' && first.value === 'url') {
        const child = first.nodes[0];
        if (child && (child.type === 'word' || child.type === 'string'))
          child.value = reference(file, child.value, `${location}:import`);
      }
      rule.params = parsed.toString();
    });
    return tree.toString();
  }
  function js(file: SourceFile, text: string, location = 'js'): string {
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    let tree: unknown;
    try {
      tree = parseJs(text, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch {
      try {
        tree = parseJs(text, { ecmaVersion: 'latest', sourceType: 'script' });
      } catch {
        finding(
          file,
          location,
          'unknown-script',
          'blocking',
          'requires-resolution',
          'Unparseable script preserved',
          digest(text)
        );
        return text;
      }
    }
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const data = node as Record<string, unknown>;
      if (
        ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
          String(data.type)
        ) &&
        data.source
      ) {
        const source = data.source as { value: string; start: number; end: number };
        if (source.value.startsWith('.') || source.value.startsWith('/')) {
          const next = reference(file, source.value, `${location}:${data.start}`);
          if (next !== source.value)
            replacements.push({
              start: source.start,
              end: source.end,
              text: JSON.stringify(next.startsWith('/') || next.startsWith('.') ? next : `./${next}`),
            });
        } else
          finding(
            file,
            location,
            'module-origin',
            'blocking',
            'requires-resolution',
            'Bare/absolute module requires explicit resolution',
            source.value
          );
      }
      if (
        data.type === 'CallExpression' &&
        (data.callee as Record<string, unknown>)?.name === 'fetch'
      ) {
        const target = (data.arguments as Array<{ value?: unknown }>)[0]?.value;
        if (typeof target === 'string' && /^(?:https?:|\/\/)/i.test(target))
          finding(
            file,
            `${location}:${data.start}`,
            'external-api',
            'blocking',
            'requires-resolution',
            'External fetch is preserved but conflicts with the VSL connect-src policy',
            target
          );
      }
      if (
        data.type === 'ImportExpression' ||
        (data.type === 'CallExpression' &&
          ['fetch', 'XMLHttpRequest', 'eval', 'Function'].includes(
            String((data.callee as Record<string, unknown>)?.name)
          ))
      )
        finding(
          file,
          `${location}:${data.start}`,
          'dynamic-script',
          'warning',
          'preserved',
          'Dynamic behavior preserved; not executed by worker',
          digest(text)
        );
      for (const child of Object.values(data))
        if (Array.isArray(child)) child.forEach(walk);
        else if (child && typeof child === 'object') walk(child);
    }
    walk(tree);
    if (/document\.cookie|document\.domain|new\s+(?:SharedWorker|Worker)|serviceWorker/.test(text))
      finding(
        file,
        location,
        'origin-dependent-script',
        'blocking',
        'requires-resolution',
        'Cookie/domain/worker behavior incompatible with isolated VSL policy',
        digest(text)
      );
    if (/\b(?:fbq|gtag|ga|_hmt|hj)\s*\(/.test(text))
      finding(
        file,
        location,
        'tracker-mixed',
        config.runtimeTrackerRemoval ? 'warning' : 'blocking',
        config.runtimeTrackerRemoval ? 'preserved' : 'requires-resolution',
        config.runtimeTrackerRemoval
          ? 'Mixed inline tracker preserved in the revision; the public runtime strips original trackers when serving'
          : 'Mixed/unknown inline tracker preserved; no destructive rewrite',
        digest(text)
      );
    if (/(?:\\x[0-9a-f]{2}){6}|eval\s*\(/i.test(text))
      finding(
        file,
        location,
        'unknown-script',
        'warning',
        'preserved',
        'Obfuscated script is not executed or removed',
        digest(text)
      );
    for (const replacement of replacements.sort((a, b) => b.start - a.start))
      text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
    return text;
  }
  for (const file of files) {
    let text = file.bytes.toString('utf8');
    if (file.mime === 'text/html') {
      const tree = parse(text, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
      const patches: Array<{ start: number; end: number; text: string }> = [];
      const markers = { video: 0, checkout: 0, offer: 0 };
      const replacement = smart && file.path === entryPath ? findPlayerToReplace(tree, text) : null;
      const walk = (node: HtmlNode): void => {
        const attrs = Object.fromEntries((node.attrs ?? []).map((a) => [a.name, a.value]));
        for (const [kind, attr] of Object.entries({
          video: 'data-blackshop-video',
          checkout: 'data-blackshop-checkout',
          offer: 'data-blackshop-offer',
        }))
          if (attr in attrs) markers[kind as keyof typeof markers]++;
        const at = node.sourceCodeLocation;
        const tag = node.tagName ?? '';
        const skipAttrs = new Set<string>();
        if (smart && at) {
          const remove = (category: string, reason: string, evidence: string, tracker?: string) => {
            patches.push({ start: at.startOffset, end: at.endOffset, text: '' });
            finding(file, `html:${at.startOffset}`, category, 'info', 'removed', reason, evidence);
            if (tracker) trackersRemoved.push(tracker);
          };
          if (replacement && node === replacement.node) {
            // Player da VSL original → marcador do vídeo do VSL Hosting, no mesmo lugar.
            const ratio = replacement.aspectRatio ? ` data-blackshop-aspect-ratio="${replacement.aspectRatio}"` : '';
            patches.push({ start: at.startOffset, end: at.endOffset, text: `<div data-blackshop-video${ratio} style="${replacement.style}"></div>` });
            markers.video++;
            player = { provider: replacement.provider.name, providerId: replacement.provider.id, aspectRatio: replacement.aspectRatio };
            finding(file, `html:${at.startOffset}`, 'video-player-replaced', 'info', 'replaced',
              `Third-party video player (${replacement.provider.name}) replaced by the VSL Hosting video`, replacement.evidence);
            return;
          }
          const isJs = !attrs['type'] || ['module', 'text/javascript', 'application/javascript', 'text/ecmascript'].includes(attrs['type'].toLowerCase());
          if (tag === 'script' && attrs['src'] && isTrackerHost(attrs['src'])) {
            remove('tracker-removable', 'Script from a known tracker removed', attrs['src'], trackerName(attrs['src']));
            return;
          }
          if (tag === 'script' && attrs['src'] && replacement && playerByHost(attrs['src'])?.id === replacement.provider.id) {
            remove('video-player-script-removed', 'Script of the replaced video player removed', attrs['src']);
            return;
          }
          if (tag === 'script' && !attrs['src'] && isJs) {
            const script = (node.childNodes ?? []).map((child) => child.value ?? '').join('');
            if (replacement && inlinePlayerScript(script)?.id === replacement.provider.id) {
              remove('video-player-script-removed', 'Initialization script of the replaced video player removed', replacement.provider.name);
              return;
            }
            const verdict = classifyInlineTracker(script);
            if (verdict?.kind === 'tracker') {
              remove('tracker-removable', 'Inline tracker script removed', verdict.name, verdict.name);
              return;
            }
          }
          if (tag === 'noscript' && isTrackerPixelUrl((node.childNodes ?? []).map((child) => child.value ?? '').join(''))) {
            remove('tracker-removable', 'Tracker pixel fallback (noscript) removed', 'noscript');
            return;
          }
          if (tag === 'img' && attrs['src'] && isTrackerPixelUrl(attrs['src'])) {
            remove('tracker-removable', 'Tracker image pixel removed', attrs['src']);
            return;
          }
          if (tag === 'link' && attrs['href'] && (isTrackerHost(attrs['href']) || (replacement && playerByHost(attrs['href'])?.id === replacement.provider.id))) {
            remove('resource-hint-removed', 'Link to a removed tracker/player removed', attrs['href']);
            return;
          }
          if (tag === 'base') {
            remove('base-removed', 'Base tag removed; the original address is used only to fetch missing files', attrs['href'] ?? '');
            return;
          }
          if (tag === 'link' && !/(?:^|\s)(?:stylesheet|icon|apple-touch-icon|preload|modulepreload|prefetch)(?:\s|$)/i.test(attrs['rel'] ?? ''))
            skipAttrs.add('href'); // canonical, alternate, preconnect, dns-prefetch: só metadados/dicas, ficam como estão.
          if (['iframe', 'object', 'embed'].includes(tag)) {
            const src = attrs['src'] ?? attrs['data'] ?? '';
            if (tag === 'iframe' && /^(?:https?:)?\/\//i.test(src.trim())) {
              skipAttrs.add('src');
              const provider = playerByHost(src);
              let url: URL | null = null;
              try { url = new URL(src.trim().startsWith('//') ? `https:${src.trim()}` : src.trim()); } catch { /* inválida */ }
              if (url) try { const valid = validateExternalHttps(url.origin); if (!valid.port) frameOrigins.add(valid.origin); } catch { /* http: não autorizável */ }
              finding(file, `html:${at.startOffset}`, provider ? 'video-player-kept' : 'iframe-authorized', 'warning', 'kept-external',
                provider ? `Additional ${provider.name} player kept; its origin is authorized in the page CSP` : 'Third-party iframe kept; its origin is authorized in the page CSP', src);
            } else if (tag !== 'iframe')
              finding(file, `html:${at.startOffset}`, 'csp-incompatible', 'warning', 'preserved', 'Embedded object is restricted by the VSL CSP', tag);
          }
        }
        if (!smart && (['iframe', 'object', 'embed'].includes(node.tagName ?? '') || (node.tagName === 'form' && !config.allowForms)))
          finding(
            file,
            `html:${node.sourceCodeLocation?.startOffset}`,
            'csp-incompatible',
            'blocking',
            'requires-resolution',
            'Embedded content/form behavior is restricted by VSL CSP',
            node.tagName!
          );
        if (!smart && node.tagName === 'base')
          finding(
            file,
            `html:${node.sourceCodeLocation?.startOffset}`,
            'base-origin',
            'blocking',
            'requires-resolution',
            'Base tag can escape grant namespace; explicit correction required',
            attrs['href'] ?? ''
          );
        if (node.tagName === 'script') {
          let exclusive = false;
          if (attrs['src'])
            try {
              exclusive =
                trackerHosts.has(new URL(attrs['src']).hostname) &&
                /^\/(?:analytics\.js|ga\.js|(?:[a-z_]+\/)?fbevents\.js)$/.test(
                  new URL(attrs['src']).pathname
                ) &&
                !Object.keys(attrs).some((a) => a.startsWith('on'));
            } catch {
              /* local source */
            }
          if (exclusive && node.sourceCodeLocation) {
            patches.push({
              start: node.sourceCodeLocation.startOffset,
              end: node.sourceCodeLocation.endOffset,
              text: '',
            });
            finding(
              file,
              `html:${node.sourceCodeLocation.startOffset}`,
              'tracker-removable',
              'info',
              'removed',
              'Standalone external tracker from explicit policy host',
              attrs['src']!
            );
            findings.at(-1)!.change = {
              start: node.sourceCodeLocation.startOffset,
              end: node.sourceCodeLocation.endOffset,
              before: text.slice(
                node.sourceCodeLocation.startOffset,
                node.sourceCodeLocation.endOffset
              ),
              after: '',
            };
            return;
          }
          if (
            !attrs['src'] &&
            (!attrs['type'] ||
              ['module', 'text/javascript', 'application/javascript'].includes(attrs['type']))
          ) {
            const script = (node.childNodes ?? []).map((child) => child.value ?? '').join('');
            const next = js(file, script, `inline:${node.sourceCodeLocation?.startOffset}`);
            const loc = node.childNodes?.[0]?.sourceCodeLocation;
            if (next !== script && loc)
              patches.push({ start: loc.startOffset, end: loc.endOffset, text: next });
          }
        }
        if (
          node.tagName === 'link' &&
          /(?:^|\s)manifest(?:\s|$)/i.test(attrs['rel'] ?? '') &&
          node.sourceCodeLocation
        ) {
          // Manifesto PWA não tem uso num funil e o nome colide com o manifesto interno da revisão.
          patches.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset, text: '' });
          finding(
            file,
            `html:${node.sourceCodeLocation.startOffset}`,
            'pwa-manifest-removed',
            'warning',
            'removed',
            'PWA manifest link removed (not used by VSL pages)',
            attrs['href'] ?? ''
          );
          return;
        }
        for (const attr of node.attrs ?? []) {
          let next = attr.value;
          if (skipAttrs.has(attr.name)) continue;
          if (['src', 'href', 'poster'].includes(attr.name))
            next = reference(
              file,
              next,
              `html:${node.sourceCodeLocation?.startOffset}:${attr.name}`,
              node.tagName !== 'a',
              ['img', 'source', 'video', 'input'].includes(tag) || attr.name === 'poster'
            );
          if (smart && localization && attr.name.startsWith('data-') && /^(?:https?:)?\/\//i.test(next.trim())) {
            // Imagens trocadas por script (data-src, data-img-*): usa a cópia local quando foi trazida.
            const absolute = resolver?.absolute(file.path, next) ?? null;
            const target = absolute ? localization.urlMap[urlKey(absolute)] : undefined;
            if (target && names.has(target)) {
              localizedTargets.add(target);
              next = assetUrl(file, target);
            }
          }
          if (attr.name === 'srcset') {
            const candidates = parseSrcset(next);
            const rewritten = candidates.map((candidate) => ({
              ...candidate,
              url: reference(file, candidate.url, `srcset:${node.sourceCodeLocation?.startOffset}`, true, true),
            }));
            if (rewritten.some((candidate, index) => candidate.url !== candidates[index]!.url))
              next = rewritten
                .map(
                  (candidate) =>
                    `${candidate.url}${candidate.w ? ` ${candidate.w}w` : candidate.d ? ` ${candidate.d}x` : ''}${candidate.h ? ` ${candidate.h}h` : ''}`
                )
                .join(', ');
          }
          if (attr.name === 'style') next = css(file, `vsl{${next}}`, 'inline-css').slice(4, -1);
          const loc = node.sourceCodeLocation?.attrs?.[attr.name];
          if (next !== attr.value && loc)
            patches.push({
              start: loc.startOffset,
              end: loc.endOffset,
              text: `${attr.name}="${next.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`,
            });
        }
        if (node.tagName === 'style') {
          for (const child of node.childNodes ?? [])
            if (child.value && child.sourceCodeLocation) {
              const loc = child.sourceCodeLocation;
              patches.push({
                start: loc.startOffset,
                end: loc.endOffset,
                text: css(file, child.value, 'style'),
              });
            }
        }
        node.childNodes?.forEach(walk);
        if (node.content) walk(node.content);
      };
      walk(tree);
      if (file.path === entryPath) {
        const selectorTree = parse(text, { treeAdapter: adapter });
        for (const [kind, selectors] of Object.entries({
          video: config.videoSelector ? [config.videoSelector] : [],
          checkout: config.ctaSelectors ?? [],
          offer: config.offerSelectors ?? [],
        })) {
          for (const selector of selectors) {
            let count = 0;
            try {
              count = selectAll(selector, selectorTree.children).length;
            } catch {
              /* invalid selector => explicit diagnostic */
            }
            if (count === 0 || (kind === 'video' && count !== 1))
              finding(
                file,
                `selector:${kind}:${selector}`,
                'selector-invalid',
                'blocking',
                'requires-resolution',
                'Selector absent, invalid or ambiguous; no inferred replacement',
                `${selector}: ${count}`
              );
          }
        }

        if ((config.requiredTargets ?? ['video', 'offer', 'checkout']).includes('video') && markers.video !== 1 && !config.videoSelector)
          finding(
            file,
            'selectors:video',
            'selector-missing',
            'blocking',
            'requires-resolution',
            'Exactly one player marker or explicit selector required',
            String(markers.video)
          );
        if ((config.requiredTargets ?? ['video', 'offer', 'checkout']).includes('offer') && markers.offer === 0 && !config.offerSelectors?.length)
          finding(
            file,
            'selectors:offer',
            'selector-missing',
            'blocking',
            'requires-resolution',
            'Offer marker or configured selectors required',
            '0'
          );
        if ((config.requiredTargets ?? ['video', 'offer', 'checkout']).includes('checkout') && markers.checkout === 0 && !config.ctaSelectors?.length)
          finding(
            file,
            'selectors:checkout',
            'selector-missing',
            'blocking',
            'requires-resolution',
            'CTA marker or configured selectors required',
            '0'
          );
      }
      for (const patch of patches.sort((a, b) => b.start - a.start))
        text = text.slice(0, patch.start) + patch.text + text.slice(patch.end);
    } else if (file.mime === 'text/css') text = css(file, text);
    else if (file.mime === 'application/javascript' && !vendorPaths.has(file.path)) text = js(file, text);
    const bytes = ['text/html', 'text/css', 'application/javascript'].includes(file.mime)
      ? Buffer.from(text)
      : file.bytes;
    for (const item of findings.filter((f) => f.file === file.path)) item.afterHash = digest(bytes);
    output.push({ ...file, bytes });
  }
  for (const metadata of files.discarded ?? [])
    findings.push({
      id: digest(metadata.path).slice(0, 24),
      file: metadata.path,
      location: 'zip-entry',
      category: metadata.reason === 'os-metadata' && !/(?:^|\/)(?:__MACOSX\/|\.DS_Store$)/.test(metadata.path) ? 'metadata' : `discarded-${metadata.reason ?? 'os-metadata'}`,
      // Import inteligente: arquivo que a página não usa só é ignorado (informação, não aviso).
      severity: smart || (metadata.reason === 'os-metadata' && !/(?:^|\/)(?:__MACOSX\/|\.DS_Store$)/.test(metadata.path)) ? 'info' : 'warning',
      action: 'discarded',
      reason: metadata.detail ?? `File left out of the revision (${metadata.reason ?? 'os-metadata'})`,
      evidence: metadata.path,
      beforeHash: metadata.sha256,
    });
  const manifest: Manifest = {
    version: 1,
    entryPath,
    files: Object.fromEntries(
      output.map((f) => [
        f.path,
        { storageKey: f.path, mimeType: f.mime, bytes: f.bytes.length, sha256: digest(f.bytes) },
      ])
    ),
  };
  const { localization: _internal, ...reportConfig } = config;
  let summary: ImportSummary | undefined;
  if (smart) {
    const external = [...new Set([...(config.externalOrigins ?? []), ...autoOrigins])].slice(0, 40);
    const frames = [...frameOrigins].slice(0, 40);
    if (external.length) reportConfig.externalOrigins = external;
    if (frames.length) reportConfig.frameOrigins = frames;
    const localized = { images: 0, fonts: 0, styles: 0, scripts: 0, other: 0 };
    const mimes = new Map(output.map((file) => [file.path, file.mime]));
    for (const target of new Set([...localizedTargets, ...downloadedPaths])) {
      const mime = mimes.get(target) ?? '';
      if (mime.startsWith('image/')) localized.images++;
      else if (mime.startsWith('font/')) localized.fonts++;
      else if (mime === 'text/css') localized.styles++;
      else if (mime === 'application/javascript') localized.scripts++;
      else localized.other++;
    }
    summary = {
      localized,
      recovered: [
        ...[...recovered].map(([recoveredPath, from]) => ({ path: recoveredPath, from })),
        ...(localization?.downloaded ?? []).filter((item) => item.recovered && !recovered.has(item.path)).map((item) => ({ path: item.path, from: 'site' as const })),
      ],
      missing: [...missing].map(([missingPath, from]) => ({ path: missingPath, file: from })),
      player,
      trackersRemoved,
      externalOrigins: [...autoOrigins],
      frameOrigins: frames,
      keptExternal: keptExternal.size,
      pageUrl: localization?.pageUrl ?? null,
      originFrom: localization?.originFrom ?? null,
    };
  }
  return {
    files: output,
    manifest,
    report: {
      version: 1,
      entryPath,
      findings,
      pending: findings.filter((f) => f.severity === 'blocking').map((f) => f.id),
      versions: VERSIONS,
      config: reportConfig,
      ...(summary ? { summary } : {}),
    },
  };
}
