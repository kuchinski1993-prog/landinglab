// html-safety — Camada de proteção pra mutações em landing_pages.html_body.
//
// Fase 6 do Landing Lab Stabilization Roadmap (25/09/2026).
//
// PROBLEMA: html_body é modificado por 8+ endpoints diferentes (worker,
// edit-html, regenerate-block, slider-images, subs-config, etc). Sem validação,
// bugs sutis destroem HTML silenciosamente. Casos históricos:
//   - Regex greedy PostgreSQL comeu 78% do HTML da Klensia
//   - Múltiplas seções § do processor podem crashar sem invalidar output
//
// SOLUÇÃO: função `safeApplyHtmlMutation(before, mutator, options)` que:
//   1. Valida HTML de entrada (estrutura mínima OK)
//   2. Aplica a transformação
//   3. Valida HTML de saída (parseable, invariantes preservados, tamanho ok)
//   4. Se validação falhar → ABORTA, retorna erro estruturado
//   5. Cria snapshot pra rollback (opcional, via callback)
//
// Zero acoplamento com DB. O caller decide onde persistir snapshot.

import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

/**
 * Resultado de uma tentativa de mutação segura.
 * Se ok=true → newHtml é seguro pra persistir
 * Se ok=false → aborta, use reason pra logar/debugar
 */
export type SafeMutationResult =
  | {
      ok: true;
      newHtml: string;
      deltaBytes: number;
      warnings: string[];
      snapshot: HtmlSnapshot;
    }
  | {
      ok: false;
      reason: string;
      code:
        | 'input_html_invalid'
        | 'mutator_threw'
        | 'output_html_invalid'
        | 'invariant_violation'
        | 'size_regression';
      details?: Record<string, unknown>;
      snapshot?: HtmlSnapshot;
    };

/**
 * Snapshot do HTML pré-mutação. Serializable pra JSONB.
 * Caller pode persistir em landing_page_versions (Fase 7).
 */
export interface HtmlSnapshot {
  createdAt: string;
  bytes: number;
  sha256: string;
  htmlBody: string;
  reason: string;
  actor: string;
}

export interface SafeMutationOptions {
  /** Motivo humano-legível da mutação — vai pro snapshot + logs */
  reason: string;
  /** Quem tá modificando — worker/apply-bundle, api/edit-html, etc */
  actor: string;
  /**
   * Overrides pra invariantes esperados no HTML final.
   * Defaults cobrem landing típica (Kaching/Aurivita).
   */
  invariants?: Partial<HtmlInvariants>;
  /** Se true, permite reduzir HTML em >20% (default: false — bloqueia) */
  allowMajorShrink?: boolean;
}

export interface HtmlInvariants {
  /** HTML final DEVE ter <head> e <body> */
  requireHtmlSkeleton: boolean;
  /** Se true e input tem N `<img>`, output deve ter >= floor(N * imgMinRatio) */
  preserveImagesRatio: number;
  /** Se true e input tem scripts críticos, todos DEVEM permanecer */
  preserveCriticalScripts: string[];
  /**
   * Redução máxima permitida em bytes (0..1).
   * 0.2 = HTML pode encolher até 20%. Além disso aborta (a menos que allowMajorShrink=true).
   */
  maxShrinkRatio: number;
}

const DEFAULT_INVARIANTS: HtmlInvariants = {
  requireHtmlSkeleton: true,
  preserveImagesRatio: 0.9, // permite perda de até 10% das imagens (algumas landings removem grid legítimo)
  preserveCriticalScripts: [
    // Custom elements Shopify essenciais pra CTA/checkout
    'data-cc-pdp-product-json',
    // Engine V2 runtime (se já injetado)
    'data-landinglab-engine',
    // Handler de checkout (injetado pelo worker)
    'data-landinglab-checkout-handler',
  ],
  maxShrinkRatio: 0.2,
};

// ─────────────────────────────────────────────────────────────────
// API principal
// ─────────────────────────────────────────────────────────────────

/**
 * Aplica uma mutação sobre HTML com validação antes e depois.
 *
 * Uso:
 *   const result = safeApplyHtmlMutation(oldHtml, (html) => {
 *     const $ = cheerio.load(html);
 *     $('.some-price').text('€25.00');
 *     return $.html();
 *   }, { reason: 'apply-bundle prices', actor: 'worker/apply-bundle' });
 *
 *   if (result.ok) {
 *     await db.update(...).set({ htmlBody: result.newHtml });
 *     // opcional: await persistSnapshot(result.snapshot);
 *   } else {
 *     logger.error({ code: result.code, reason: result.reason }, 'HTML mutation aborted');
 *     // não sobrescreve nada — landing continua íntegra
 *   }
 */
export function safeApplyHtmlMutation(
  before: string,
  mutator: (html: string) => string,
  options: SafeMutationOptions,
): SafeMutationResult {
  const invariants: HtmlInvariants = { ...DEFAULT_INVARIANTS, ...(options.invariants ?? {}) };
  const warnings: string[] = [];

  // ── Step 1: valida input ──
  const inputValidation = validateHtmlStructure(before, invariants);
  if (!inputValidation.ok) {
    return {
      ok: false,
      code: 'input_html_invalid',
      reason: `Input HTML já está inválido antes da mutação: ${inputValidation.reason}`,
      details: inputValidation.details,
    };
  }

  // Snapshot ANTES da mutação (pra rollback mesmo se mutator crashar)
  const snapshot = buildSnapshot(before, options);

  // ── Step 2: executa mutator (protegido contra throws) ──
  let after: string;
  try {
    after = mutator(before);
  } catch (err) {
    return {
      ok: false,
      code: 'mutator_threw',
      reason: `Mutator lançou exception: ${(err as Error).message}`,
      details: { stack: (err as Error).stack },
      snapshot,
    };
  }

  if (typeof after !== 'string') {
    return {
      ok: false,
      code: 'mutator_threw',
      reason: `Mutator retornou ${typeof after}, esperado string`,
      snapshot,
    };
  }

  // ── Step 3: valida output ──
  const outputValidation = validateHtmlStructure(after, invariants);
  if (!outputValidation.ok) {
    return {
      ok: false,
      code: 'output_html_invalid',
      reason: `Output HTML inválido após mutação: ${outputValidation.reason}`,
      details: outputValidation.details,
      snapshot,
    };
  }

  // ── Step 4: valida invariantes cruzados (before vs after) ──
  const invariantResult = validateInvariants(before, after, invariants, warnings);
  if (!invariantResult.ok) {
    return {
      ok: false,
      code: 'invariant_violation',
      reason: invariantResult.reason ?? 'invariant violation (sem detalhes)',
      details: invariantResult.details,
      snapshot,
    };
  }

  // ── Step 5: valida tamanho ──
  const beforeBytes = before.length;
  const afterBytes = after.length;
  const deltaBytes = afterBytes - beforeBytes;
  const shrinkRatio = beforeBytes > 0 ? (beforeBytes - afterBytes) / beforeBytes : 0;

  if (shrinkRatio > invariants.maxShrinkRatio && !options.allowMajorShrink) {
    return {
      ok: false,
      code: 'size_regression',
      reason: `HTML encolheu ${(shrinkRatio * 100).toFixed(1)}% (${beforeBytes} → ${afterBytes} bytes), limite é ${(invariants.maxShrinkRatio * 100).toFixed(0)}%`,
      details: { beforeBytes, afterBytes, shrinkRatio },
      snapshot,
    };
  }

  if (shrinkRatio > invariants.maxShrinkRatio / 2) {
    warnings.push(
      `HTML encolheu ${(shrinkRatio * 100).toFixed(1)}% (${beforeBytes} → ${afterBytes} bytes). Confirme se é esperado.`,
    );
  }

  return {
    ok: true,
    newHtml: after,
    deltaBytes,
    warnings,
    snapshot,
  };
}

// ─────────────────────────────────────────────────────────────────
// Validators internos
// ─────────────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Valida estrutura básica do HTML — DOM parseável + skeleton mínimo.
 */
function validateHtmlStructure(html: string, invariants: HtmlInvariants): ValidationResult {
  if (typeof html !== 'string' || html.length === 0) {
    return { ok: false, reason: 'HTML vazio ou não é string' };
  }

  // Cheerio nunca throwa em HTML malformado (tolerante), mas retorna DOM vazio
  // se input é completamente inválido. Testamos existência de tags básicas.
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    return { ok: false, reason: `Cheerio load falhou: ${(err as Error).message}` };
  }

  if (invariants.requireHtmlSkeleton) {
    // IMPORTANTE: cheerio INSERE <html><head><body> implicitamente pra qualquer
    // input. Não podemos confiar em $('head'/'body').length pra validar
    // presença REAL. Checamos string literal.
    if (!/<head\b/i.test(html)) {
      return { ok: false, reason: 'HTML sem tag <head>' };
    }
    if (!/<body\b/i.test(html)) {
      return { ok: false, reason: 'HTML sem tag <body>' };
    }
    // Também valida que cheerio conseguiu montar DOM básico
    if ($('*').length === 0) {
      return { ok: false, reason: 'HTML não parseou nenhum elemento' };
    }
  }

  return { ok: true };
}

/**
 * Valida invariantes cruzados: número de imagens, scripts críticos preservados, etc.
 */
function validateInvariants(
  before: string,
  after: string,
  invariants: HtmlInvariants,
  warnings: string[],
): ValidationResult {
  const $before = cheerio.load(before);
  const $after = cheerio.load(after);

  // Imagens: perda excessiva bloqueia
  const imgsBefore = $before('img').length;
  const imgsAfter = $after('img').length;
  if (imgsBefore > 0) {
    const minRequired = Math.floor(imgsBefore * invariants.preserveImagesRatio);
    if (imgsAfter < minRequired) {
      return {
        ok: false,
        reason: `Muitas imagens perdidas: ${imgsBefore} → ${imgsAfter} (mínimo esperado: ${minRequired})`,
        details: { imgsBefore, imgsAfter, minRequired },
      };
    }
    if (imgsAfter < imgsBefore) {
      warnings.push(`Imagens reduzidas: ${imgsBefore} → ${imgsAfter}`);
    }
  }

  // Scripts críticos: se existiam antes, devem existir depois
  for (const marker of invariants.preserveCriticalScripts) {
    const existedBefore = before.includes(marker);
    const existsAfter = after.includes(marker);
    if (existedBefore && !existsAfter) {
      return {
        ok: false,
        reason: `Script crítico "${marker}" existia antes mas foi removido`,
        details: { marker },
      };
    }
  }

  return { ok: true };
}

/**
 * Constrói snapshot serializable pra JSONB / audit trail.
 */
function buildSnapshot(html: string, options: SafeMutationOptions): HtmlSnapshot {
  return {
    createdAt: new Date().toISOString(),
    bytes: html.length,
    sha256: sha256Hex(html),
    htmlBody: html,
    reason: options.reason,
    actor: options.actor,
  };
}

/**
 * SHA-256 hex digest do HTML — dedup + audit.
 * Usa Node builtin (crypto) — zero deps externas.
 *
 * IMPORTANTE: usa ESM `import { createHash } from 'node:crypto'` em top-level.
 * Versão anterior usava `require('node:crypto')` que quebrava em produção
 * (worker é ESM puro; require não existe). Bug detectado 25/09/2026 quando
 * jobs apply-bundle failed silenciosamente com "require is not defined".
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
