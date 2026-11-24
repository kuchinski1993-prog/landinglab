// Story 17.6c · Config do Atendimento por loja na API (inbox, reembolsos, /admin/store/atendimento).
//
// Lê `stores.settings` + `stores.domain` e resolve a config efetiva (packages/shared). Fail-safe:
// leitura falhou → `default` usa os literais de hoje; outra loja fica "não configurada" (as rotas
// não enviam nada ao cliente). Nunca joga. Logs sem PII.
import { stores } from '@blackshop/db';
import { sendError } from '@blackshop/errors/fastify';
import { resolveAtendimentoConfig, type EffectiveAtendimento } from '@blackshop/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import { LOJA_ERRORS } from './loja-errors.js';

export const ATENDIMENTO_CONFIG_LINK = '/trustshield/config/atendimento';

export async function loadAtendimentoForStore(
  db: FastifyInstance['db'],
  storeId: string,
  log?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<EffectiveAtendimento> {
  let settings: unknown = null;
  let domain: string | null = null;
  try {
    const rows = (await db
      .select({ settings: stores.settings, domain: stores.domain })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1)) as Array<{ settings: unknown; domain: string | null }>;
    settings = rows[0]?.settings ?? null;
    domain = rows[0]?.domain ?? null;
  } catch (err) {
    log?.warn(
      { storeId, err: err instanceof Error ? err.message : String(err) },
      'atendimento: store settings read failed — fail-safe (default = literals; other stores = not configured)',
    );
  }
  const effective = resolveAtendimentoConfig(storeId, settings, { storeDomain: domain });
  if (effective.invalid) log?.warn({ storeId }, 'atendimento: stores.settings.atendimento invalid — treated as absent');
  return effective;
}

/** 409 `loja.atendimento_not_configured` com os campos faltantes e o link da tela de config. */
export function sendAtendimentoNotConfigured(reply: FastifyReply, effective: EffectiveAtendimento): FastifyReply {
  return sendError(reply, LOJA_ERRORS, 'loja.atendimento_not_configured', {
    storeId: effective.storeId,
    missing: effective.missing,
    invalid: effective.invalid,
    configLink: ATENDIMENTO_CONFIG_LINK,
  });
}
