// Fidelity badge — helper para expor `clone_metadata.fidelity_*` (persistido
// pelo cloner processor em PR#144) como estado visual navegável no backoffice.
//
// Pura leitura — nunca escreve, nunca dispara side-effects. Landings clonadas
// antes da persistência da fidelity (2026-09-28) caem no verdict UNKNOWN.

export type FidelityVerdict = 'HEALTHY' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export interface FidelityInfo {
  verdict: FidelityVerdict;
  findings: string[];
}

const VALID_VERDICTS: readonly FidelityVerdict[] = [
  'HEALTHY',
  'DEGRADED',
  'BLOCKED',
  'UNKNOWN',
];

/**
 * Extrai verdict + findings do JSONB `clone_metadata` (landing_pages).
 * Retorna sempre um shape válido — nunca lança. Landings sem `clone_metadata`
 * ou com shape desconhecido resolvem em UNKNOWN (pré-fidelity-gate).
 */
export function parseFidelityFromCloneMetadata(
  cloneMetadata: unknown,
): FidelityInfo {
  if (!cloneMetadata || typeof cloneMetadata !== 'object') {
    return { verdict: 'UNKNOWN', findings: [] };
  }
  const meta = cloneMetadata as Record<string, unknown>;
  const rawVerdict = meta['fidelity_verdict'];
  const verdict: FidelityVerdict =
    typeof rawVerdict === 'string' &&
    VALID_VERDICTS.includes(rawVerdict as FidelityVerdict)
      ? (rawVerdict as FidelityVerdict)
      : 'UNKNOWN';
  const rawFindings = meta['fidelity_findings'];
  const findings: string[] = Array.isArray(rawFindings)
    ? rawFindings.filter((f): f is string => typeof f === 'string')
    : [];
  return { verdict, findings };
}

/**
 * Configuração visual por verdict. Cores mapeadas para tons Polaris usados
 * no backoffice (success/warning/critical/info). `blocksPublish` documenta
 * a policy do gate em publish-core (BLOCKED sem override → 400).
 */
export const FIDELITY_BADGE_CONFIG: Record<
  FidelityVerdict,
  {
    tone: 'success' | 'warning' | 'critical' | 'info';
    label: string;
    description: string;
    blocksPublish: boolean;
  }
> = {
  HEALTHY: {
    tone: 'success',
    label: 'Fidelity: OK',
    description: 'Clone verificado — todos os checks passaram.',
    blocksPublish: false,
  },
  DEGRADED: {
    tone: 'warning',
    label: 'Fidelity: revisar',
    description: 'Clone tem issues menores — revise findings antes de publicar.',
    blocksPublish: false,
  },
  BLOCKED: {
    tone: 'critical',
    label: 'Fidelity: bloqueado',
    description:
      'Publish automático bloqueado — findings críticos detectados (browser-extension scripts, CSS missing).',
    blocksPublish: true,
  },
  UNKNOWN: {
    tone: 'info',
    label: 'Fidelity: —',
    description: 'Landing clonada antes da introdução do fidelity gate.',
    blocksPublish: false,
  },
};
