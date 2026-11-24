/**
 * Story 16.3 — provedor de checkout `external` (checkout do produtor, sem Stripe/Shopify/payments).
 *
 * Fonte única de verdade para:
 *  - o tipo `CheckoutProvider` (`shopify | stripe | external`);
 *  - o mapa kit->URL guardado em `landing_pages.cta_config.externalCheckout`;
 *  - o validador de URL de checkout externo (espelha `validateExternalHttps` do VSL, sem `node:net`,
 *    porque também roda no browser/edge);
 *  - a lista de parâmetros repassados ao destino (paridade testada com `CHECKOUT_PARAMS`/`DEFAULT_PASSTHROUGH`);
 *  - o tracker opcional do Sphere (terceiro, default desligado);
 *  - o script de navegação direta servido no modo `external`.
 *
 * Sem dependências: importável por backoffice, api, worker e storefront.
 */

export const CHECKOUT_PROVIDERS = ['shopify', 'stripe', 'external'] as const;
export type CheckoutProvider = (typeof CHECKOUT_PROVIDERS)[number];

export function isCheckoutProvider(value: unknown): value is CheckoutProvider {
  return typeof value === 'string' && (CHECKOUT_PROVIDERS as readonly string[]).includes(value);
}

/** Valor desconhecido/ausente = `shopify` (default da coluna; landings antigas intactas). */
export function normalizeCheckoutProvider(value: unknown): CheckoutProvider {
  return isCheckoutProvider(value) ? value : 'shopify';
}

/** Kits suportados, na ordem de fallback (coerente com `VSL_RUN_POTS = [1, 3, 5]`). */
export const EXTERNAL_KITS = ['1', '3', '5'] as const;
export type ExternalKit = (typeof EXTERNAL_KITS)[number];

export function isExternalKit(value: unknown): value is ExternalKit {
  return typeof value === 'string' && (EXTERNAL_KITS as readonly string[]).includes(value);
}

/** Guardado em `landing_pages.cta_config.externalCheckout` (as demais chaves do jsonb são preservadas). */
export interface ExternalCheckoutConfig {
  '1'?: string;
  '3'?: string;
  '5'?: string;
  default?: ExternalKit;
  allowSphereTracker?: boolean;
}

export const EXTERNAL_CHECKOUT_URL_MAX = 2048;

export type ExternalUrlReason = 'empty' | 'too_long' | 'invalid_url' | 'not_https' | 'credentials' | 'port' | 'host';

export type ExternalUrlResult = { ok: true; url: string } | { ok: false; reason: ExternalUrlReason };

export const EXTERNAL_URL_REASON_PT: Record<ExternalUrlReason, string> = {
  empty: 'URL vazia',
  too_long: `URL maior que ${EXTERNAL_CHECKOUT_URL_MAX} caracteres`,
  invalid_url: 'URL inválida',
  not_https: 'só https é aceito',
  credentials: 'URL com usuário/senha',
  port: 'porta diferente de 443',
  host: 'host inválido (IP, localhost ou sem ponto)',
};

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RESERVED_HOST = /(?:^|\.)(?:localhost|local|internal|test)$/i;

/**
 * Validador único de URL de checkout externo (AC 2/12). Mesmas regras de `validateExternalHttps`
 * (`packages/vsl-hosting/src/funnel-config.ts`) + limite de tamanho. Não lança: devolve o motivo.
 */
export function validateExternalCheckoutUrl(raw: unknown): ExternalUrlResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  const value = raw.trim();
  if (value.length > EXTERNAL_CHECKOUT_URL_MAX) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'port' };
  const host = url.hostname;
  if (!host.includes('.') || IPV4.test(host) || host.startsWith('[') || host.includes(':') || RESERVED_HOST.test(host)) {
    return { ok: false, reason: 'host' };
  }
  return { ok: true, url: url.toString() };
}

export interface ExternalCheckoutInputError {
  kit: ExternalKit | 'default' | 'config';
  reason: string;
}

export type ParseExternalCheckoutResult =
  | { ok: true; config: ExternalCheckoutConfig }
  | { ok: false; errors: ExternalCheckoutInputError[] };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Parser estrito para escrita (checkout-settings, rota do catálogo). Qualquer URL informada e inválida
 * = erro com kit e motivo (nada é gravado). Exige ao menos 1 kit válido. Kits vazios ficam pendentes.
 */
export function parseExternalCheckoutInput(input: unknown): ParseExternalCheckoutResult {
  if (!isRecord(input)) return { ok: false, errors: [{ kit: 'config', reason: 'config do checkout externo ausente' }] };
  const errors: ExternalCheckoutInputError[] = [];
  const config: ExternalCheckoutConfig = {};
  for (const kit of EXTERNAL_KITS) {
    const raw = input[kit];
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) continue;
    const res = validateExternalCheckoutUrl(raw);
    if (res.ok) config[kit] = res.url;
    else errors.push({ kit, reason: EXTERNAL_URL_REASON_PT[res.reason] });
  }
  const def = input.default;
  if (def !== undefined && def !== null && def !== '') {
    if (!isExternalKit(def)) errors.push({ kit: 'default', reason: 'kit padrão deve ser 1, 3 ou 5' });
    else if (!config[def] && !errors.some((e) => e.kit === def)) errors.push({ kit: 'default', reason: 'kit padrão sem URL configurada' });
    else config.default = def;
  }
  if (input.allowSphereTracker !== undefined && typeof input.allowSphereTracker !== 'boolean') {
    errors.push({ kit: 'config', reason: 'allowSphereTracker deve ser booleano' });
  } else {
    config.allowSphereTracker = input.allowSphereTracker === true;
  }
  if (errors.length) return { ok: false, errors };
  if (!EXTERNAL_KITS.some((k) => config[k])) return { ok: false, errors: [{ kit: 'config', reason: 'informe ao menos 1 kit (1, 3 ou 5 potes)' }] };
  return { ok: true, config };
}

/**
 * Leitura tolerante do jsonb `cta_config` (storefront, publish-check, cloner). Revalida cada URL e
 * descarta o que não passa — nunca confia no jsonb para navegar.
 */
export function readExternalCheckoutConfig(ctaConfig: unknown): ExternalCheckoutConfig {
  const raw = isRecord(ctaConfig) ? ctaConfig.externalCheckout : undefined;
  if (!isRecord(raw)) return {};
  const out: ExternalCheckoutConfig = {};
  for (const kit of EXTERNAL_KITS) {
    const res = validateExternalCheckoutUrl(raw[kit]);
    if (res.ok) out[kit] = res.url;
  }
  if (isExternalKit(raw.default) && out[raw.default]) out.default = raw.default;
  out.allowSphereTracker = raw.allowSphereTracker === true;
  return out;
}

/** `cta_config` novo com `externalCheckout` trocado, preservando `mappings`, `lastRewriteAt` e demais chaves. */
export function mergeExternalCheckoutIntoCtaConfig(ctaConfig: unknown, external: ExternalCheckoutConfig): Record<string, unknown> {
  return { ...(isRecord(ctaConfig) ? ctaConfig : {}), externalCheckout: external };
}

export function configuredExternalKits(config: ExternalCheckoutConfig): ExternalKit[] {
  return EXTERNAL_KITS.filter((k) => !!config[k]);
}

export function missingExternalKits(config: ExternalCheckoutConfig): ExternalKit[] {
  return EXTERNAL_KITS.filter((k) => !config[k]);
}

/** Kit padrão: `default` configurado → 1 pote → primeiro disponível (1, 3, 5) → null (nenhum). */
export function resolveDefaultKit(config: ExternalCheckoutConfig): ExternalKit | null {
  if (config.default && config[config.default]) return config.default;
  return configuredExternalKits(config)[0] ?? null;
}

/**
 * Parâmetros repassados da URL da página ao checkout externo (AC 11). Mesma lista do VSL
 * (`CHECKOUT_PARAMS`/`DEFAULT_PASSTHROUGH`, paridade em teste). `ref` só se o visitante já o trouxe.
 */
export const EXTERNAL_CHECKOUT_PASSTHROUGH = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'ttclid',
  'src',
  'sck',
  'ref',
] as const;

/** Parâmetros do link do produtor que nunca são sobrescritos (o `fn` nunca é repassado). */
export const PROTECTED_DESTINATION_PARAMS = ['ref', 'fn'] as const;

/**
 * Versão pura da regra de repasse (usada em testes e no servidor): só parâmetros presentes na URL da
 * página; nunca sobrescreve um parâmetro que o destino já tenha; nunca toca em `fn`.
 */
export function applyExternalPassthrough(destination: string, pageSearch: string | URLSearchParams): string {
  const url = new URL(destination);
  const page = typeof pageSearch === 'string' ? new URLSearchParams(pageSearch) : pageSearch;
  for (const key of EXTERNAL_CHECKOUT_PASSTHROUGH) {
    const value = page.get(key);
    if (!value || value.length > 500 || url.searchParams.has(key)) continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Tracker do Sphere: terceiro, opcional, default desligado. Só esta URL exata é permitida. */
export const SPHERE_TRACKER_URL = 'https://sphereaffiliate.com/api/public/tracker.js';
export const SPHERE_TRACKER_TAG = `<script src="${SPHERE_TRACKER_URL}" defer data-landinglab-sphere-tracker="1"></script>`;

/** `true` se a tag `<script ...>` (abertura) carrega exatamente o tracker do Sphere. */
export function isExactSphereTrackerTag(openTag: string): boolean {
  const m = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(openTag);
  if (!m?.[1]) return false;
  return m[1].replace(/&amp;/g, '&') === SPHERE_TRACKER_URL;
}

export function hasSphereTracker(html: string): boolean {
  const re = /<script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (isExactSphereTrackerTag(m[0])) return true;
  return false;
}

/**
 * Remove `<script>` de `sphereaffiliate.com` (src ou inline). Com `allowTracker`, preserva só o tracker
 * exato e o injeta no `<head>` se ausente.
 */
export function applySphereTrackerPolicy(html: string, allowTracker: boolean): string {
  let out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
    if (!/sphereaffiliate\.com/i.test(attrs) && !/sphereaffiliate\.com/i.test(body)) return full;
    if (allowTracker && isExactSphereTrackerTag(`<script${attrs}>`) && !body.trim()) return full;
    return '';
  });
  if (allowTracker && !hasSphereTracker(out)) {
    out = /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (h) => `${h}${SPHERE_TRACKER_TAG}`) : `${SPHERE_TRACKER_TAG}${out}`;
  }
  return out;
}

/** Marcador do script do modo `external` (whitelist no sanitizador do storefront). */
export const EXTERNAL_CHECKOUT_SCRIPT_MARKER = 'data-landinglab-engine="external-checkout"';

const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/**
 * Corpo JS do modo `external` (AC 4, 5, 11, 12, 18). Navegação direta na mesma aba para a URL do kit
 * vinda SÓ do mapa validado pelo servidor (nunca da query). Listener em `window` (capture) para rodar
 * antes dos listeners legados em `document`. Retorna string vazia se nenhum kit for válido (CTA não reescrito).
 */
export function buildExternalCheckoutScriptBody(config: ExternalCheckoutConfig): string {
  const clean = readExternalCheckoutConfig({ externalCheckout: config });
  const def = resolveDefaultKit(clean);
  if (!def) return '';
  const map: Record<string, string> = {};
  for (const kit of configuredExternalKits(clean)) map[kit] = clean[kit] as string;
  return `(function(){
if (window.__LL_EXTERNAL_CHECKOUT__) return; window.__LL_EXTERNAL_CHECKOUT__ = true;
var MAP = ${jsonForScript(map)}; var DEF = ${jsonForScript(def)};
var PASS = ${jsonForScript(EXTERNAL_CHECKOUT_PASSTHROUGH)};
function kitFrom(v){ if (v == null) return null; var m = String(v).match(/\\d+/); return m && MAP[m[0]] ? m[0] : null; }
function attrKit(n){ return kitFrom(n.getAttribute('data-landing-kit')) || kitFrom(n.getAttribute('data-landing-pots')); }
function resolveKit(el){
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) { var k = attrKit(n); if (k) return k; }
  var sel = document.querySelector('[data-landing-variant-active="true"], .kaching-bundles__bar--selected');
  if (sel) { var s = attrKit(sel) || kitFrom(sel.getAttribute('data-landing-qty')); if (s) return s; }
  return DEF;
}
function destination(kit){
  var raw = MAP[kit] || MAP[DEF]; if (!raw) return null;
  var url; try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  var page = new URLSearchParams(window.location.search);
  for (var i = 0; i < PASS.length; i++) {
    var key = PASS[i]; var val = page.get(key);
    if (!val || val.length > 500 || url.searchParams.has(key)) continue;
    url.searchParams.set(key, val);
  }
  return url.toString();
}
function internalCheckoutHref(a){
  var h = a.getAttribute('href'); if (!h) return false;
  try { var u = new URL(h, window.location.href); } catch (e) { return false; }
  if (u.origin !== window.location.origin) return false;
  return /^\\/(checkouts?|cart)(\\/|$)/i.test(u.pathname);
}
function go(ev, el){
  var dest = destination(resolveKit(el)); if (!dest) return;
  ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  window.location.assign(dest);
}
window.addEventListener('click', function(ev){
  var t = ev.target; if (!t || !t.closest) return;
  var cta = t.closest('[data-landing-cta="buy"]');
  if (cta) return go(ev, cta);
  var a = t.closest('a[href]');
  if (a && internalCheckoutHref(a)) return go(ev, a);
}, true);
window.addEventListener('submit', function(ev){
  var f = ev.target; if (!f || !f.getAttribute) return;
  var action = f.getAttribute('action') || '';
  if (/\\/cart(\\/add)?(\\.js)?(\\?|$)/i.test(action) || /\\/checkout/i.test(action)) go(ev, f);
}, true);
})();`;
}

/** `<script>` completo do modo `external` (marcado para sobreviver ao sanitizador do storefront). */
export function buildExternalCheckoutScript(config: ExternalCheckoutConfig): string {
  const body = buildExternalCheckoutScriptBody(config);
  return body ? `<script ${EXTERNAL_CHECKOUT_SCRIPT_MARKER}>${body}</script>` : '';
}
