// Cialdini copywriter — social_proof_blocks + 3 CTAs. Story 13.4 AC13.

import type { Pir } from '@blackshop/landinglab-research';

import { buildCialdiniSystemPrompt } from '../prompts/cialdini.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyWorkerOutput } from './types.js';
import { runClaudeAgent } from './shared.js';

export interface CialdiniAgentDeps {
  claude: ClaudeTextClient;
}

export async function runCialdiniAgent(
  pir: Pir,
  language: 'en' | 'de' | 'it' | 'fr' | 'es',
  deps: CialdiniAgentDeps,
): Promise<CopyWorkerOutput> {
  const systemPrompt = buildCialdiniSystemPrompt(language, pir);
  const userMessage = `Produce your Cialdini copywriter JSON (social proof blocks + 3 CTAs A/B/C) for "${pir.identity.name}" in ${language}. Return only the JSON object.`;

  return runClaudeAgent({
    agentName: 'cialdini',
    systemPrompt,
    userMessage,
    claude: deps.claude,
    mapContributions: mapCialdiniRaw,
    temperature: 0.65,
    maxTokens: 2048,
  });
}

function mapCialdiniRaw(raw: unknown): CopyContributions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const contributions: CopyContributions = {};

  if (Array.isArray(obj['social_proof_blocks'])) {
    contributions.social_proof_blocks =
      obj['social_proof_blocks'] as CopyContributions['social_proof_blocks'];
  }
  if (Array.isArray(obj['ctas'])) {
    contributions.ctas = obj['ctas'] as CopyContributions['ctas'];
  }
  if (Array.isArray(obj['voc_verbatim_used'])) {
    contributions.voc_verbatim_used = (obj['voc_verbatim_used'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (!contributions.ctas && !contributions.social_proof_blocks) return null;
  return contributions;
}
