// ADR-002 §11.2 §5-8 — Region ownership + conflict resolution.
//
// A2 (revisado): ownership por region kind, NÃO hierarquia global.
// Component adapter NÃO ganha automaticamente sobre shared para todos os kinds.
//
// Types of origin:
//   - page_theme_adapter  (futuro; ainda não temos)
//   - component_adapter   (Kaching Bundles Component)
//   - shared_detector     (novos em 11.3)

import type {
  SemanticRegion,
  SemanticRegionKind,
} from '../types/semantic-region.js';
import type { DomScope } from './dom-scope.js';
import { scopeEquals, scopeOverlaps } from './dom-scope.js';

export type OriginType =
  | 'page_theme_adapter'
  | 'component_adapter'
  | 'shared_detector';

/**
 * Claim de ownership de uma região detectada por um detector.
 * Explícito e serializável.
 */
export interface RegionOwnershipClaim {
  /** ID do detector (ou adapter) que fez a claim. */
  ownerId: string;
  /** Tipo de origem. */
  originType: OriginType;
  /** Region kind reclamada. */
  regionKind: SemanticRegionKind;
  /** Onde no DOM (instância). */
  scope: DomScope;
  /** Prioridade explícita (0..100). Detector pode sobrescrever default. */
  priority: number;
  /** Confidence do detector (0..1). */
  confidence: number;
  /**
   * true = owner declara ser autoritativo pra este kind neste scope.
   * Só respeitado se o kind default_ownership permite este originType.
   */
  authoritative: boolean;
  /** Evidence humano-legível. */
  reason: string;
  /** A região semântica completa (kind, evidence, children, criticality...). */
  region: SemanticRegion;
}

/**
 * Ownership default por region kind. Não é hierarquia global.
 * Cada kind indica quais originTypes podem ser autoritativos.
 *
 * "all" = qualquer origem pode reclamar authoritative.
 * Ordem no array reflete precedência default em caso de conflito
 * com mesma confidence.
 */
export const KIND_OWNERSHIP_DEFAULTS: Record<
  SemanticRegionKind,
  readonly OriginType[]
> = {
  // Component/theme regions críticas de commerce
  bundles: ['component_adapter', 'page_theme_adapter'],
  price_block: ['component_adapter', 'page_theme_adapter', 'shared_detector'],
  variant_selector: ['component_adapter', 'shared_detector', 'page_theme_adapter'],
  product_json: ['shared_detector', 'page_theme_adapter'],
  currency_config: ['shared_detector', 'page_theme_adapter'],

  // CTA principal — normalmente shared Shopify wins
  cta_primary: ['shared_detector', 'component_adapter', 'page_theme_adapter'],

  // Content regions — shared/theme wins, component NÃO steal por default
  hero: ['shared_detector', 'page_theme_adapter'],
  headline: ['shared_detector', 'page_theme_adapter'],
  subheadline: ['shared_detector', 'page_theme_adapter'],
  product_title: ['shared_detector', 'page_theme_adapter'],
  product_description: ['shared_detector', 'page_theme_adapter'],
  gallery: ['shared_detector', 'page_theme_adapter', 'component_adapter'],

  // Advertorial regions — shared owns
  article_body: ['shared_detector', 'page_theme_adapter'],
  author_block: ['shared_detector', 'page_theme_adapter'],

  // Trust/support content — shared
  reviews: ['shared_detector', 'page_theme_adapter'],
  testimonials: ['shared_detector', 'page_theme_adapter'],
  benefits: ['shared_detector', 'page_theme_adapter'],
  faq: ['shared_detector', 'page_theme_adapter'],
  guarantee: ['shared_detector', 'page_theme_adapter'],
  footer: ['shared_detector', 'page_theme_adapter'],

  // Escape hatch — qualquer origem
  unclassified: ['shared_detector', 'page_theme_adapter', 'component_adapter'],
} as const;

/**
 * Priority default por originType. Só usado quando claim NÃO especifica
 * priority explícito.
 */
export const DEFAULT_PRIORITY_BY_ORIGIN: Record<OriginType, number> = {
  page_theme_adapter: 60,
  component_adapter: 50,
  shared_detector: 40,
};

// ────────────────────────────────────────────────────────────────
// Conflict resolution
// ────────────────────────────────────────────────────────────────

export type ConflictResolution =
  | 'resolved' // Um vencedor claro
  | 'coexisting' // Múltiplos claims válidos, sem overlap
  | 'ambiguous' // Empate real — sem winner
  | 'conflicting'; // Overlap incompatível

export type LoserReason =
  | 'superseded' // Ownership de origem melhor pro kind
  | 'lower_confidence' // Menor confidence
  | 'lower_priority' // Menor priority explícita
  | 'authoritative_denied' // Reclamou authoritative mas kind não permite
  | 'duplicate' // Mesmo detector duplicou claim
  | 'overlapping_but_compatible'; // Sub-região dentro de outra

export interface RegionConflict {
  regionKind: SemanticRegionKind;
  scope: DomScope;
  claims: RegionOwnershipClaim[];
  resolution: ConflictResolution;
  /**
   * Winner AUTORITATIVO. Só populado quando resolution === 'resolved'.
   *
   * IMPORTANTE (11.2 closure): Se resolution === 'ambiguous', winner é
   * undefined — nenhum candidate ganha autoridade. Consumidores (editor,
   * publish, mutation) NÃO podem tratar deterministicCandidate como
   * resolved. Use apenas pra logs/snapshots/reproducibility.
   */
  winner?: RegionOwnershipClaim;
  /**
   * Winner determinístico em caso de tie — SOMENTE PRA DIAGNÓSTICO.
   * NUNCA representa authority. Sempre acompanhado de winnerIsAuthoritative=false
   * quando resolution === 'ambiguous'.
   */
  deterministicCandidate?: RegionOwnershipClaim;
  /**
   * Explicit guard: `false` quando resolution === 'ambiguous' | 'conflicting'.
   * Consumidores devem checar isto antes de aplicar mutations dependentes.
   */
  winnerIsAuthoritative: boolean;
  losers: Array<{ claim: RegionOwnershipClaim; reason: LoserReason }>;
  reason: string;
  warning?: {
    severity: 'info' | 'warn' | 'error';
    code: string;
    message: string;
  };
}

/**
 * Resolve conflitos agrupando claims por (kind, scope).
 * Não muta claims. Retorna array de conflitos + claims coexistentes.
 * Determinístico: ties resolvidos por ownerId asc.
 */
export function resolveOwnership(
  claims: readonly RegionOwnershipClaim[],
): {
  winners: RegionOwnershipClaim[]; // Claims que "sobreviveram" (podem coexistir)
  conflicts: RegionConflict[]; // Conflict records estruturados
} {
  const conflicts: RegionConflict[] = [];
  const winners: RegionOwnershipClaim[] = [];

  // Agrupa por (kind, structuralPath)
  const groups = new Map<string, RegionOwnershipClaim[]>();
  for (const c of claims) {
    const key = `${c.regionKind}::${c.scope.structuralPath}`;
    const existing = groups.get(key) ?? [];
    existing.push(c);
    groups.set(key, existing);
  }

  for (const [_key, group] of groups.entries()) {
    if (group.length === 0) continue;
    if (group.length === 1) {
      winners.push(group[0]!);
      continue;
    }

    // Múltiplos claims no mesmo (kind, scope) → resolver.
    const conflict = resolveGroup(group);
    // 11.2 CLOSURE: winners[] SÓ inclui claims quando authoritative.
    // Ambiguous e conflicting → nenhum authority.
    if (conflict.winnerIsAuthoritative && conflict.winner) {
      winners.push(conflict.winner);
    }
    conflicts.push(conflict);
  }

  // Segunda passada: overlaps entre kinds diferentes NÃO são conflito por
  // default (hero pode conter headline). Não fazemos nada aqui.
  // Overlap DENTRO do mesmo kind já foi resolvido acima.

  return { winners, conflicts };
}

function resolveGroup(claims: RegionOwnershipClaim[]): RegionConflict {
  // Sort determinístico: authoritative > allowed-origin > confidence > priority > ownerId asc
  const kind = claims[0]!.regionKind;
  const scope = claims[0]!.scope;
  const allowedOrigins = KIND_OWNERSHIP_DEFAULTS[kind] ?? [];

  const scored = claims.map((c) => {
    const originIndex = allowedOrigins.indexOf(c.originType);
    const authoritativeValid =
      c.authoritative && originIndex >= 0;
    const authoritativeInvalid =
      c.authoritative && originIndex < 0;
    return {
      claim: c,
      // Origin score: menor index = maior precedência (0 = mais preferido)
      // -1 (não permitido) vira Infinity
      originScore: originIndex < 0 ? Number.POSITIVE_INFINITY : originIndex,
      authoritativeValid,
      authoritativeInvalid,
    };
  });

  // Filtra authoritative_denied
  const deniedAuthoritative = scored.filter((s) => s.authoritativeInvalid);
  const eligible = scored.filter((s) => !s.authoritativeInvalid);

  // Se algum é authoritativeValid, o de menor originScore + maior confidence vence.
  const authoritatives = eligible.filter((s) => s.authoritativeValid);

  const losers: Array<{ claim: RegionOwnershipClaim; reason: LoserReason }> = [];
  for (const denied of deniedAuthoritative) {
    losers.push({
      claim: denied.claim,
      reason: 'authoritative_denied',
    });
  }

  let winnerScored: (typeof scored)[number] | null = null;
  let resolution: ConflictResolution = 'resolved';

  if (authoritatives.length > 0) {
    // Prefere authoritative + menor originScore + maior confidence + ownerId asc
    authoritatives.sort((a, b) => {
      if (a.originScore !== b.originScore) return a.originScore - b.originScore;
      if (b.claim.confidence !== a.claim.confidence)
        return b.claim.confidence - a.claim.confidence;
      return a.claim.ownerId.localeCompare(b.claim.ownerId);
    });
    winnerScored = authoritatives[0]!;

    for (const s of eligible) {
      if (s === winnerScored) continue;
      losers.push({
        claim: s.claim,
        reason: s.authoritativeValid ? 'lower_priority' : 'superseded',
      });
    }
  } else if (eligible.length > 0) {
    // Sem authoritative: precedência puramente por originScore + confidence + priority + ownerId
    eligible.sort((a, b) => {
      if (a.originScore !== b.originScore) return a.originScore - b.originScore;
      if (b.claim.confidence !== a.claim.confidence)
        return b.claim.confidence - a.claim.confidence;
      if (b.claim.priority !== a.claim.priority)
        return b.claim.priority - a.claim.priority;
      return a.claim.ownerId.localeCompare(b.claim.ownerId);
    });
    winnerScored = eligible[0]!;

    // Testa se o topo é empate real com outro (mesmo originScore + confidence + priority)
    const runnerUp = eligible[1];
    if (
      runnerUp &&
      runnerUp.originScore === winnerScored.originScore &&
      runnerUp.claim.confidence === winnerScored.claim.confidence &&
      runnerUp.claim.priority === winnerScored.claim.priority
    ) {
      // Empate real — sinaliza ambiguous mas ainda escolhe determinísticamente por ownerId asc
      resolution = 'ambiguous';
    }

    for (const s of eligible) {
      if (s === winnerScored) continue;
      const reason: LoserReason =
        s.originScore > winnerScored.originScore
          ? 'superseded'
          : s.claim.confidence < winnerScored.claim.confidence
          ? 'lower_confidence'
          : 'lower_priority';
      losers.push({ claim: s.claim, reason });
    }
  } else {
    // Todos negados (authoritative fora do kind default) — sem winner
    resolution = 'conflicting';
  }

  const candidate = winnerScored?.claim;
  const isAuthoritative = resolution === 'resolved' && candidate !== undefined;

  const warning =
    resolution === 'ambiguous'
      ? {
          severity: 'warn' as const,
          code: 'ambiguous_ownership',
          message: `Multiple claims tied for ${kind} at ${scope.structuralPath}`,
        }
      : deniedAuthoritative.length > 0
      ? {
          severity: 'info' as const,
          code: 'authoritative_denied',
          message:
            `Claim(s) marked authoritative rejected for ${kind}: ` +
            deniedAuthoritative.map((d) => d.claim.ownerId).join(', '),
        }
      : undefined;

  // 11.2 CLOSURE: separação estrita entre winner authoritative e
  // deterministicCandidate (só diagnóstico).
  const conflict: RegionConflict = {
    regionKind: kind,
    scope,
    claims,
    resolution,
    winnerIsAuthoritative: isAuthoritative,
    losers,
    reason: buildReason(resolution, candidate, losers),
    ...(warning ? { warning } : {}),
  };

  if (isAuthoritative && candidate) {
    conflict.winner = candidate;
  } else if (candidate) {
    // Ambiguous ou conflicting com candidate escolhido determinísticamente
    // pra logs/snapshots/reproducibility. NUNCA authority.
    conflict.deterministicCandidate = candidate;
  }

  return conflict;
}

function buildReason(
  resolution: ConflictResolution,
  winner: RegionOwnershipClaim | undefined,
  losers: Array<{ claim: RegionOwnershipClaim; reason: LoserReason }>,
): string {
  if (resolution === 'resolved' && winner) {
    return `winner=${winner.ownerId} (${winner.originType}), ` +
      `losers=[${losers.map((l) => `${l.claim.ownerId}:${l.reason}`).join(', ')}]`;
  }
  if (resolution === 'ambiguous' && winner) {
    return `AMBIGUOUS — deterministic winner=${winner.ownerId} but tie exists`;
  }
  if (resolution === 'conflicting') {
    return `CONFLICTING — no valid claim for kind`;
  }
  return `unknown resolution`;
}

// ────────────────────────────────────────────────────────────────
// Utility: exports for detectors that need to consult
// ────────────────────────────────────────────────────────────────

/**
 * Retorna true se claim seria válida (originType está em KIND_OWNERSHIP_DEFAULTS[kind]).
 * Detectores podem consultar antes de emitir authoritative=true.
 */
export function isOriginAllowedForKind(
  origin: OriginType,
  kind: SemanticRegionKind,
): boolean {
  return (KIND_OWNERSHIP_DEFAULTS[kind] ?? []).includes(origin);
}

// Re-export utilities from dom-scope pra conveniência
export { scopeEquals, scopeOverlaps };
