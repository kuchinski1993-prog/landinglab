import type { Sql } from 'postgres';

import { normalizeVslHostname } from './domains.js';
import { VSL_ERRORS } from './errors.js';
import { VslError } from './imports.js';

type RemoteVideo = { uid?: string; allowedOrigins?: string[]; requireSignedURLs?: boolean };
type CloudflareResponse = { success?: boolean; result?: RemoteVideo };
type AssetRow = { id: string; provider_asset_id: string | null; status: string };

export interface VslStreamOriginOptions {
  /** Timeout de cada chamada ao Stream (AbortController). Padrão 10 s. */
  timeoutMs?: number;
  /** Tentativas por chamada (falha de rede/timeout, 429 e 5xx). Padrão 2. */
  attempts?: number;
  /** Espera entre tentativas. Padrão 300 ms. */
  retryDelayMs?: number;
  /** Teto de tempo da operação inteira. Padrão 30 s. */
  budgetMs?: number;
}

const DEFAULTS: Required<VslStreamOriginOptions> = { timeoutMs: 10_000, attempts: 2, retryDelayMs: 300, budgetMs: 30_000 };
/** Rodadas de leitura → escrita → conferência (cobre escrita concorrente de outra instância). */
const MAX_ROUNDS = 3;
/** Serializa por vídeo dentro do processo: dois publishes do mesmo vídeo não se sobrescrevem no Stream. */
const inflight = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadReadyAsset(sql: Sql, assetId: string): Promise<AssetRow & { provider_asset_id: string }> {
  // Leitura simples, sem FOR UPDATE e fora de transação: nenhuma conexão fica presa durante o HTTP.
  const [asset] = await sql<AssetRow[]>`SELECT id,provider_asset_id,status FROM vsl_video_assets WHERE id=${assetId} AND store_id='l0i'`;
  if (!asset || asset.status !== 'ready' || !/^[a-f0-9]{32}$/i.test(String(asset.provider_asset_id ?? '')))
    throw new VslError('Video is not READY for origin update', 409, 'video_not_ready');
  return asset as AssetRow & { provider_asset_id: string };
}

/**
 * Add published VSL hosts to one video without widening other Stream policies.
 *
 * QA F4 M1: as chamadas ao Cloudflare acontecem FORA de transação/lock (antes o
 * `SELECT … FOR UPDATE` segurava uma conexão do pool VSL enquanto o fetch, sem timeout,
 * podia travar por minutos). Fluxo: lê o vídeo → GET/POST no Stream (timeout + retry curto)
 * → checagem otimista (o vídeo continua READY com o mesmo uid) → GET de conferência.
 */
export async function ensureVslVideoOrigins(sql: Sql, assetId: string, hostnames: string[], env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch, options: VslStreamOriginOptions = {}): Promise<void> {
  const accountId = env['VSL_STREAM_ACCOUNT_ID'];
  const token = env['VSL_STREAM_API_TOKEN'];
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !token) throw new VslError('Stream origin configuration unavailable', 503, 'stream_not_configured');
  const origins = [...new Set(hostnames.map(normalizeVslHostname))];
  const previous = inflight.get(assetId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => syncVideoOrigins(sql, assetId, origins, accountId, token, fetcher, { ...DEFAULTS, ...options }));
  inflight.set(assetId, run);
  try {
    await run;
  } finally {
    if (inflight.get(assetId) === run) inflight.delete(assetId);
  }
}

async function syncVideoOrigins(sql: Sql, assetId: string, origins: string[], accountId: string, token: string,
  fetcher: typeof fetch, options: Required<VslStreamOriginOptions>): Promise<void> {
  const deadline = Date.now() + options.budgetMs;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const call = async (endpoint: string, init: RequestInit, uid: string): Promise<RemoteVideo> => {
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new VslError('Stream origin update timed out', 502, 'stream_unavailable');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, remaining));
      let response: Response;
      let body: CloudflareResponse | null = null;
      try {
        response = await fetcher(endpoint, { ...init, headers, redirect: 'error', signal: controller.signal });
        body = await response.json().catch(() => null) as CloudflareResponse | null;
      } catch {
        clearTimeout(timer);
        if (attempt < options.attempts) { await sleep(options.retryDelayMs); continue; }
        throw new VslError('Stream origin request failed', 502, 'stream_unavailable');
      }
      clearTimeout(timer);
      if ((response.status === 429 || response.status >= 500) && attempt < options.attempts) { await sleep(options.retryDelayMs); continue; }
      if (!response.ok || !body?.success || !body.result || body.result.uid !== uid || body.result.requireSignedURLs)
        throw new VslError('Stream video origin lookup failed', 502, 'stream_unavailable');
      return body.result;
    }
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const asset = await loadReadyAsset(sql, assetId);
    const uid = asset.provider_asset_id;
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`;
    const current = await call(endpoint, { method: 'GET' }, uid);
    const allowed = current.allowedOrigins ?? [];
    // Vídeo sem allowedOrigins = qualquer site pode embutir: o publish nunca "abre" e nem adota um vídeo assim.
    if (!allowed.length) throw new VslError(VSL_ERRORS.video_origins_unrestricted.message, 409, 'video_origins_unrestricted');
    if (origins.every((host) => allowed.includes(host))) return;
    const next = [...new Set([...allowed, ...origins])];
    const updated = await call(endpoint, { method: 'POST', body: JSON.stringify({ allowedOrigins: next }) }, uid);
    if (!origins.every((host) => updated.allowedOrigins?.includes(host)))
      throw new VslError('Stream video origin update failed', 502, 'stream_unavailable');
    // Checagem otimista: o vídeo não pode ter mudado (status/uid) enquanto falávamos com o Stream.
    const after = await loadReadyAsset(sql, assetId);
    if (after.provider_asset_id !== uid) throw new VslError('Video changed during origin update', 409, 'video_not_ready');
    // Conferência: outra instância pode ter gravado uma lista antiga por cima da nossa.
    const confirmed = await call(endpoint, { method: 'GET' }, uid);
    if (origins.every((host) => confirmed.allowedOrigins?.includes(host))) return;
  }
  throw new VslError('Stream origins changed concurrently', 502, 'stream_unavailable');
}

/** Origin permitido pela política: igual a uma entrada ou subdomínio de uma entrada `*.dominio`. */
export function streamOriginAllowed(origin: string, policy: readonly string[]): boolean {
  const value = origin.trim().toLowerCase();
  if (!value || value === '*') return false;
  return policy.some((entry) => entry === value || (entry.startsWith('*.') && value.endsWith(entry.slice(1)) && value.length > entry.length - 1));
}

/** Vídeo restrito (lista não vazia) e cada origin dentro da política. */
export function streamOriginsAllowed(origins: readonly string[], policy: readonly string[]): boolean {
  return origins.length > 0 && origins.every((origin) => streamOriginAllowed(origin, policy));
}

/**
 * Política única de allowedOrigins do Stream (G3) = VSL_STREAM_ALLOWED_ORIGINS
 * ∪ VSL_PREVIEW_DOMAIN ∪ hostnames que já receberam publish/rollback (o publish
 * adiciona o hostname ao vídeo e nunca remove).
 */
export async function vslStreamOriginPolicy(sql: Sql, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = (env['VSL_STREAM_ALLOWED_ORIGINS'] ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const preview = (env['VSL_PREVIEW_DOMAIN'] ?? '').trim().toLowerCase();
  const rows = await sql<{ hostname: string }[]>`SELECT DISTINCT d.hostname FROM blackshop_domains d
    WHERE EXISTS (SELECT 1 FROM vsl_project_releases r WHERE r.domain_id=d.id)`;
  return [...new Set([...configured, ...(preview ? [preview] : []), ...rows.map((row) => row.hostname)])];
}
