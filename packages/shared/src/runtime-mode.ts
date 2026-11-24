// Story 0.4 · resolução central do modo das integrações externas (Shopify real × mock,
// Meta CAPI real × mock).
//
// Regra: em produção o mock NUNCA é implícito. Variável ausente ou com valor inválido
// lança `IntegrationModeError` com código estável; quem chama decide como falhar alto
// (503 no checkout, job sem retry no worker, evento `failed` na CAPI). Mock declarado
// (`SHOPIFY_MODE=mock`) continua permitido — é decisão consciente de um ambiente de
// homologação — mas aparece como `productionMock` no health e no log de boot.
//
// Em desenvolvimento/teste a ausência continua resolvendo para `mock` (`dev-default`),
// para que `pnpm dev` e os testes funcionem sem configurar nada.
//
// Módulo puro, sem import do banco: use pelo subcaminho `@blackshop/shared/runtime-mode`.

export type IntegrationName = 'shopify' | 'metaCapi';
export type IntegrationMode = 'real' | 'mock';
/**
 * - `explicit`: a variável da integração foi declarada com um valor válido.
 * - `dev-default`: variável ausente fora de produção → `mock`.
 * - `legacy-fallback`: só para `metaCapi` — `META_CAPI_MODE` ausente e `SHOPIFY_MODE=real`
 *   (compatibilidade temporária; removida na story 18.8).
 */
export type IntegrationModeSource = 'explicit' | 'dev-default' | 'legacy-fallback';
export type IntegrationModeErrorCode = 'INTEGRATION_MODE_UNSET' | 'INTEGRATION_MODE_INVALID';

export type RuntimeEnv = Record<string, string | undefined>;

export const INTEGRATION_MODE_VARIABLES: Readonly<Record<IntegrationName, string>> = {
  shopify: 'SHOPIFY_MODE',
  metaCapi: 'META_CAPI_MODE',
};

/** Aviso de log quando a CAPI usa o `SHOPIFY_MODE` por compatibilidade. */
export const META_CAPI_MODE_LEGACY_FALLBACK = 'META_CAPI_MODE_LEGACY_FALLBACK';

export interface ResolvedIntegrationMode {
  integration: IntegrationName;
  variable: string;
  mode: IntegrationMode;
  source: IntegrationModeSource;
  productionLike: boolean;
}

export class IntegrationModeError extends Error {
  readonly code: IntegrationModeErrorCode;
  readonly integration: IntegrationName;
  readonly variable: string;

  constructor(code: IntegrationModeErrorCode, integration: IntegrationName, variable: string) {
    const what =
      code === 'INTEGRATION_MODE_UNSET'
        ? `a variável de ambiente ${variable} não está definida`
        : `a variável de ambiente ${variable} tem um valor inválido`;
    super(
      `Modo da integração "${integration}" não configurado em produção: ${what}. ` +
        `Defina ${variable}=real (ou ${variable}=mock, só em homologação). ` +
        `Valores aceitos: "real" ou "mock" (minúsculas).`,
    );
    this.name = 'IntegrationModeError';
    this.code = code;
    this.integration = integration;
    this.variable = variable;
  }
}

export function isIntegrationModeError(err: unknown): err is IntegrationModeError {
  return err instanceof IntegrationModeError;
}

/**
 * "Produção" = `NODE_ENV=production` OU variável de plataforma de produção presente. A
 * segunda pista existe porque as configs usam `development` como default quando
 * `NODE_ENV` falta — a guarda não pode ficar cega nesse caso.
 *  - Railway: `RAILWAY_ENVIRONMENT_NAME` (nome do ambiente; `production` por padrão).
 *  - Vercel: `VERCEL_ENV=production`.
 */
export function isProductionLike(env: RuntimeEnv = process.env): boolean {
  if (env['NODE_ENV'] === 'production') return true;
  if (env['RAILWAY_ENVIRONMENT_NAME'] === 'production') return true;
  if (env['VERCEL_ENV'] === 'production') return true;
  return false;
}

type RawRead =
  | { kind: 'unset' }
  | { kind: 'invalid' }
  | { kind: 'valid'; mode: IntegrationMode };

function readRaw(env: RuntimeEnv, variable: string): RawRead {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') return { kind: 'unset' };
  // Valor exato, sem normalizar caixa: `Real`/`REAL`/`live` são erros de digitação que
  // não podem cair silenciosamente em mock (nem virar real sem querer).
  if (raw === 'real' || raw === 'mock') return { kind: 'valid', mode: raw };
  return { kind: 'invalid' };
}

/**
 * Resolve o modo de uma integração. Lança `IntegrationModeError` quando:
 *  - o valor é inválido (em qualquer ambiente — erro de digitação nunca é silencioso);
 *  - a variável está ausente/vazia em produção (sem mock implícito).
 */
export function resolveIntegrationMode(
  integration: IntegrationName,
  env: RuntimeEnv = process.env,
): ResolvedIntegrationMode {
  const variable = INTEGRATION_MODE_VARIABLES[integration];
  const productionLike = isProductionLike(env);
  const read = readRaw(env, variable);

  if (read.kind === 'valid') {
    return { integration, variable, mode: read.mode, source: 'explicit', productionLike };
  }
  if (read.kind === 'invalid') {
    throw new IntegrationModeError('INTEGRATION_MODE_INVALID', integration, variable);
  }

  // Ausente. CAPI: compatibilidade temporária com o acoplamento antigo ao SHOPIFY_MODE.
  if (integration === 'metaCapi') {
    const shopify = readRaw(env, INTEGRATION_MODE_VARIABLES.shopify);
    if (shopify.kind === 'valid' && shopify.mode === 'real') {
      return { integration, variable, mode: 'real', source: 'legacy-fallback', productionLike };
    }
  }

  if (productionLike) {
    throw new IntegrationModeError('INTEGRATION_MODE_UNSET', integration, variable);
  }
  return { integration, variable, mode: 'mock', source: 'dev-default', productionLike };
}

/** Estado de uma integração para health/log — nunca lança. */
export type IntegrationModeStatus =
  | { mode: IntegrationMode; source: IntegrationModeSource }
  | { mode: 'error'; source: 'error'; code: IntegrationModeErrorCode; variable: string };

export interface IntegrationModesSnapshot {
  productionLike: boolean;
  shopify: IntegrationModeStatus;
  metaCapi: IntegrationModeStatus;
  /** Produção com alguma integração em mock (declarado). */
  productionMock: boolean;
  /** Produção com alguma integração sem modo válido. */
  productionModeError: boolean;
}

function statusOf(integration: IntegrationName, env: RuntimeEnv): IntegrationModeStatus {
  try {
    const r = resolveIntegrationMode(integration, env);
    return { mode: r.mode, source: r.source };
  } catch (err) {
    if (err instanceof IntegrationModeError) {
      return { mode: 'error', source: 'error', code: err.code, variable: err.variable };
    }
    throw err;
  }
}

export function describeIntegrationModes(env: RuntimeEnv = process.env): IntegrationModesSnapshot {
  const productionLike = isProductionLike(env);
  const shopify = statusOf('shopify', env);
  const metaCapi = statusOf('metaCapi', env);
  const all = [shopify, metaCapi];
  return {
    productionLike,
    shopify,
    metaCapi,
    productionMock: productionLike && all.some((s) => s.mode === 'mock'),
    productionModeError: productionLike && all.some((s) => s.mode === 'error'),
  };
}

export interface ModeAlertLine {
  level: 'error' | 'warn' | 'info';
  event: 'MOCK_MODE_IN_PRODUCTION' | 'INTEGRATION_MODE_ERROR' | typeof META_CAPI_MODE_LEGACY_FALLBACK | 'INTEGRATION_MODE';
  subsystem: IntegrationName;
  service: string;
  mode: IntegrationModeStatus['mode'];
  source: IntegrationModeStatus['source'];
  code?: IntegrationModeErrorCode;
  variable?: string;
  message: string;
}

/**
 * Linhas de log de boot (AC9): uma por subsistema. Em produção, mock ou erro de modo saem
 * em nível `error` (`event: 'MOCK_MODE_IN_PRODUCTION'`, pesquisável no Railway); em
 * desenvolvimento, `info`. Nenhum valor de segredo entra aqui — só nomes de variáveis.
 */
export function buildModeAlertLines(service: string, env: RuntimeEnv = process.env): ModeAlertLine[] {
  const snap = describeIntegrationModes(env);
  const lines: ModeAlertLine[] = [];
  for (const subsystem of ['shopify', 'metaCapi'] as const) {
    const s = snap[subsystem];
    const variable = INTEGRATION_MODE_VARIABLES[subsystem];
    if (s.mode === 'error') {
      lines.push({
        level: snap.productionLike ? 'error' : 'info',
        event: snap.productionLike ? 'MOCK_MODE_IN_PRODUCTION' : 'INTEGRATION_MODE_ERROR',
        subsystem,
        service,
        mode: s.mode,
        source: s.source,
        code: s.code,
        variable: s.variable,
        message: `${service}: ${variable} ausente ou inválida — fluxos de ${subsystem} vão falhar com ${s.code} até ser corrigido.`,
      });
      continue;
    }
    if (s.mode === 'mock') {
      lines.push({
        level: snap.productionLike ? 'error' : 'info',
        event: snap.productionLike ? 'MOCK_MODE_IN_PRODUCTION' : 'INTEGRATION_MODE',
        subsystem,
        service,
        mode: s.mode,
        source: s.source,
        variable,
        message: snap.productionLike
          ? `${service}: ${subsystem} em modo MOCK em produção (${variable}=mock declarado) — nada chega de fato à plataforma externa.`
          : `${service}: ${subsystem} em modo mock (${s.source}).`,
      });
      continue;
    }
    if (s.source === 'legacy-fallback') {
      lines.push({
        level: 'warn',
        event: META_CAPI_MODE_LEGACY_FALLBACK,
        subsystem,
        service,
        mode: s.mode,
        source: s.source,
        variable,
        message: `${service}: META_CAPI_MODE ausente — usando SHOPIFY_MODE=real por compatibilidade. Defina META_CAPI_MODE=real.`,
      });
      continue;
    }
    lines.push({
      level: 'info',
      event: 'INTEGRATION_MODE',
      subsystem,
      service,
      mode: s.mode,
      source: s.source,
      variable,
      message: `${service}: ${subsystem} em modo ${s.mode}.`,
    });
  }
  return lines;
}
