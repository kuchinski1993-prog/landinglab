// Halbert copywriter — subheadlines (story-driven) + benefit_bullets (emotional) + voc_verbatim.
// Story 13.4 AC12. Primary VOC-verbatim contributor.

import type { Pir } from '@blackshop/landinglab-research';

import { buildHalbertSystemPrompt } from '../prompts/halbert.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyWorkerOutput } from './types.js';
import { runClaudeAgent } from './shared.js';

export interface HalbertAgentDeps {
  claude: ClaudeTextClient;
}

export async function runHalbertAgent(
  pir: Pir,
  language: 'en' | 'de' | 'it' | 'fr' | 'es',
  deps: HalbertAgentDeps,
): Promise<CopyWorkerOutput> {
  const systemPrompt = buildHalbertSystemPrompt(language, pir);
  const userMessage = `Produce your Halbert copywriter JSON (story-driven subheadlines + emotional bullets + VOC verbatim) for "${pir.identity.name}" in ${language}. Return only the JSON object.`;

  return runClaudeAgent({
    agentName: 'halbert',
    systemPrompt,
    userMessage,
    claude: deps.claude,
    mapContributions: mapHalbertRaw,
    temperature: 0.75,
    maxTokens: 3072,
  });
}

function mapHalbertRaw(raw: unknown): CopyContributions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const contributions: CopyContributions = {};

  if (Array.isArray(obj['subheadlines'])) {
    contributions.subheadlines = (obj['subheadlines'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (Array.isArray(obj['benefit_bullets'])) {
    contributions.benefit_bullets = obj['benefit_bullets'] as CopyContributions['benefit_bullets'];
  }
  if (Array.isArray(obj['voc_verbatim_used'])) {
    contributions.voc_verbatim_used = (obj['voc_verbatim_used'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (!contributions.benefit_bullets && !contributions.subheadlines) return null;
  return contributions;
}
