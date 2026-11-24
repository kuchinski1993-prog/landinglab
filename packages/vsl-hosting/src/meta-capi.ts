// VSL-13 (Fase A) — contrato compartilhado da Meta Conversions API no VSL Hosting.
//
// Usado pelo `vsl-storefront` (Vercel: valida o contexto vindo do navegador e encaminha) e pela API
// (Railway: autentica o encaminhamento, resolve pixel/token e envia à Meta). Sem dependências de banco/HTTP.
//
// - Eventos padrão (D1/D3): PageView, VSL25 → ViewContent, CheckoutClick → InitiateCheckout. Nada custom vai ao CAPI.
// - Token por pixel no vault (`vsl_meta_capi:<metaPixelId>`), nunca em `tracking_config`.
// - Encaminhamento storefront→API autenticado com HMAC-SHA256 (`VSL_CAPI_INTERNAL_SECRET`) + timestamp.
// - Consentimento (Fase A): mesma lista/regra de `consentRequired` da LandingLab
//   (apps/landinglab-storefront/src/lib/consent-banner.ts), copiada aqui até a Fase B extrair o banner
//   para um pacote compartilhado. País desconhecido exige consentimento.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Evento do runtime → evento padrão da Meta (navegador e servidor usam o MESMO nome e `event_id`). */
export const VSL_CAPI_STANDARD_EVENTS = { PageView: 'PageView', VSL25: 'ViewContent', CheckoutClick: 'InitiateCheckout' } as const;
export type VslCapiSourceEvent = keyof typeof VSL_CAPI_STANDARD_EVENTS;
export type VslCapiEventName = (typeof VSL_CAPI_STANDARD_EVENTS)[VslCapiSourceEvent];
export const VSL_CAPI_EVENT_NAMES: readonly VslCapiEventName[] = ['PageView', 'ViewContent', 'InitiateCheckout'];

export function vslCapiStandardEvent(name: string): VslCapiEventName | null {
  return Object.hasOwn(VSL_CAPI_STANDARD_EVENTS, name) ? VSL_CAPI_STANDARD_EVENTS[name as VslCapiSourceEvent] : null;
}

/* ───────────────────────────── Consentimento (cópia da LandingLab) ───────────────────────────── */

// UE + EEE (IS, LI, NO) + Reino Unido + Suíça. Manter igual a CONSENT_REQUIRED_COUNTRIES da LandingLab.
export const VSL_CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'GB', 'CH',
]);

/** País (ISO alpha-2, ex.: `x-vercel-ip-country`) exige consentimento? Ausente/inválido → exige. */
export function vslConsentRequired(country: string | null | undefined): boolean {
  const cc = (country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return true;
  return VSL_CONSENT_REQUIRED_COUNTRIES.has(cc);
}

/* ───────────────────────────── Token por pixel ───────────────────────────── */

const PIXEL_ID = /^[A-Za-z0-9._-]{2,120}$/;
const TOKEN = /^[A-Za-z0-9_|.-]{32,1024}$/;

export function isVslMetaPixelId(value: unknown): value is string {
  return typeof value === 'string' && PIXEL_ID.test(value);
}

/** Chave do vault do token CAPI de um dataset (pixel). Independente de `tracking_pixels.capi_token_key`. */
export function vslCapiTokenKey(pixelId: string): string {
  if (!isVslMetaPixelId(pixelId)) throw new Error('Invalid Meta pixel id');
  return `vsl_meta_capi:${pixelId}`;
}

/** Formato plausível de token de acesso da Meta (sem espaços, 32–1024 caracteres). Nunca ecoa o valor. */
export function isPlausibleMetaCapiToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/* ───────────────────────────── Contexto vindo do navegador ───────────────────────────── */

/** `capi` opcional no corpo de `POST /__vsl/events` (só nos 3 eventos padrão). */
export interface VslCapiBrowserContext { eventId: string; fbp?: string; fbc?: string; fbclid?: string; url?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// _fbp/_fbc: fb.<subdomínio>.<criação ms>.<aleatório|fbclid> (sufixos recentes da Meta usam ., _ e -).
const FB_COOKIE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_.-]{1,500}$/;
const FBCLID = /^[A-Za-z0-9_.-]{1,500}$/;
const CONTEXT_KEYS = ['eventId', 'fbp', 'fbc', 'fbclid', 'url'];

const isFbp = (value: unknown): value is string => typeof value === 'string' && value.length <= 120 && FB_COOKIE.test(value);
const isFbc = (value: unknown): value is string => typeof value === 'string' && value.length <= 600 && FB_COOKIE.test(value);
const isFbclid = (value: unknown): value is string => typeof value === 'string' && FBCLID.test(value);

/** URL da página: https, mesmo hostname da requisição, sem credenciais/porta/query/fragmento, até 1024 caracteres. */
export function isVslCapiPageUrl(value: unknown, hostname: string): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}

/** Valida o `capi` do corpo do evento; lança em qualquer formato fora do contrato (o servidor responde 400). */
export function validateVslCapiBrowserContext(input: unknown, hostname: string): VslCapiBrowserContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid capi context');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !CONTEXT_KEYS.includes(key))) throw new Error('Invalid capi context');
  if (typeof value['eventId'] !== 'string' || !UUID.test(value['eventId'])) throw new Error('Invalid capi context');
  if (value['fbp'] !== undefined && !isFbp(value['fbp'])) throw new Error('Invalid capi context');
  if (value['fbc'] !== undefined && !isFbc(value['fbc'])) throw new Error('Invalid capi context');
  if (value['fbclid'] !== undefined && !isFbclid(value['fbclid'])) throw new Error('Invalid capi context');
  if (value['url'] !== undefined && !isVslCapiPageUrl(value['url'], hostname)) throw new Error('Invalid capi context');
  return value as unknown as VslCapiBrowserContext;
}

/* ───────────────────────────── Payload interno storefront → API ───────────────────────────── */

export interface VslCapiForwardPayload {
  hostname: string;
  projectId: string;
  stepId: string;
  releaseId: string;
  eventName: VslCapiEventName;
  /** `event_id` do evento PADRÃO do navegador (dedup com o Pixel). */
  eventId: string;
  /** Unix (segundos) do evento no navegador. */
  eventTime: number;
  pageUrl?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  /** IP/UA do visitante capturados pelo vsl-storefront (nunca os da conexão storefront→API). */
  ip?: string;
  userAgent?: string;
  /** Decisão de consentimento tomada no storefront pelo país da requisição (a API não reavalia país). */
  consentRequired: boolean;
  consentGranted: boolean;
}

const PAYLOAD_KEYS = ['hostname', 'projectId', 'stepId', 'releaseId', 'eventName', 'eventId', 'eventTime', 'pageUrl', 'fbp', 'fbc', 'fbclid',
  'ip', 'userAgent', 'consentRequired', 'consentGranted'];
/** Algum caractere de controle (U+0000–U+001F, U+007F)? Sem regex de controle (lint no-control-regex). */
export function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_EVENT_AGE_S = 7 * 86400;

/** Valida o payload interno (lado API). `now` em ms. Lança em qualquer desvio. */
export function validateVslCapiForwardPayload(input: unknown, now = Date.now()): VslCapiForwardPayload {
  const fail = (): never => { throw new Error('Invalid VSL CAPI payload'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !PAYLOAD_KEYS.includes(key))) fail();
  if (typeof value['hostname'] !== 'string' || !HOSTNAME.test(value['hostname'])) fail();
  for (const key of ['projectId', 'stepId', 'releaseId', 'eventId'])
    if (typeof value[key] !== 'string' || !UUID.test(value[key] as string)) fail();
  if (!VSL_CAPI_EVENT_NAMES.includes(value['eventName'] as VslCapiEventName)) fail();
  const time = value['eventTime'];
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < Math.floor(now / 1000) - MAX_EVENT_AGE_S || time > Math.floor(now / 1000) + 300) fail();
  if (value['pageUrl'] !== undefined && !isVslCapiPageUrl(value['pageUrl'], value['hostname'] as string)) fail();
  if (value['fbp'] !== undefined && !isFbp(value['fbp'])) fail();
  if (value['fbc'] !== undefined && !isFbc(value['fbc'])) fail();
  if (value['fbclid'] !== undefined && !isFbclid(value['fbclid'])) fail();
  if (value['ip'] !== undefined && (typeof value['ip'] !== 'string' || value['ip'].length > 64 || isIP(value['ip']) === 0)) fail();
  if (value['userAgent'] !== undefined && (typeof value['userAgent'] !== 'string' || !value['userAgent'] || value['userAgent'].length > 512 ||
    hasControlChars(value['userAgent']))) fail();
  if (typeof value['consentRequired'] !== 'boolean' || typeof value['consentGranted'] !== 'boolean') fail();
  return value as unknown as VslCapiForwardPayload;
}

/* ───────────────────────────── Autenticação do endpoint interno ───────────────────────────── */

export const VSL_CAPI_TIMESTAMP_HEADER = 'x-vsl-capi-timestamp';
export const VSL_CAPI_SIGNATURE_HEADER = 'x-vsl-capi-signature';
/** Janela de validade da assinatura (relógios Vercel × Railway). Replays dentro dela são barrados pela idempotência. */
export const VSL_CAPI_SIGNATURE_WINDOW_S = 300;
export const VSL_CAPI_MIN_SECRET_LENGTH = 32;

export function signVslCapiRequest(body: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`vsl-capi:${timestamp}.${body}`).digest('hex');
}

/** Verifica timestamp (janela) + HMAC em tempo constante. Sem segredo válido → sempre false. */
export function verifyVslCapiRequest(body: string, timestampHeader: unknown, signatureHeader: unknown, secret: string | null | undefined, now = Date.now()): boolean {
  if (!secret || secret.length < VSL_CAPI_MIN_SECRET_LENGTH) return false;
  if (typeof timestampHeader !== 'string' || !/^\d{9,12}$/.test(timestampHeader)) return false;
  if (typeof signatureHeader !== 'string' || !/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (Math.abs(Math.floor(now / 1000) - timestamp) > VSL_CAPI_SIGNATURE_WINDOW_S) return false;
  const expected = Buffer.from(signVslCapiRequest(body, timestamp, secret), 'hex');
  const given = Buffer.from(signatureHeader, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
