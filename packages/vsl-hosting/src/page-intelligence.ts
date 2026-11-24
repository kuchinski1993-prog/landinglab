// Classificação usada pelo import inteligente (G3): players de vídeo de terceiros, rastreadores do site original
// e CDNs de bibliotecas estáticas. Só regras determinísticas (hostnames e assinaturas conhecidas) — nada é
// removido por "parecer" suspeito; o que não é reconhecido fica na página com aviso.
import { parse as parseJs } from 'acorn';

export interface VideoPlayerProvider { id: string; name: string; host: RegExp }

/** Players de VSL conhecidos. O primeiro player da página vira o marcador do vídeo do VSL Hosting. */
export const VIDEO_PLAYERS: VideoPlayerProvider[] = [
  { id: 'panda', name: 'Panda Video', host: /(?:^|\.)pandavideo\.com(?:\.br)?$/i },
  { id: 'vturb', name: 'VTurb (ConverteAI)', host: /(?:^|\.)(?:converteai\.net|vturb\.com(?:\.br)?|vturb\.net)$/i },
  { id: 'vimeo', name: 'Vimeo', host: /(?:^|\.)(?:player\.vimeo\.com|vimeo\.com|vimeocdn\.com)$/i },
  { id: 'youtube', name: 'YouTube', host: /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i },
  { id: 'wistia', name: 'Wistia', host: /(?:^|\.)(?:wistia\.com|wistia\.net)$/i },
  { id: 'vidalytics', name: 'Vidalytics', host: /(?:^|\.)vidalytics\.com$/i },
  { id: 'bunny', name: 'Bunny Stream', host: /(?:^|\.)mediadelivery\.net$/i },
];

export function hostOf(raw: string): string | null {
  try { return new URL(raw.startsWith('//') ? `https:${raw}` : raw).hostname.toLowerCase(); } catch { return null; }
}

export function playerByHost(raw: string): VideoPlayerProvider | null {
  const host = hostOf(raw);
  if (!host || !/^(?:https?:)?\/\//i.test(raw)) return null;
  return VIDEO_PLAYERS.find((player) => player.host.test(host)) ?? null;
}

/** Elemento de player sem iframe (embeds por script): tag/id/classe característicos. */
export function playerByElement(tagName: string, attrs: Record<string, string>): VideoPlayerProvider | null {
  const id = attrs['id'] ?? '';
  const cls = attrs['class'] ?? '';
  const pick = (key: string) => VIDEO_PLAYERS.find((player) => player.id === key)!;
  if (tagName === 'vturb-smartplayer' || /^vid[_-][0-9a-f]{12,}$/i.test(id)) return pick('vturb');
  if (tagName === 'wistia-player' || /(?:^|\s)wistia_embed(?:\s|$)/.test(cls)) return pick('wistia');
  if (/^vidalytics_embed/i.test(id)) return pick('vidalytics');
  return null;
}

/** Script inline de inicialização de um player (carregador/snippet curto que cita o host ou a API do player). */
export function inlinePlayerScript(text: string): VideoPlayerProvider | null {
  if (text.length > 6000) return null;
  const pick = (key: string) => VIDEO_PLAYERS.find((player) => player.id === key)!;
  if (/converteai\.net|vturb|smartplayer|\b_plt\b/i.test(text)) return pick('vturb');
  if (/pandavideo\.com/i.test(text)) return pick('panda');
  if (/fast\.wistia\.(?:com|net)|_wq\s*=|_wq\.push/i.test(text)) return pick('wistia');
  if (/vidalytics/i.test(text)) return pick('vidalytics');
  if (/mediadelivery\.net/i.test(text)) return pick('bunny');
  if (/player\.vimeo\.com\/api/i.test(text)) return pick('vimeo');
  if (/youtube\.com\/iframe_api|onYouTubeIframeAPIReady/i.test(text)) return pick('youtube');
  return null;
}

/* ───────────────────────────── Rastreadores ───────────────────────────── */

const TRACKER_HOSTS = /(?:^|\.)(?:connect\.facebook\.net|googletagmanager\.com|google-analytics\.com|analytics\.google\.com|googleadservices\.com|doubleclick\.net|analytics\.tiktok\.com|clarity\.ms|hotjar\.com|utmify\.com\.br|utmify\.com|snap\.licdn\.com|bat\.bing\.com|s\.pinimg\.com|sc-static\.net|static\.ads-twitter\.com|mc\.yandex\.ru|cdn\.segment\.com|cdn\.mxpnl\.com|plausible\.io|static\.cloudflareinsights\.com)$/i;
/** Pixel de imagem (noscript/img 1x1) dos rastreadores. */
const TRACKER_PIXEL_URL = /(?:facebook\.com\/tr\b|googletagmanager\.com\/ns\.html|analytics\.tiktok\.com|bat\.bing\.com\/action|px\.ads\.linkedin\.com|ct\.pinterest\.com)/i;

export const TRACKER_NAMES: Array<[RegExp, string]> = [
  [/fbq|fbevents|facebook|_fbp|meta-track/i, 'Meta Pixel'],
  [/gtag|googletagmanager|gtm\.|google-analytics|dataLayer/i, 'Google Analytics / Tag Manager'],
  [/ttq|tiktok/i, 'TikTok Pixel'],
  [/clarity/i, 'Microsoft Clarity'],
  [/hotjar|_hj/i, 'Hotjar'],
  [/utmify/i, 'UTMify'],
  [/cloudflareinsights/i, 'Cloudflare Web Analytics'],
];

export function trackerName(evidence: string): string {
  return TRACKER_NAMES.find(([pattern]) => pattern.test(evidence))?.[1] ?? 'Rastreador';
}

export function isTrackerHost(raw: string): boolean {
  const host = hostOf(raw);
  return Boolean(host && /^(?:https?:)?\/\//i.test(raw) && TRACKER_HOSTS.test(host));
}

export function isTrackerPixelUrl(raw: string): boolean {
  return TRACKER_PIXEL_URL.test(raw);
}

const TRACKER_SIGNATURES = [
  /\bfbq\s*\(\s*['"](?:init|track|trackCustom|consent|set)['"]/,
  /\bwindow\.fbq\b/,
  /fbevents\.js/,
  /meta-track-event/,
  /\bgtag\s*\(\s*['"](?:config|js|event|consent|set)['"]/,
  /['"]gtm\.start['"]/,
  /googletagmanager\.com\/(?:gtag\/js|gtm\.js)/,
  /\bttq\.(?:load|page|track|identify)\s*\(/,
  /analytics\.tiktok\.com/,
  /clarity\.ms\/tag|\bclarity\s*\(\s*['"]/,
  /static\.hotjar\.com|_hjSettings/,
  /utmify/i,
];
const OBFUSCATED_LOADER = (text: string) =>
  text.length <= 6000 && /\batob\s*\(/.test(text) && /createElement\(\s*['"]script['"]\s*\)/.test(text) && /\.src\s*=/.test(text);
/** Mudanças visíveis no DOM: um script que faz isso não é "só rastreador". */
const VISIBLE_DOM = /\.(?:innerHTML|outerHTML|textContent|innerText)\s*=|insertAdjacent(?:HTML|Element|Text)|classList\.|\.style\.[a-zA-Z]+\s*=|\.style\.(?:setProperty|cssText)|addEventListener\(\s*['"](?:click|submit|change|input|scroll|DOMContentLoaded|load)['"]|document\.write|\.(?:replaceWith|replaceChildren)\(/;
const TRACKER_GLOBAL = /^(?:_?fbq|gtag|dataLayer|ttq|pixelIds?|_hj\w*|clarity|utm\w*|_linkedin\w*|uetq|snaptr|pintrk|twq)$/i;

export type TrackerVerdict = { kind: 'tracker'; name: string } | { kind: 'mixed' } | null;

/**
 * Script inline do site original:
 * - `tracker`: só rastreamento (assinatura conhecida ou carregador ofuscado de script externo), sem globais da página
 *   e sem mudanças visíveis no DOM → pode ser removido com segurança.
 * - `mixed`: cita rastreador mas também tem código da página → fica, com aviso (o runtime remove os pixels ao servir).
 * - `null`: não é rastreador.
 */
export function classifyInlineTracker(text: string): TrackerVerdict {
  const signature = TRACKER_SIGNATURES.some((pattern) => pattern.test(text));
  const loader = OBFUSCATED_LOADER(text);
  if (!signature && !loader) return null;
  if (text.length > 30_000 || VISIBLE_DOM.test(text)) return { kind: 'mixed' };
  let program: { body: Array<Record<string, unknown>> };
  try { program = parseJs(text, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as typeof program; }
  catch {
    try { program = parseJs(text, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as typeof program; }
    catch { return { kind: 'mixed' }; }
  }
  for (const statement of program.body) {
    const names: string[] = [];
    if (statement.type === 'VariableDeclaration')
      for (const declaration of statement.declarations as Array<{ id: { type: string; name?: string } }>)
        names.push(declaration.id.type === 'Identifier' ? declaration.id.name! : '<pattern>');
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      names.push((statement.id as { name?: string } | null)?.name ?? '<anon>');
    if (statement.type === 'ImportDeclaration' || String(statement.type).startsWith('Export')) return { kind: 'mixed' };
    if (names.some((name) => !TRACKER_GLOBAL.test(name))) return { kind: 'mixed' };
  }
  return { kind: 'tracker', name: loader && !signature ? 'Carregador ofuscado de rastreador' : trackerName(text) };
}

/* ───────────────────────────── CDNs de bibliotecas ───────────────────────────── */

const STATIC_CDN = /(?:^|\.)(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|ajax\.googleapis\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|cdn\.tailwindcss\.com)$/i;

/** Script de CDN pública de bibliotecas (conteúdo estático e versionado): pode ser trazido para o servidor. */
export function isStaticCdnScript(raw: string): boolean {
  const host = hostOf(raw);
  return Boolean(host && STATIC_CDN.test(host));
}

/** Snap de proporção para as opções do player do VSL. */
export function snapAspectRatio(width: number, height: number): '16:9' | '9:16' | '4:5' | '1:1' | '4:3' | null {
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  const options: Array<['16:9' | '9:16' | '4:5' | '1:1' | '4:3', number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['4:5', 4 / 5], ['1:1', 1], ['4:3', 4 / 3]];
  return options.reduce((best, item) => (Math.abs(Math.log(item[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? item : best))[0];
}
