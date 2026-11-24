// Voss copywriter — FAQ (5-8) with tactical empathy. Story 13.4 AC14.

import type { Pir } from '@blackshop/landinglab-research';

import { buildVossSystemPrompt } from '../prompts/voss.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyWorkerOutput } from './types.js';
import { runClaudeAgent } from './shared.js';

export interface VossAgentDeps {
  claude: ClaudeTextClient;
}

export async function runVossAgent(
  pir: Pir,
  language: 'en' | 'de' | 'it' | 'fr' | 'es',
  deps: VossAgentDeps,
): Promise<CopyWorkerOutput> {
  const systemPrompt = buildVossSystemPrompt(language, pir);
  const userMessage = `Produce your Voss FAQ JSON (5-8 objection-handling Q&A) for "${pir.identity.name}" in ${language}. Return only the JSON object.`;

  return runClaudeAgent({
    agentName: 'voss',
    systemPrompt,
    userMessage,
    claude: deps.claude,
    mapContributions: mapVossRaw,
    temperature: 0.65,
    maxTokens: 3072,
  });
}

function mapVossRaw(raw: unknown): CopyContributions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const contributions: CopyContributions = {};

  if (Array.isArray(obj['faq'])) {
    contributions.faq = obj['faq'] as CopyContributions['faq'];
  }
  if (Array.isArray(obj['voc_verbatim_used'])) {
    contributions.voc_verbatim_used = (obj['voc_verbatim_used'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (!contributions.faq) return null;
  return contributions;
}
