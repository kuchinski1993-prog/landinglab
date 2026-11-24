// Story 23.1a · Decisão 5 (ADR-004) — CORS dinâmico por loja, só para as rotas PÚBLICAS da vitrine.
// Uma origem `https://<host>` cujo host é o domínio de uma loja ativa ≠ `default` (mesmo critério de
// `GET /storefront/store-by-host`, mesmo cache de 30 s) passa a ser aceita nestas rotas; as rotas
// autenticadas do painel (`/auth`, `/products`, `/admin/*`, ...) continuam SÓ com a lista estática
// (sessão com cookie e `credentials: true` não pode valer para um domínio de loja). Só com
// `STORE_HOST_RESOLUTION=on` — desligada, o server.ts registra o CORS estático de hoje.
import { isProtectedPath } from '@blackshop/observability';
import type { FastifyInstance } from 'fastify';

/** Prefixos (por segmento) das rotas públicas da vitrine que aceitam a origem de uma loja. */
export const STOREFRONT_PUBLIC_CORS_PREFIXES: readonly string[] = [
  '/api/storefront',
  '/store/settings',
  '/themes/active',
  '/cart/validate',
  '/checkout',
  '/tracking',
  '/api/leads',
  '/api/contact',
];

/**
 * Rotas AUTENTICADAS do painel que moram sob um prefixo público (gate QA 23.1a): `PUT /themes/active`
 * e `POST /themes/active/versions` (preHandler `authenticate`). Sob `/themes/active` só a leitura
 * pública (GET/HEAD) aceita a origem de uma loja.
 */
const READ_ONLY_PUBLIC_PATH = '/themes/active';

function pathOnly(url: string): string {
  const q = url.search(/[?#]/);
  return q === -1 ? url : url.slice(0, q);
}

/**
 * A rota é pública da vitrine (aceita a origem de uma loja cadastrada)? `method` = método real ou,
 * no preflight, o de `Access-Control-Request-Method`.
 */
export function isStorefrontPublicCorsPath(url: string | undefined, method = 'GET'): boolean {
  if (!isProtectedPath(url, STOREFRONT_PUBLIC_CORS_PREFIXES)) return false;
  const path = pathOnly(url ?? '');
  if (path === READ_ONLY_PUBLIC_PATH || path.startsWith(`${READ_ONLY_PUBLIC_PATH}/`)) {
    const m = method.trim().toUpperCase();
    return path === READ_ONLY_PUBLIC_PATH && (m === 'GET' || m === 'HEAD');
  }
  return true;
}

/** Método efetivo da requisição para o CORS (no preflight, o pedido em Access-Control-Request-Method). */
export function corsEffectiveMethod(method: string, requestedMethod: unknown): string {
  if (method.toUpperCase() !== 'OPTIONS') return method;
  return typeof requestedMethod === 'string' && requestedMethod.trim() !== '' ? requestedMethod : 'GET';
}

/** A origem é `https://<domínio de uma loja ativa>`? Lança se o banco falhar (o chamador nega). */
export async function storeOriginAllowed(app: FastifyInstance, origin: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const resolution = await app.storeHostResolver.resolve(app.db, url.host);
  return resolution.kind === 'store';
}
