// Schwartz copywriter — hooks (3) + subheadlines. Story 13.4 AC11.

import type { Pir } from '@blackshop/landinglab-research';

import { buildSchwartzSystemPrompt } from '../prompts/schwartz.js';
import type { ClaudeTextClient } from '../providers/claude.js';
import type { CopyContributions, CopyWorkerOutput } from './types.js';
import { runClaudeAgent } from './shared.js';

export interface SchwartzAgentDeps {
  claude: ClaudeTextClient;
}

export async function runSchwartzAgent(
  pir: Pir,
  language: 'en' | 'de' | 'it' | 'fr' | 'es',
  deps: SchwartzAgentDeps,
): Promise<CopyWorkerOutput> {
  const systemPrompt = buildSchwartzSystemPrompt(language, pir);
  const userMessage = `Produce your Schwartz copywriter JSON (3 hooks + subheadlines) for "${pir.identity.name}" in ${language}. Return only the JSON object.`;

  return runClaudeAgent({
    agentName: 'schwartz',
    systemPrompt,
    userMessage,
    claude: deps.claude,
    mapContributions: mapSchwartzRaw,
    temperature: 0.7,
    maxTokens: 2048,
  });
}

function mapSchwartzRaw(raw: unknown): CopyContributions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const contributions: CopyContributions = {};

  if (Array.isArray(obj['hooks'])) {
    contributions.hooks = obj['hooks'] as CopyContributions['hooks'];
  }
  if (Array.isArray(obj['subheadlines'])) {
    contributions.subheadlines = (obj['subheadlines'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (Array.isArray(obj['voc_verbatim_used'])) {
    contributions.voc_verbatim_used = (obj['voc_verbatim_used'] as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (!contributions.hooks) return null;
  return contributions;
}
