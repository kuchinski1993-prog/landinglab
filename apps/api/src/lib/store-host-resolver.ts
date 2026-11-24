// Story 23.1a · "Que loja é este host?" — loja da vitrine pelo DOMÍNIO (ADR-004).
//
// • Só lojas ≠ `default` são encontradas: a `default` (AuthenLondon) tem `domain = NULL` e "host
//   desconhecido" É ela (Decisão 3). Nada é gravado na `default`.
// • Normalização (Decisão 4): minúsculas, sem porta, sem ponto final; `www.<d>` e `<d>` são a mesma
//   loja; outro subdomínio NÃO casa. Critério de host válido = `normalizeStoreDomain` (17.3b/21.4).
//   Host vazio, inválido, IP, `localhost` ou > 253 → `unknown` SEM consultar o banco.
// • Domínio repetido em duas lojas ativas → `ambiguous` (nunca `default`) — `stores.domain` não tem
//   índice único (Decisão 7).
// • Loja encontrada mas DESATIVADA → `inactive` (a vitrine responde /loja-indisponivel 503 — AC 14;
//   nunca cai no catálogo da `default`). Desvio registrado no Dev Agent Record (AC 3/7 diziam
//   `unknown`; `unknown` levaria o domínio da loja desativada ao catálogo da AuthenLondon).
// • Cache em memória: positivo 30 s, negativo 10 s, no máximo 500 hosts (TTL 0 em NODE_ENV=test).
// • Banco falhou → `StoreHostLookupError` (a rota responde 503): falha NUNCA vira `default`.
// Flag: `STORE_HOST_RESOLUTION=on` (Decisão 6). Desligada = rota 404 e CORS estático de hoje.
import { stores } from '@blackshop/db';
import { and, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { DEFAULT_STORE_ID } from '../plugins/store.plugin.js';

import { normalizeStoreDomain } from './store-domain.js';

export const HOST_MAX_LENGTH = 253;
export const STORE_HOST_HIT_TTL_MS = 30_000;
export const STORE_HOST_MISS_TTL_MS = 10_000;
export const STORE_HOST_CACHE_MAX = 500;

export type StoreHostResolution =
  | { kind: 'store'; storeId: string; name: string; domain: string; settings: unknown }
  | { kind: 'inactive'; storeId: string }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' };

/** Falha de banco ao resolver o host — a rota responde 503 (nunca `default`). */
export class StoreHostLookupError extends Error {
  readonly statusCode = 503;
  constructor(cause: unknown) {
    super('store host lookup failed', { cause });
    this.name = 'StoreHostLookupError';
  }
}

/** A resolução de loja por domínio está ligada (`STORE_HOST_RESOLUTION=on`)? */
export function isStoreHostResolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['STORE_HOST_RESOLUTION'] ?? '').trim().toLowerCase() === 'on';
}

/**
 * Host normalizado (minúsculas, sem porta, sem ponto final) ou `null` quando não é um domínio
 * público válido (vazio, IP, `localhost`, > 253, caracteres inválidos). Sem `www.` removido.
 */
export function normalizeRequestHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > HOST_MAX_LENGTH + 7) return null;
  if (host.startsWith('[')) return null; // IPv6 literal
  const colon = host.indexOf(':');
  if (colon !== -1) {
    if (host.indexOf(':', colon + 1) !== -1) return null; // IPv6 sem colchetes
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > HOST_MAX_LENGTH) return null;
  const normalized = normalizeStoreDomain(host);
  return normalized.ok && normalized.domain ? normalized.domain : null;
}

/** As duas formas que casam com o host: ele mesmo e a variante com/sem `www.`. */
export function hostCandidates(host: string): string[] {
  if (host.startsWith('www.')) {
    const apex = host.slice(4);
    return normalizeStoreDomain(apex).ok && apex.includes('.') ? [host, apex] : [host];
  }
  return [host, `www.${host}`];
}

interface StoreDomainRow {
  id: string;
  name: string;
  domain: string | null;
  isActive: boolean;
  settings: unknown;
}

/** Decide a partir das linhas que casaram (pura — testável sem banco). */
export function decideStoreHost(rows: readonly StoreDomainRow[]): StoreHostResolution {
  const active = rows.filter((r) => r.isActive);
  const activeIds = new Set(active.map((r) => r.id));
  if (activeIds.size > 1) return { kind: 'ambiguous' };
  const store = active[0];
  if (store) {
    return { kind: 'store', storeId: store.id, name: store.name, domain: store.domain ?? '', settings: store.settings };
  }
  const inactive = rows[0];
  return inactive ? { kind: 'inactive', storeId: inactive.id } : { kind: 'unknown' };
}

export interface StoreHostResolver {
  resolve(db: FastifyInstance['db'], rawHost: unknown): Promise<StoreHostResolution>;
  invalidate(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Story 23.1a · loja pelo domínio (rota pública `store-by-host` e CORS por loja). */
    storeHostResolver: StoreHostResolver;
  }
}

export interface StoreHostResolverOptions {
  hitTtlMs?: number;
  missTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export function createStoreHostResolver(options: StoreHostResolverOptions = {}): StoreHostResolver {
  const isTest = process.env['NODE_ENV'] === 'test';
  const hitTtl = options.hitTtlMs ?? (isTest ? 0 : STORE_HOST_HIT_TTL_MS);
  const missTtl = options.missTtlMs ?? (isTest ? 0 : STORE_HOST_MISS_TTL_MS);
  const maxEntries = options.maxEntries ?? STORE_HOST_CACHE_MAX;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: StoreHostResolution; expiresAt: number }>();

  function remember(host: string, value: StoreHostResolution): void {
    const ttl = value.kind === 'store' ? hitTtl : missTtl;
    if (ttl <= 0) return;
    if (cache.size >= maxEntries && !cache.has(host)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(host, { value, expiresAt: now() + ttl });
  }

  return {
    async resolve(db, rawHost) {
      const host = normalizeRequestHost(rawHost);
      if (!host) return { kind: 'unknown' };
      const cached = cache.get(host);
      if (cached && cached.expiresAt > now()) return cached.value;

      const candidates = hostCandidates(host);
      let rows: StoreDomainRow[];
      try {
        rows = (await db
          .select({
            id: stores.id,
            name: stores.name,
            domain: stores.domain,
            isActive: stores.isActive,
            settings: stores.settings,
          })
          .from(stores)
          .where(
            and(
              ne(stores.id, DEFAULT_STORE_ID),
              sql`lower(${stores.domain}) in (${sql.join(
                candidates.map((c) => sql`${c}`),
                sql`, `,
              )})`,
            ),
          )
          .limit(10)) as StoreDomainRow[];
      } catch (err) {
        throw new StoreHostLookupError(err);
      }
      const value = decideStoreHost(rows);
      remember(host, value);
      return value;
    },
    invalidate() {
      cache.clear();
    },
  };
}
