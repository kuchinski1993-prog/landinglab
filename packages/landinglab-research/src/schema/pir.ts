// Product Intelligence Report (PIR) — Zod schema.
//
// Este é o artefato core do Squad 1. Toda validação de output do @pir-synthesizer
// (Sage) passa por aqui. Downstream squads (Copy, Visual, Build) consomem PIRs
// com esta exata shape.
//
// Frameworks aplicados:
//   - ODI (Outcome-Driven Innovation, Ulwick): jobs solution-free + opportunity scores
//   - Schwartz 5 Awareness Stages: unaware → most-aware, com hooks/objections/proof
//   - Hormozi Value Equation: (dream_outcome × likelihood) ÷ (time × effort)
//
// Article IV (No Invention) enforcement:
//   - evidence.gaps DEVE ter length >= 1 (via .min(1))
//   - validatePir() lança erro se gaps vazio — segundo checkpoint runtime
//   - VOC quotes DEVEM ser strings não-vazias (não permite placeholder tipo "TBD")

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────

/** Identity — schema.org/Product basics extraídos por @spec-hunter. */
export const identitySchema = z.object({
  name: z.string().min(1, 'Product name required'),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  model: z.string().nullable(),
  /** Preço observado (número em unidades — normalizar antes). */
  price: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  /** URLs de imagens do produto extraídas do source. */
  images: z.array(z.string().url()).default([]),
  /** Specs técnicos livres (peso, dimensões, material, voltagem...). */
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Variantes (cor/tamanho/quantidade) se aplicável. */
  variants: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        price_delta: z.number().optional(),
      }),
    )
    .default([]),
});
export type Identity = z.infer<typeof identitySchema>;

/** Market — sofisticação Schwartz 1-5, competidores e trends. */
export const marketSchema = z.object({
  /**
   * Nível de sofisticação de mercado (Schwartz):
   *   1 = primeiro no mercado; 5 = mercado saturado, precisa mecanismo novo.
   */
  sophistication_level: z.number().int().min(1).max(5),
  /** 3-5 competidores diretos com detalhes acionáveis. */
  competitors: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().url().nullable(),
        positioning: z.string().nullable(),
        price_range: z.string().nullable(),
        weakness: z.string().nullable(),
      }),
    )
    .default([]),
  /** Trends observados por @market-analyst (ex.: keywords em alta, sazonalidade). */
  trends: z.array(z.string()).default([]),
  /** Gap explícito deste produto vs competidores. */
  gap_vs_competitors: z.string().nullable(),
});
export type Market = z.infer<typeof marketSchema>;

/** Avatar — persona alvo com ODI jobs (solution-free framing). */
export const avatarSchema = z.object({
  demographics: z.object({
    age_range: z.string().nullable(),
    gender: z.enum(['male', 'female', 'mixed', 'unknown']).default('unknown'),
    income_bracket: z.string().nullable(),
    geo: z.array(z.string()).default([]),
  }),
  psychographics: z.object({
    identity: z.string().nullable(),
    lifestyle: z.string().nullable(),
    beliefs: z.array(z.string()).default([]),
  }),
  /**
   * ODI jobs — sempre em fraseado solution-free ("minimize the time it takes to X").
   * Marcador de qualidade: se um job cita o produto ou solução, está errado.
   */
  jobs_to_be_done: z
    .array(
      z.object({
        job: z.string().min(1),
        importance: z.number().min(1).max(10),
        satisfaction: z.number().min(1).max(10),
      }),
    )
    .default([]),
});
export type Avatar = z.infer<typeof avatarSchema>;

/** Voice of Customer — extraído verbatim por @review-miner. */
export const vocSchema = z.object({
  /** Palavras/frases que o avatar realmente usa (pra copy autêntica). */
  language_bank: z.array(z.string()).default([]),
  top_pains: z
    .array(
      z.object({
        pain: z.string().min(1),
        frequency: z.number().int().nonnegative(),
        intensity: z.number().min(1).max(10),
        verbatim: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  top_desires: z
    .array(
      z.object({
        desire: z.string().min(1),
        frequency: z.number().int().nonnegative(),
        verbatim: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  top_objections: z
    .array(
      z.object({
        objection: z.string().min(1),
        frequency: z.number().int().nonnegative(),
        verbatim: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  dream_outcomes: z.array(z.string()).default([]),
});
export type Voc = z.infer<typeof vocSchema>;

/** Desired Outcomes — ODI opportunity scoring. */
export const desiredOutcomesSchema = z.object({
  /**
   * Opportunity score = importance + max(0, importance - satisfaction).
   * Ordenar desc para priorizar copy e features.
   */
  opportunities: z
    .array(
      z.object({
        outcome: z.string().min(1),
        importance: z.number().min(1).max(10),
        satisfaction: z.number().min(1).max(10),
        opportunity_score: z.number().min(0).max(20),
      }),
    )
    .default([]),
});
export type DesiredOutcomes = z.infer<typeof desiredOutcomesSchema>;

/** Awareness Stages — Schwartz 5-stage map. */
export const awarenessStageSchema = z.object({
  stage: z.enum([
    'unaware',
    'problem_aware',
    'solution_aware',
    'product_aware',
    'most_aware',
  ]),
  trigger_hook: z.string().min(1),
  education_needed: z.string().nullable(),
  objections_to_kill: z.array(z.string()).default([]),
  proof_needed: z.array(z.string()).default([]),
});
export type AwarenessStage = z.infer<typeof awarenessStageSchema>;

/** Value Equation — Hormozi. */
export const valueEquationSchema = z.object({
  dream_outcome: z.string().min(1),
  /** 0-1 → quão crível o dream_outcome parece pro avatar (subjetivo mas rastreado). */
  perceived_likelihood: z.number().min(0).max(1),
  /** Descrição do tempo até resultado percebido pelo avatar. */
  time_delay: z.string().min(1),
  /** Descrição do esforço/sacrifício percebido pelo avatar. */
  effort_sacrifice: z.string().min(1),
});
export type ValueEquation = z.infer<typeof valueEquationSchema>;

/** Evidence — bibliografia + confidence + GAPS OBRIGATÓRIAS. */
export const evidenceSchema = z.object({
  reviews_analyzed: z.number().int().nonnegative().default(0),
  sources: z
    .array(
      z.object({
        agent: z.string(),
        provider: z.string(),
        url: z.string().nullable(),
        cited_for: z.string().min(1),
      }),
    )
    .default([]),
  confidence_score: z.number().min(0).max(1),
  /**
   * ARTICLE IV ENFORCEMENT — min 1 gap é lei do schema.
   * Se Sage retornar array vazio, validação Zod falha antes de persistir.
   */
  gaps: z
    .array(z.string().min(3, 'Gap description must be meaningful (>= 3 chars)'))
    .min(1, 'evidence.gaps requires at least one entry (Article IV — No Invention)'),
});
export type Evidence = z.infer<typeof evidenceSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Top-level PIR schema
// ─────────────────────────────────────────────────────────────────────────

export const pirSchema = z.object({
  /** Schema version — bump quando shape muda. */
  schema_version: z.literal('1.0.0').default('1.0.0'),
  identity: identitySchema,
  market: marketSchema,
  avatar: avatarSchema,
  voc: vocSchema,
  desired_outcomes: desiredOutcomesSchema,
  awareness_stages: z.array(awarenessStageSchema).default([]),
  value_equation: valueEquationSchema,
  evidence: evidenceSchema,
});

export type Pir = z.infer<typeof pirSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Runtime validator com mensagens de erro contextualizadas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valida input contra pirSchema. Se falhar, lança PirValidationError com
 * mensagem legível pra humano (usada pelo synthesizer no fluxo de retry).
 *
 * ARTICLE IV: enforcement adicional runtime pra evidence.gaps.
 */
export function validatePir(input: unknown): Pir {
  const result = pirSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new PirValidationError(
      `PIR schema validation failed:\n${issues}`,
      result.error.issues,
    );
  }
  // Guard duplo — o schema já força .min(1), mas paranoia > confiança aqui.
  if (result.data.evidence.gaps.length === 0) {
    throw new PirValidationError(
      'evidence.gaps must have at least 1 entry (Constitution Article IV — No Invention). ' +
        'The synthesizer must explicitly acknowledge what could not be verified.',
      [],
    );
  }
  return result.data;
}

/** Erro custom para diferenciar validação de PIR de outros erros. */
export class PirValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = 'PirValidationError';
    this.issues = issues;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utility: opportunity score calc (usado pelo synthesizer e pelo orchestrator)
// ─────────────────────────────────────────────────────────────────────────

/**
 * ODI opportunity score = importance + max(0, importance - satisfaction).
 * Range: 0-20. Priorizar >= 12 pra copy.
 */
export function calcOpportunityScore(importance: number, satisfaction: number): number {
  const gap = Math.max(0, importance - satisfaction);
  return importance + gap;
}
