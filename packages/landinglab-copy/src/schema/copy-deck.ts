// Copy Deck — Zod schema (Squad 2 — Story 13.4, AC3).
//
// Este é o artefato core do Squad 2. Toda validação de output do @copy-chief
// (orquestrador) passa por aqui. Downstream Squad 3 (Design) consome Copy Decks
// com esta exata shape.
//
// Frameworks aplicados (por bloco):
//   - Hormozi:  offer_stack, urgency_copy, benefit_bullets (ODI-driven)
//   - Schwartz: hooks (5 awareness stages), subheadlines
//   - Halbert:  hooks (story-driven), benefit_bullets alt, VOC verbatim
//   - Cialdini: social_proof_blocks, ctas (persuasion), urgency alt
//   - Voss:     faq (objection handling, tactical empathy)
//   - Copy Chief: seleção final, coerência, chief_notes
//
// Article IV (No Invention) enforcement — TRIPLA proteção:
//   1. Schema-level: voc_verbatim_used DEVE ter length >= 3 (.min(3))
//   2. Runtime guard: validateCopyDeck() dobra-checa após parse
//   3. (Wave 2) Copy Chief fallback: extrai de pir.voc.language_bank se agents falharem
//
// Referência de padrão: packages/landinglab-research/src/schema/pir.ts (Squad 1).

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Enums de suporte
// ─────────────────────────────────────────────────────────────────────────

/** Idiomas suportados pelo Squad 2 (ISO-639-1). Reflete CHECK do DB. */
export const CopyLanguageEnum = z.enum(['en', 'de', 'it', 'fr', 'es']);
export type CopyLanguage = z.infer<typeof CopyLanguageEnum>;

/** Awareness stages (Schwartz) — usado nos hooks pra mapear estágio-alvo. */
export const AwarenessStageEnum = z.enum([
  'unaware',
  'problem_aware',
  'solution_aware',
  'product_aware',
  'most_aware',
]);
export type AwarenessStage = z.infer<typeof AwarenessStageEnum>;

/** Frameworks que podem "assinar" um bloco (label pra Copy Chief selecionar). */
export const FrameworkSourceEnum = z.enum([
  'hormozi',
  'schwartz',
  'halbert',
  'cialdini',
  'voss',
  'chief',
]);
export type FrameworkSource = z.infer<typeof FrameworkSourceEnum>;

/** Tipos de urgência (Hormozi/Cialdini). */
export const UrgencyTypeEnum = z.enum([
  'scarcity',
  'time_limited',
  'social_proof',
  'authority',
]);
export type UrgencyType = z.infer<typeof UrgencyTypeEnum>;

/** Variantes A/B/C de CTA (usado pra experimentação futura). */
export const CtaVariantEnum = z.enum(['a', 'b', 'c']);
export type CtaVariant = z.infer<typeof CtaVariantEnum>;

/** Tipo de bloco de prova social (Cialdini). */
export const SocialProofTypeEnum = z.enum(['review', 'stat', 'authority', 'logos', 'trust_badge']);
export type SocialProofType = z.infer<typeof SocialProofTypeEnum>;

/** Técnicas Voss aplicáveis em items de FAQ. */
export const VossTechniqueEnum = z.enum([
  'accusation_audit',
  'label',
  'mirror',
  'calibrated_question',
  'tactical_empathy',
  'summary',
]);
export type VossTechnique = z.infer<typeof VossTechniqueEnum>;

// ─────────────────────────────────────────────────────────────────────────
// Sub-schemas (blocos)
// ─────────────────────────────────────────────────────────────────────────

/** Hook / headline principal. Cada hook tem awareness_stage explícito. */
export const HookSchema = z.object({
  text: z.string().min(20, 'Hook must be at least 20 chars to be meaningful'),
  awareness_stage: AwarenessStageEnum,
  framework_source: FrameworkSourceEnum,
});
export type Hook = z.infer<typeof HookSchema>;

/** Benefit bullet — resultado + mecanismo (formato Hormozi). */
export const BenefitBulletSchema = z.object({
  text: z.string().min(20, 'Bullet must be at least 20 chars'),
  /** Qual desejo/opportunity do PIR este bullet endereça. */
  desire_addressed: z.string().min(1),
  /** Verbatim do voc.language_bank do PIR (opcional — Halbert prioriza). */
  voc_source: z.string().nullable().optional(),
});
export type BenefitBullet = z.infer<typeof BenefitBulletSchema>;

/** CTA — variante A/B/C, com tipo de urgência aplicado. */
export const CtaSchema = z.object({
  text: z.string().min(5, 'CTA too short').max(60, 'CTA too long for button UX'),
  variant: CtaVariantEnum,
  urgency_type: UrgencyTypeEnum,
});
export type Cta = z.infer<typeof CtaSchema>;

/** Item de FAQ — Voss objection handling. */
export const FaqItemSchema = z.object({
  question: z.string().min(10),
  answer: z.string().min(30, 'FAQ answer must be substantive (>= 30 chars)'),
  /** Objeção do voc.top_objections do PIR que este item endereça. */
  objection_addressed: z.string().min(1),
  /** Técnica Voss aplicada (opcional — nem toda FAQ usa técnica nomeada). */
  voss_technique: VossTechniqueEnum.nullable().optional(),
});
export type FaqItem = z.infer<typeof FaqItemSchema>;

/** Bônus do offer stack (Hormozi). */
export const OfferBonusSchema = z.object({
  name: z.string().min(1),
  perceived_value: z.string().min(1),
  description: z.string().min(1),
});
export type OfferBonus = z.infer<typeof OfferBonusSchema>;

/** Offer stack completo — Hormozi value equation. */
export const OfferStackSchema = z.object({
  main_offer: z.string().min(1),
  bonuses: z.array(OfferBonusSchema).default([]),
  guarantee: z.string().min(1),
  price_anchor: z.string().min(1),
  real_value_stack: z.string().min(1),
});
export type OfferStack = z.infer<typeof OfferStackSchema>;

/** Bloco de prova social (Cialdini). */
export const SocialProofBlockSchema = z.object({
  type: SocialProofTypeEnum,
  content: z.string().min(1),
  source: z.string().nullable().optional(),
});
export type SocialProofBlock = z.infer<typeof SocialProofBlockSchema>;

/**
 * Contribuição de agente por bloco — populated pelo Copy Chief.
 * chief-facing audit trail: "quem escreveu o quê e com que confiança".
 */
export const ContributingAgentSchema = z.object({
  block: z.string().min(1),
  agent: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type ContributingAgent = z.infer<typeof ContributingAgentSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Top-level CopyDeck schema
// ─────────────────────────────────────────────────────────────────────────

export const CopyDeckSchema = z.object({
  /** Schema version — bump quando shape muda (breaking). */
  schema_version: z.literal('1.0.0').default('1.0.0'),
  /** Idioma NATIVO do Copy Deck (não traduz de EN — cada idioma é run completa). */
  language: CopyLanguageEnum,

  // ─── Hooks & headlines (Schwartz + Halbert) ────────────────────────────
  /**
   * Exatamente 3 hooks — 1 por awareness stage priorizado no PIR.
   * Schwartz supplies hooks mapeados a stages; Halbert supplies hook emocional
   * como alternativa. Copy Chief seleciona o melhor por stage.
   */
  hooks: z.array(HookSchema).min(3, 'Exactly 3 hooks required').max(3, 'Exactly 3 hooks required'),
  /** Subheadlines de suporte ao hook principal (2-3). */
  subheadlines: z.array(z.string().min(15)).min(1, 'At least 1 subheadline').max(5),

  // ─── Bullets (Hormozi + Halbert) ───────────────────────────────────────
  /** 5-8 benefit bullets. Prioriza Hormozi (ODI-driven); Halbert alterna emocionais. */
  benefit_bullets: z
    .array(BenefitBulletSchema)
    .min(5, 'At least 5 benefit bullets')
    .max(8, 'At most 8 benefit bullets'),

  // ─── CTAs (Cialdini + Chief) ───────────────────────────────────────────
  /** Exatamente 3 CTAs — variants A/B/C pra experimentação futura. */
  ctas: z.array(CtaSchema).min(3, 'Exactly 3 CTAs required').max(3, 'Exactly 3 CTAs required'),

  // ─── FAQ (Voss) ────────────────────────────────────────────────────────
  /** 5-8 items de FAQ. Cada item endereça uma objeção do voc.top_objections. */
  faq: z.array(FaqItemSchema).min(5, 'At least 5 FAQ items').max(8, 'At most 8 FAQ items'),

  // ─── Offer & pricing (Hormozi) ─────────────────────────────────────────
  offer_stack: OfferStackSchema,
  guarantee: z.string().min(50, 'Guarantee text must be substantive (>= 50 chars)'),
  urgency_copy: z.string().min(30, 'Urgency copy must be substantive (>= 30 chars)'),

  // ─── Social proof (Cialdini) ───────────────────────────────────────────
  social_proof_blocks: z
    .array(SocialProofBlockSchema)
    .min(2, 'At least 2 social proof blocks'),

  // ─── ARTICLE IV ENFORCEMENT (No Invention) ─────────────────────────────
  /**
   * Verbatim REAIS extraídos do pir.voc.language_bank e integrados no copy.
   * Mínimo 3 — se Halbert falhar, Copy Chief fallback preenche.
   * validateCopyDeck() dobra a verificação em runtime.
   */
  voc_verbatim_used: z
    .array(z.string().min(3, 'Verbatim must be non-empty (>= 3 chars)'))
    .min(3, 'voc_verbatim_used requires >= 3 entries (Article IV — No Invention)'),

  // ─── Audit trail (Copy Chief) ──────────────────────────────────────────
  /** Array de { block, agent, confidence? }. Chief popula ao montar deck. */
  contributing_agents: z.array(ContributingAgentSchema).default([]),
});

export type CopyDeck = z.infer<typeof CopyDeckSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Runtime validator com mensagens contextualizadas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valida input contra CopyDeckSchema. Se falhar, lança CopyDeckValidationError
 * com mensagem legível (usada pelo Copy Chief no fluxo de retry Zod-aware).
 *
 * ARTICLE IV: guard runtime dobra a verificação de voc_verbatim_used.
 */
export function validateCopyDeck(input: unknown): CopyDeck {
  const result = CopyDeckSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new CopyDeckValidationError(
      `CopyDeck schema validation failed:\n${issues}`,
      result.error.issues,
    );
  }
  // Guard duplo — schema já força .min(3), mas paranoia > confiança aqui.
  if (result.data.voc_verbatim_used.length < 3) {
    throw new CopyDeckValidationError(
      'voc_verbatim_used must have at least 3 entries (Constitution Article IV — No Invention). ' +
        'The copywriters must use real customer language from pir.voc.language_bank.',
      [],
    );
  }
  return result.data;
}

/** Erro custom para diferenciar validação de CopyDeck de outros erros. */
export class CopyDeckValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = 'CopyDeckValidationError';
    this.issues = issues;
  }
}
