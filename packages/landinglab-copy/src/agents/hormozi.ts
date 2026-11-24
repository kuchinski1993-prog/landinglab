// Hormozi copywriter — offer_stack, urgency, guarantee, benefit_bullets.
// Story 13.4 AC10.

import type { Pir } from '@blackshop/landinglab-research';

import { buildHormoziSystemPrompt } from '../prompts/hormozi.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyWorkerOutput } from './types.js';
import { runClaudeAgent } from './shared.js';

export interface HormoziAgentDeps {
  claude: ClaudeTextClient;
}

export async function runHormoziAgent(
  pir: Pir,
  language: 'en' | 'de' | 'it' | 'fr' | 'es',
  deps: HormoziAgentDeps,
): Promise<CopyWorkerOutput> {
  const systemPrompt = buildHormoziSystemPrompt(language, pir);
  const userMessage = `Produce your Hormozi copywriter JSON for landing_page product "${pir.identity.name}" in language "${language}". Return only the JSON object.`;

  return runClaudeAgent({
    agentName: 'hormozi',
    systemPrompt,
    userMessage,
    claude: deps.claude,
    mapContributions: mapHormoziRaw,
    temperature: 0.7,
    maxTokens: 4096,
  });
}

function mapHormoziRaw(raw: unknown): CopyContributions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const contributions: CopyContributions = {};

  if (obj['offer_stack'] && typeof obj['offer_stack'] === 'object') {
    contributions.offer_stack = obj['offer_stack'] as CopyContributions['offer_stack'];
  }
  if (typeof obj['urgency_copy'] === 'string') {
    contributions.urgency_copy = obj['urgency_copy'];
  }
  if (typeof obj['guarantee'] === 'string') {
    contributions.guarantee = obj['guarantee'];
  }
  if (Array.isArray(obj['benefit_bullets'])) {
    contributions.benefit_bullets = obj['benefit_bullets'] as CopyContributions['benefit_bullets'];
  }
  if (Array.isArray(obj['voc_verbatim_used'])) {
    contributions.voc_verbatim_used = (obj['voc_verbatim_used'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  // Need at least offer_stack OR bullets to be considered "usable".
  if (!contributions.offer_stack && !contributions.benefit_bullets) return null;
  return contributions;
}
