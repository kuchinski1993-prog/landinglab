// Story 17.2a · Resolução da loja do `X-Store-Id` (existe? está ativa?) com cache em memória.
//
// • Acerto (loja encontrada, ativa ou não) vale 15 s; "não existe" vale 5 s — uma loja recém-criada
//   passa a valer em segundos. Em teste (NODE_ENV=test) o TTL é 0 (cada requisição consulta).
// • `POST /stores` e `PATCH /stores/:id` invalidam a entrada da loja no processo que recebeu a
//   chamada; nos demais processos vale o TTL (≤ 15 s).
// • Falha do banco PROPAGA (o plugin responde 503) — nunca vira "loja padrão".
// Não reaproveita lib/store-allowlist.ts: aquele cache é da zona do portal/reembolsos.
import { stores } from '@blackshop/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export type StoreStatus = 'active' | 'inactive' | 'missing';

export interface StoreResolver {
  /** Situação da loja. Lança se o banco falhar. */
  resolve(db: FastifyInstance['db'], storeId: string): Promise<StoreStatus>;
  /** Esquece a loja (ou tudo, sem argumento). */
  invalidate(storeId?: string): void;
}

export interface StoreResolverOptions {
  hitTtlMs?: number;
  missTtlMs?: number;
  now?: () => number;
}

export const STORE_HIT_TTL_MS = 15_000;
export const STORE_MISS_TTL_MS = 5_000;

export function createStoreResolver(options: StoreResolverOptions = {}): StoreResolver {
  const isTest = process.env['NODE_ENV'] === 'test';
  const hitTtl = options.hitTtlMs ?? (isTest ? 0 : STORE_HIT_TTL_MS);
  const missTtl = options.missTtlMs ?? (isTest ? 0 : STORE_MISS_TTL_MS);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { status: StoreStatus; expiresAt: number }>();

  return {
    async resolve(db, storeId) {
      const cached = cache.get(storeId);
      if (cached && cached.expiresAt > now()) return cached.status;
      const rows = await db
        .select({ isActive: stores.isActive })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const row = rows[0];
      const status: StoreStatus = !row ? 'missing' : row.isActive ? 'active' : 'inactive';
      const ttl = status === 'missing' ? missTtl : hitTtl;
      if (ttl > 0) cache.set(storeId, { status, expiresAt: now() + ttl });
      else cache.delete(storeId);
      return status;
    },
    invalidate(storeId) {
      if (storeId === undefined) cache.clear();
      else cache.delete(storeId);
    },
  };
}

/** Resolver permissivo (só para testes): todo id de formato válido é uma loja ativa. */
export const permissiveStoreResolver: StoreResolver = {
  resolve: async () => 'active',
  invalidate: () => undefined,
};

export const STORE_ID_MAX_LENGTH = 64;

/**
 * Formato aceito no cabeçalho: 1–64 caracteres, sem espaço, vírgula ou caractere de controle
 * (cabeçalho repetido chega juntado por vírgula pelo Node).
 */
export function isValidStoreIdFormat(value: string): boolean {
  if (value.length === 0 || value.length > STORE_ID_MAX_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\s,\u0000-\u001f\u007f]/.test(value);
}
