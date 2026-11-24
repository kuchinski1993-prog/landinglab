// Segredo dos webhooks Shopify (Story 0.2/0.3 — ex-0.3).
//
// Falha FECHADA: nunca existe segredo padrão. Antes havia um fallback fixo que
// era usado em teste, com o Vault vazio e em QUALQUER erro de leitura — quem
// conhecesse a string calculava um HMAC válido e forjava pedidos, envios e
// disputas. Agora:
//
//   - NODE_ENV=test        → só a variável explícita SHOPIFY_WEBHOOK_SECRET_TEST
//                            (injetada pelo harness de teste). Sem ela = ausente.
//   - NODE_ENV=development → variável explícita SHOPIFY_WEBHOOK_SECRET, se
//                            definida; senão o Vault.
//   - demais (produção)    → só o Vault (`shopify:webhook:secret`).
//
// Vault sem a chave → SHOPIFY_WEBHOOK_SECRET_MISSING.
// Erro ao ler o Vault (banco fora, VAULT_SECRET errado) → SHOPIFY_WEBHOOK_SECRET_UNAVAILABLE.
// As rotas respondem 503 nos dois casos (a Shopify reenvia depois).
import { VaultService } from '@blackshop/vault';
import type { FastifyInstance, FastifyReply } from 'fastify';

export const SHOPIFY_WEBHOOK_VAULT_KEY = 'shopify:webhook:secret';

export type ShopifyWebhookSecretErrorCode =
  | 'SHOPIFY_WEBHOOK_SECRET_MISSING'
  | 'SHOPIFY_WEBHOOK_SECRET_UNAVAILABLE';

export type ShopifyWebhookSecretResult =
  | { ok: true; secret: string }
  | { ok: false; code: ShopifyWebhookSecretErrorCode };

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function resolveShopifyWebhookSecret(
  fastify: FastifyInstance,
): Promise<ShopifyWebhookSecretResult> {
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'test') {
    const testSecret = nonEmpty(process.env['SHOPIFY_WEBHOOK_SECRET_TEST']);
    return testSecret
      ? { ok: true, secret: testSecret }
      : { ok: false, code: 'SHOPIFY_WEBHOOK_SECRET_MISSING' };
  }
  if (nodeEnv === 'development') {
    const devSecret = nonEmpty(process.env['SHOPIFY_WEBHOOK_SECRET']);
    if (devSecret) return { ok: true, secret: devSecret };
  }
  try {
    const vault = new VaultService(fastify.db, fastify.config.vaultSecret);
    const secret = nonEmpty(await vault.getRaw(SHOPIFY_WEBHOOK_VAULT_KEY));
    return secret
      ? { ok: true, secret }
      : { ok: false, code: 'SHOPIFY_WEBHOOK_SECRET_MISSING' };
  } catch (err) {
    // Nunca logamos o valor — só o tipo do erro.
    fastify.log.error(
      { errName: err instanceof Error ? err.name : typeof err, errMessage: err instanceof Error ? err.message : String(err) },
      'webhook Shopify: falha ao ler o segredo no Vault',
    );
    return { ok: false, code: 'SHOPIFY_WEBHOOK_SECRET_UNAVAILABLE' };
  }
}

const SECRET_ERROR_BODY: Record<ShopifyWebhookSecretErrorCode, { message: string; details: string }> = {
  SHOPIFY_WEBHOOK_SECRET_MISSING: {
    message:
      'O segredo do webhook da Shopify não está configurado. Nenhum webhook será aceito até ele ser cadastrado.',
    details:
      'Cadastre o segredo no Vault com: pnpm --filter @blackshop/api exec tsx src/scripts/vault-set.ts shopify:webhook:secret (o valor é o client_secret do app Shopify).',
  },
  SHOPIFY_WEBHOOK_SECRET_UNAVAILABLE: {
    message:
      'Não foi possível ler o segredo do webhook da Shopify agora (Vault/banco indisponível). A Shopify vai reenviar.',
    details:
      'Verifique a conexão com o banco e se VAULT_SECRET da API é o mesmo usado para gravar shopify:webhook:secret.',
  },
};

/**
 * Responde 503 quando o segredo está ausente/indisponível. Nada do corpo é
 * lido nem gravado antes disso. Loga em nível error (sem valor do segredo).
 */
export function replySecretUnavailable(
  fastify: FastifyInstance,
  reply: FastifyReply,
  code: ShopifyWebhookSecretErrorCode,
  topic: string,
): FastifyReply {
  fastify.log.error(
    { code, topic },
    code === 'SHOPIFY_WEBHOOK_SECRET_MISSING'
      ? 'webhook Shopify recusado: segredo shopify:webhook:secret ausente no Vault'
      : 'webhook Shopify recusado: segredo indisponível (erro ao ler o Vault)',
  );
  return reply.code(503).send({ code, ...SECRET_ERROR_BODY[code] });
}

// ── Health ────────────────────────────────────────────────────────────────
// O /health só precisa saber SE o segredo existe. A leitura do Vault decifra o
// valor (custo de CPU), então guardamos o booleano por 60s. Nunca guardamos nem
// devolvemos o valor, tamanho ou prefixo.
const HEALTH_CACHE_MS = 60_000;
let healthCache: { at: number; configured: boolean } | null = null;

export async function isShopifyWebhookSecretConfigured(fastify: FastifyInstance): Promise<boolean> {
  const cacheable = process.env['NODE_ENV'] !== 'test';
  if (cacheable && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.configured;
  }
  const result = await resolveShopifyWebhookSecret(fastify);
  if (cacheable) healthCache = { at: Date.now(), configured: result.ok };
  return result.ok;
}
