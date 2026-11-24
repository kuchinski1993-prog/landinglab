import { isIP } from 'node:net';

import { selectAll } from 'css-select';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

/**
 * Query parameters forwarded to the next step/checkout when no `allowedParams` policy is set (src/sck: Hotmart/Kiwify).
 * `ref` (Story 16.3): só repassado se o visitante já o trouxe na URL da página; nunca gerado.
 */
export const DEFAULT_PASSTHROUGH = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'fbclid', 'gclid', 'ttclid', 'src', 'sck', 'ref'] as const;
/** Story 16.3: parâmetros do link do produtor que o repasse nunca sobrescreve (`?ref=` do afiliado, `?fn=` do funil Sphere). */
export const PROTECTED_DESTINATION_PARAMS = ['ref', 'fn'] as const;
const isProtectedParam = (key: string): boolean => (PROTECTED_DESTINATION_PARAMS as readonly string[]).includes(key);
export type VslAction = { type: 'NEXT_STEP' } | { type: 'CHECKOUT' } | { type: 'EXTERNAL_URL'; url: string };
export interface VslCheckoutConfig { url: string; allowedParams?: string[]; customParams?: Record<string, string> }
/**
 * `waitSelectors` (opcional, 0..10): aviso da página ("Seguí mirando el video…") que o runtime esconde
 * (`display:none !important` inline, mantido por MutationObserver) quando ESTE CTA é liberado.
 */
/**
 * `label`/`managed`/`inheritsDefault` vêm do painel "Botões de compra" (VSL-14): regras geradas por ele são `managed`;
 * `inheritsDefault` indica que o tempo veio de `defaultUnlockAfterSeconds`. O runtime ignora esses campos.
 * `unlockAfterSeconds` é tempo do vídeo: com `player.playbackRate` > 1 o runtime converte para tempo de relógio.
 */
export interface VslCtaRule {
  id: string; selectors: string[]; unlockAfterSeconds: number; action: VslAction; waitSelectors?: string[];
  label?: string; managed?: boolean; inheritsDefault?: boolean;
}
export interface VslCtaConfig { ttlSeconds?: number; defaultUnlockAfterSeconds?: number; ctas: VslCtaRule[] }
/** `keepOriginalTrackers`: by default the runtime strips the imported page's own pixels (fbq/gtag/gtm/ttq); `true` keeps them. */
export interface VslTrackingConfig { enabled?: boolean; metaPixelId?: string; googleAdsId?: string; googleAdsLabel?: string; tiktokPixelId?: string; keepOriginalTrackers?: boolean }

const param = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;
const pixel = /^[A-Za-z0-9._-]{2,120}$/;
const selector = /^[^{};<>]{1,200}$/;
const validSelectorList = (value: unknown, min: number, max: number): boolean => Array.isArray(value) && value.length >= min && value.length <= max &&
  value.every((item) => typeof item === 'string' && selector.test(item) && ![...item].some((char) => char.charCodeAt(0) < 32));

export function validateExternalHttps(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    !url.hostname.includes('.') || isIP(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test)$/i.test(url.hostname))
    throw new Error('Invalid HTTPS URL');
  return url;
}

export function validateCheckoutConfig(input: unknown, required = false): VslCheckoutConfig | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    if (required) throw new Error('Checkout URL required');
    return null;
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['url', 'allowedParams', 'customParams'].includes(key)) || typeof value.url !== 'string')
    throw new Error('Invalid checkout configuration');
  validateExternalHttps(value.url);
  if (value.allowedParams !== undefined && (!Array.isArray(value.allowedParams) || value.allowedParams.length > 30 ||
    value.allowedParams.some((key) => typeof key !== 'string' || !param.test(key)))) throw new Error('Invalid checkout parameter policy');
  if (value.customParams !== undefined && (!value.customParams || typeof value.customParams !== 'object' || Array.isArray(value.customParams) ||
    Object.entries(value.customParams).length > 30 || Object.entries(value.customParams).some(([key, text]) => !param.test(key) || typeof text !== 'string' || text.length > 500)))
    throw new Error('Invalid checkout custom parameters');
  return value as unknown as VslCheckoutConfig;
}

export function buildCheckoutUrl(config: VslCheckoutConfig, query: URLSearchParams): string {
  validateCheckoutConfig(config, true);
  const url = validateExternalHttps(config.url);
  // Fixos (URL e customParams) primeiro; o valor que veio do anúncio vence (atribuição na Hotmart/Kiwify),
  // exceto `ref`/`fn` já presentes no destino (Story 16.3), que nunca são sobrescritos.
  for (const [key, value] of Object.entries(config.customParams ?? {})) url.searchParams.set(key, value);
  const allowed = new Set<string>(config.allowedParams ?? DEFAULT_PASSTHROUGH);
  for (const key of allowed) {
    const value = query.get(key);
    if (isProtectedParam(key) && url.searchParams.has(key)) continue;
    if (value && value.length <= 500) url.searchParams.set(key, value);
  }
  return url.toString();
}

const CTA_RULE_KEYS = ['id', 'selectors', 'unlockAfterSeconds', 'action', 'waitSelectors', 'label', 'managed', 'inheritsDefault'];
const validSeconds = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 7200;
const safeLabel = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && !/[<>]/.test(value) && ![...value].some((char) => char.charCodeAt(0) < 32);

export function validateCtaConfig(input: unknown, hasNextStep: boolean, hasCheckout: boolean): VslCtaConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid CTA configuration');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['ttlSeconds', 'defaultUnlockAfterSeconds', 'ctas'].includes(key)) ||
    (value.ttlSeconds !== undefined && (!Number.isSafeInteger(value.ttlSeconds) || Number(value.ttlSeconds) < 60 || Number(value.ttlSeconds) > 2592000)))
    throw new Error('Invalid CTA TTL');
  if (value.defaultUnlockAfterSeconds !== undefined && !validSeconds(value.defaultUnlockAfterSeconds)) throw new Error('Invalid CTA default time');
  if (!Array.isArray(value.ctas) || value.ctas.length > 20) throw new Error('Invalid CTA rules');
  const ids = new Set<string>();
  for (const item of value.ctas) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid CTA rule');
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !CTA_RULE_KEYS.includes(key)) ||
      typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(rule.id) || ids.has(rule.id) ||
      !validSelectorList(rule.selectors, 1, 20) || (rule.waitSelectors !== undefined && !validSelectorList(rule.waitSelectors, 0, 10)) ||
      !validSeconds(rule.unlockAfterSeconds) || (rule.label !== undefined && !safeLabel(rule.label)) ||
      ['managed', 'inheritsDefault'].some((flag) => rule[flag] !== undefined && typeof rule[flag] !== 'boolean'))
      throw new Error('Invalid CTA rule');
    ids.add(rule.id);
    const action = rule.action as Record<string, unknown> | null;
    if (!action || !['NEXT_STEP', 'CHECKOUT', 'EXTERNAL_URL'].includes(String(action.type))) throw new Error('Invalid CTA action');
    if (action.type === 'NEXT_STEP' && !hasNextStep) throw new Error('CTA next step is missing');
    if (action.type === 'CHECKOUT' && !hasCheckout) throw new Error('CTA checkout is missing');
    if (action.type === 'EXTERNAL_URL') validateExternalHttps(String(action.url));
  }
  return value as unknown as VslCtaConfig;
}

export interface VslCtaTargetReport {
  /** Selectors absent from the static HTML. Accepted as "dynamic" (created later by quiz/SPA JS): publish must warn, not fail. */
  dynamicSelectors: Array<{ ctaId: string; selector: string }>;
}

/** Throws only for selectors that cannot be parsed; absent selectors are reported as dynamic. */
export function validateCtaTargets(html: string, config: VslCtaConfig): VslCtaTargetReport {
  const tree = parse(html, { treeAdapter: adapter });
  const report: VslCtaTargetReport = { dynamicSelectors: [] };
  for (const cta of config.ctas) {
    for (const rule of cta.selectors) {
      let count = 0;
      try { count = selectAll(rule, tree.children).length; }
      catch { throw new Error(`Invalid CTA selector: ${rule}`); }
      if (!count) report.dynamicSelectors.push({ ctaId: cta.id, selector: rule });
    }
    // Mensagem de espera ausente do HTML estático é só "nada a esconder": não vira aviso; seletor ilegível falha.
    for (const rule of cta.waitSelectors ?? []) {
      try { selectAll(rule, tree.children); }
      catch { throw new Error(`Invalid CTA wait selector: ${rule}`); }
    }
  }
  return report;
}

export type VslPublishWarningCode = 'CTA_SELECTOR_DYNAMIC' | 'CTA_TIMED_WITHOUT_VIDEO';
export interface VslPublishWarning { code: VslPublishWarningCode; message: string; ctaId?: string; selector?: string }

/**
 * Non-blocking publish-check warnings for one step (contract for the backend/UI publish checklist).
 * - CTA_SELECTOR_DYNAMIC: selector not found in the static HTML (runtime still locks it when it appears).
 * - CTA_TIMED_WITHOUT_VIDEO: `unlockAfterSeconds > 0` but the step has no ready video; the runtime falls back
 *   to wall-clock time on the page (visible tab only) and emits a `Diagnostic` event.
 */
export function collectStepPublishWarnings(step: { ctaConfig: unknown; html?: string | null; hasVideo: boolean }): VslPublishWarning[] {
  const warnings: VslPublishWarning[] = [];
  const config = step.ctaConfig as Partial<VslCtaConfig> | null;
  if (!config || !Array.isArray(config.ctas)) return warnings;
  if (step.html) for (const item of validateCtaTargets(step.html, config as VslCtaConfig).dynamicSelectors)
    warnings.push({ code: 'CTA_SELECTOR_DYNAMIC', ctaId: item.ctaId, selector: item.selector,
      message: `CTA "${item.ctaId}": "${item.selector}" não existe no HTML estático; será tratado como CTA dinâmico.` });
  if (!step.hasVideo) for (const cta of config.ctas) if (Number(cta.unlockAfterSeconds) > 0)
    warnings.push({ code: 'CTA_TIMED_WITHOUT_VIDEO', ctaId: cta.id,
      message: `CTA "${cta.id}" libera após ${cta.unlockAfterSeconds}s mas a etapa não tem vídeo; o tempo será contado pelo relógio da página.` });
  return warnings;
}

export function validateTrackingConfig(input: unknown): VslTrackingConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tracking configuration');
  const value = input as Record<string, unknown>;
  const flags = ['enabled', 'keepOriginalTrackers'];
  if (Object.keys(value).some((key) => !['enabled', 'keepOriginalTrackers', 'metaPixelId', 'googleAdsId', 'googleAdsLabel', 'tiktokPixelId'].includes(key)) ||
    flags.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') ||
    Object.entries(value).some(([key, item]) => !flags.includes(key) && (typeof item !== 'string' || !pixel.test(item))))
    throw new Error('Invalid VSL tracking configuration');
  return value as VslTrackingConfig;
}

/* ───────────────────────────── Player (estilo VTurb) ─────────────────────────────
 * Stored in `video_placement.player` (step + step release snapshot), so no schema migration is needed.
 * Watched time (CTA unlock, VSL25/50/75/Complete, heartbeat) counts real playback with or without sound;
 * when the viewer clicks "Clique para ouvir" the video restarts from 0 and the muted preview seconds are
 * discarded, so the CTA stays aligned with the video timeline.
 */
export const VSL_PLAYER_LOCALES = ['pt', 'en', 'es', 'fr', 'de', 'it', 'nl', 'pl'] as const;
export type VslPlayerLocale = typeof VSL_PLAYER_LOCALES[number];
export const VSL_PLAYER_ASPECT_RATIOS = ['16:9', '9:16', '4:5', '1:1', '4:3'] as const;
/** Velocidade fixa do vídeo (VSL-14). Máximo 1.25x: acima disso o anti-antecipação do runtime para de contar. */
export const VSL_PLAYBACK_RATES = [1, 1.05, 1.1, 1.15, 1.2, 1.25] as const;
export type VslPlaybackRate = typeof VSL_PLAYBACK_RATES[number];
export interface VslPlayerTexts { unmuteTitle?: string; unmute?: string; resumeTitle?: string; resumeContinue?: string; resumeRestart?: string; play?: string }
export interface VslPlayerConfig {
  autoplayMuted: boolean;
  fakeProgress: boolean;
  resume: boolean;
  hideControls: boolean;
  disableSeek: boolean;
  blockPauseOnClick: boolean;
  poster: string | null;
  barColor: string;
  overlayColor: string;
  overlayTextColor: string;
  aspectRatio: typeof VSL_PLAYER_ASPECT_RATIOS[number];
  locale: 'auto' | VslPlayerLocale;
  playbackRate: VslPlaybackRate;
  texts: VslPlayerTexts;
}
export const DEFAULT_VSL_PLAYER: Readonly<VslPlayerConfig> = Object.freeze({
  autoplayMuted: true, fakeProgress: true, resume: true, hideControls: true, disableSeek: true, blockPauseOnClick: false,
  poster: null, barColor: '#E11D48', overlayColor: '#E11D48', overlayTextColor: '#FFFFFF', aspectRatio: '16:9', locale: 'auto', playbackRate: 1, texts: {},
});
const PLAYER_KEYS = Object.keys(DEFAULT_VSL_PLAYER);
const PLAYER_FLAGS = ['autoplayMuted', 'fakeProgress', 'resume', 'hideControls', 'disableSeek', 'blockPauseOnClick'] as const;
const TEXT_KEYS = ['unmuteTitle', 'unmute', 'resumeTitle', 'resumeContinue', 'resumeRestart', 'play'];
const hexColor = /^#[0-9a-fA-F]{6}$/;

/** Strict validation of a (partial) player config. Unknown keys are rejected. Returns the merged config. */
export function validatePlayerConfig(input: unknown): VslPlayerConfig {
  if (input === undefined || input === null) return { ...DEFAULT_VSL_PLAYER, texts: {} };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid player configuration');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !PLAYER_KEYS.includes(key))) throw new Error('Unknown player option');
  for (const flag of PLAYER_FLAGS) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error(`Invalid player option: ${flag}`);
  for (const key of ['barColor', 'overlayColor', 'overlayTextColor'])
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !hexColor.test(value[key] as string))) throw new Error(`Invalid player color: ${key}`);
  if (value.poster !== undefined && value.poster !== null) {
    if (typeof value.poster !== 'string' || value.poster.length > 1000) throw new Error('Invalid player poster');
    validateExternalHttps(value.poster);
  }
  if (value.aspectRatio !== undefined && !(VSL_PLAYER_ASPECT_RATIOS as readonly unknown[]).includes(value.aspectRatio)) throw new Error('Invalid player aspect ratio');
  if (value.locale !== undefined && value.locale !== 'auto' && !(VSL_PLAYER_LOCALES as readonly unknown[]).includes(value.locale)) throw new Error('Invalid player locale');
  if (value.playbackRate !== undefined && !(VSL_PLAYBACK_RATES as readonly unknown[]).includes(value.playbackRate)) throw new Error('Invalid player playback rate');
  if (value.texts !== undefined) {
    const texts = value.texts as Record<string, unknown>;
    if (!texts || typeof texts !== 'object' || Array.isArray(texts) || Object.entries(texts).some(([key, text]) =>
      !TEXT_KEYS.includes(key) || typeof text !== 'string' || !text.trim() || text.length > 80 || /[<>]/.test(text) || [...text].some((char) => char.charCodeAt(0) < 32)))
      throw new Error('Invalid player texts');
  }
  return { ...DEFAULT_VSL_PLAYER, ...(value as Partial<VslPlayerConfig>), texts: { ...((value.texts as VslPlayerTexts | undefined) ?? {}) } };
}

/** Lenient resolution for the public runtime: invalid stored options fall back to defaults instead of breaking the page. */
export function resolvePlayerConfig(input: unknown): VslPlayerConfig {
  try { return validatePlayerConfig(input); }
  catch { return { ...DEFAULT_VSL_PLAYER, texts: {} }; }
}

/** Default label of the CTA button on the dedicated player page (NATIVE_VIDEO). */
export const DEFAULT_NATIVE_CTA_LABEL = 'Continuar';
const NATIVE_CTA_LABEL_MAX = 60;

function isValidNativeCtaLabel(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= NATIVE_CTA_LABEL_MAX && !/[<>]/.test(value) &&
    ![...value].some((char) => char.charCodeAt(0) < 32);
}

/** Lenient resolution for the public runtime: missing/invalid stored label falls back to "Continuar". */
export function resolveNativeCtaLabel(input: unknown): string {
  return isValidNativeCtaLabel(input) ? input.trim() : DEFAULT_NATIVE_CTA_LABEL;
}

/** Validates `video_placement` including the optional `player` block and `ctaLabel` (for API PATCH and publish). */
export function validateVideoPlacementConfig(input: unknown): { strategy?: 'PLACEHOLDER' | 'SELECTOR' | 'DEDICATED'; selector?: string; player?: VslPlayerConfig; ctaLabel?: string } {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid video placement');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['strategy', 'selector', 'player', 'ctaLabel'].includes(key))) throw new Error('Invalid video placement');
  if (value.ctaLabel !== undefined && !isValidNativeCtaLabel(value.ctaLabel)) throw new Error('Invalid CTA label');
  if (value.strategy !== undefined && !['PLACEHOLDER', 'SELECTOR', 'DEDICATED'].includes(String(value.strategy))) throw new Error('Invalid video placement');
  if (value.selector !== undefined && (typeof value.selector !== 'string' || !selector.test(value.selector) || [...value.selector].some((char) => char.charCodeAt(0) < 32)))
    throw new Error('Invalid video selector');
  if (value.player !== undefined) validatePlayerConfig(value.player);
  return value as ReturnType<typeof validateVideoPlacementConfig>;
}
