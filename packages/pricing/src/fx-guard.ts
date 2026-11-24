// Story 0.7 · guarda de câmbio (funções puras).
//
// Usado por:
//   - worker `refresh-fx-rates.processor` (taxa do provedor)
//   - api `POST/PATCH /price-rules` (taxa manual) e aprovação de pendência
//   - `PricingEngine.apply` (última barreira: taxa inválida nunca vira preço)
//
// Regras (Decisões 3 e 4 da story 0.7):
//   - Taxa válida = número finito, > 0, cabe em numeric(10,6) e, quando há
//     taxa de referência, não difere dela por mais de FX_SANITY_FACTOR vezes.
//   - Variação comparada com a ÚLTIMA taxa aplicada; acima do limite
//     (`>` e não `>=`) fica aguardando aprovação.
//   - Semente: regra sem histórico aplicado e com taxa vigente exatamente 1
//     (placeholder do seed) recebe a primeira taxa válida como `bootstrap`.
import { Decimal } from 'decimal.js';

/** Menor taxa que cabe em `price_rules.exchange_rate numeric(10,6)`. */
export const FX_RATE_MIN = '0.000001';
/** Maior taxa que cabe em `numeric(10,6)`. */
export const FX_RATE_MAX = '9999.999999';
/** Faixa de sanidade relativa à referência (1/1000 a 1000 vezes). */
export const FX_SANITY_FACTOR = 1000;
/** D-0.1 · limite padrão de variação que exige aprovação (configurável por loja). */
export const FX_DEFAULT_MAX_VARIATION_PERCENT = 5;
/** Placeholder gravado por `seedFxRules` antes do primeiro refresh real. */
export const FX_SEED_PLACEHOLDER_RATE = '1';

export type FxRateInvalidReason =
  | 'not_a_number'
  | 'not_positive'
  | 'out_of_range'
  | 'out_of_sanity_range';

export type ValidateRateResult =
  | { ok: true; rate: Decimal; normalized: string }
  | { ok: false; code: 'FX_RATE_INVALID'; reason: FxRateInvalidReason; message: string };

export interface ValidateRateOptions {
  /** Taxa de referência (vigente ou linha de base). Sem referência, só a faixa absoluta vale. */
  reference?: string | number | null;
  sanityFactor?: number;
}

const NUMERIC_STRING_RE = /^\s*\+?(\d+(\.\d*)?|\.\d+)\s*$/;

const MESSAGES: Record<FxRateInvalidReason, string> = {
  not_a_number: 'A taxa de câmbio precisa ser um número.',
  not_positive: 'A taxa de câmbio precisa ser maior que zero.',
  out_of_range: 'A taxa de câmbio está fora da faixa permitida (0,000001 a 9999,999999).',
  out_of_sanity_range:
    'A taxa de câmbio é mais de 1000 vezes diferente da taxa atual. Confira o valor.',
};

function invalid(reason: FxRateInvalidReason): ValidateRateResult {
  return { ok: false, code: 'FX_RATE_INVALID', reason, message: MESSAGES[reason] };
}

/** Converte número/string em Decimal finito; `null` se não for número. */
function toDecimal(value: unknown): Decimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Decimal(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Aceita negativos só para devolver `not_positive` (mensagem mais útil).
    const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
    if (!NUMERIC_STRING_RE.test(unsigned)) return null;
    return new Decimal(trimmed);
  }
  return null;
}

/** Valida uma taxa de câmbio (provedor, manual ou a que vai para o cálculo do preço). */
export function validateRate(value: unknown, opts: ValidateRateOptions = {}): ValidateRateResult {
  const rate = toDecimal(value);
  if (!rate) return invalid('not_a_number');
  if (rate.lte(0)) return invalid('not_positive');
  if (rate.lt(FX_RATE_MIN) || rate.gt(FX_RATE_MAX)) return invalid('out_of_range');

  const factor = opts.sanityFactor ?? FX_SANITY_FACTOR;
  const ref = opts.reference == null ? null : toDecimal(opts.reference);
  if (ref && ref.gt(0)) {
    const ratio = rate.div(ref);
    if (ratio.gt(factor) || ratio.lt(new Decimal(1).div(factor))) {
      return invalid('out_of_sanity_range');
    }
  }
  const normalized = rate.toDecimalPlaces(6).toString();
  // Arredondado para 6 casas não pode virar 0 (já coberto por FX_RATE_MIN, defesa extra).
  if (new Decimal(normalized).lte(0)) return invalid('out_of_range');
  return { ok: true, rate, normalized };
}

/** Variação percentual (Decimal exato; 1,20 → 1,26 = 5 e não 5,000000000004). */
export function computeChangePct(previous: string | number, next: string | number): Decimal | null {
  const prev = toDecimal(previous);
  const nxt = toDecimal(next);
  if (!prev || !nxt || prev.lte(0)) return null;
  return nxt.minus(prev).div(prev).mul(100);
}

/** Limite de variação da loja (`stores.settings.fxMaxVariationPercent`), default 5. */
export function resolveMaxVariationPercent(settings: unknown): number {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const raw = s['fxMaxVariationPercent'];
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1000) return n;
  return FX_DEFAULT_MAX_VARIATION_PERCENT;
}

/**
 * Faixa em que a primeira taxa real (bootstrap da semente 1) é aplicada sem
 * aprovação. Fora dela → `pending_approval` uma única vez (QA 0.7 · F4).
 * [AUTO-DECISION do orquestrador] default 0,2 a 5 (GBP→BRL ~7 pede aprovação).
 */
export const FX_DEFAULT_BOOTSTRAP_RANGE = { min: 0.2, max: 5 } as const;

export interface BootstrapRange {
  min: number;
  max: number;
}

/** `stores.settings.fxBootstrapMinRate` / `fxBootstrapMaxRate` (default 0,2 a 5). */
export function resolveBootstrapRange(settings: unknown): BootstrapRange {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  };
  const min = num(s['fxBootstrapMinRate']) ?? FX_DEFAULT_BOOTSTRAP_RANGE.min;
  const max = num(s['fxBootstrapMaxRate']) ?? FX_DEFAULT_BOOTSTRAP_RANGE.max;
  return min < max ? { min, max } : { ...FX_DEFAULT_BOOTSTRAP_RANGE };
}

export function isSeedPlaceholder(rate: string | number): boolean {
  const d = toDecimal(rate);
  return d !== null && d.eq(FX_SEED_PLACEHOLDER_RATE);
}

export interface RateDecisionInput {
  /** `price_rules.exchange_rate` vigente. */
  currentRate: string | number;
  /** A regra já tem alguma linha `applied` em `fx_rate_history`? */
  hasAppliedHistory: boolean;
  /** `price_rules.rate_locked`. */
  locked: boolean;
  /** Taxa proposta (bruta, do provedor). */
  proposedRate: unknown;
  maxVariationPercent: number;
  /** Faixa do bootstrap automático (default FX_DEFAULT_BOOTSTRAP_RANGE). */
  bootstrapRange?: BootstrapRange;
}

export type RateDecision =
  | { kind: 'skipped_locked'; previousRate: string; newRate: string | null; changePct: string | null }
  | {
      kind: 'invalid';
      code: 'FX_RATE_INVALID';
      reason: FxRateInvalidReason;
      previousRate: string;
      rawValue: string;
    }
  | { kind: 'unchanged'; previousRate: string; newRate: string }
  | {
      kind: 'apply';
      origin: 'frankfurter' | 'bootstrap';
      previousRate: string;
      newRate: string;
      changePct: string | null;
    }
  | {
      kind: 'pending_approval';
      previousRate: string;
      newRate: string;
      changePct: string | null;
      /** `baseline_invalid` quando a taxa vigente não serve de base (ex.: 0 gravado no passado). */
      cause: 'variation_above_limit' | 'baseline_invalid' | 'bootstrap_out_of_range';
    };

function rawToString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '[valor ilegível]';
  }
}

function pctString(pct: Decimal | null): string | null {
  return pct === null ? null : pct.toDecimalPlaces(4).toString();
}

/**
 * Decide o que fazer com uma taxa proposta pelo provedor para UMA regra.
 * Pura: quem chama grava o histórico, aplica e decide sobre o price-sync.
 */
export function decideRateUpdate(input: RateDecisionInput): RateDecision {
  const previousRate = rawToString(input.currentRate);
  const current = toDecimal(input.currentRate);
  const isSeed = !input.hasAppliedHistory && current !== null && current.eq(FX_SEED_PLACEHOLDER_RATE);
  const baselineValid = current !== null && current.gt(0);

  if (input.locked) {
    const v = validateRate(input.proposedRate);
    return {
      kind: 'skipped_locked',
      previousRate,
      newRate: v.ok ? v.normalized : null,
      changePct: v.ok && baselineValid ? pctString(computeChangePct(previousRate, v.normalized)) : null,
    };
  }

  const validation = validateRate(input.proposedRate, {
    reference: isSeed || !baselineValid ? null : previousRate,
  });
  if (!validation.ok) {
    return {
      kind: 'invalid',
      code: validation.code,
      reason: validation.reason,
      previousRate,
      rawValue: rawToString(input.proposedRate),
    };
  }
  const newRate = validation.normalized;

  if (isSeed) {
    const range = input.bootstrapRange ?? FX_DEFAULT_BOOTSTRAP_RANGE;
    if (validation.rate.lt(range.min) || validation.rate.gt(range.max)) {
      return {
        kind: 'pending_approval',
        previousRate,
        newRate,
        changePct: pctString(computeChangePct(previousRate, newRate)),
        cause: 'bootstrap_out_of_range',
      };
    }
    return {
      kind: 'apply',
      origin: 'bootstrap',
      previousRate,
      newRate,
      changePct: pctString(computeChangePct(previousRate, newRate)),
    };
  }

  if (!baselineValid) {
    return { kind: 'pending_approval', previousRate, newRate, changePct: null, cause: 'baseline_invalid' };
  }

  if (current.eq(newRate)) return { kind: 'unchanged', previousRate, newRate };

  const pct = computeChangePct(previousRate, newRate);
  if (pct !== null && pct.abs().gt(input.maxVariationPercent)) {
    return {
      kind: 'pending_approval',
      previousRate,
      newRate,
      changePct: pctString(pct),
      cause: 'variation_above_limit',
    };
  }
  return { kind: 'apply', origin: 'frankfurter', previousRate, newRate, changePct: pctString(pct) };
}
