// Shared types para os 6 agentes do Squad 3 (Visual Director + 5 downstream).
//
// Espelha packages/landinglab-copy/src/agents/types.ts (Squad 2).
// Diferença chave: Squad 3 tem 2 tipos de agents:
//   - Text-only (Visual Director, Brand Forge naming step) → usa ClaudeTextClient
//   - Image-generating (Brand Forge logo, Hero, Lifestyle, Icons, SocialProof) → usa ImageProvider
// Ambos emitem VisualTraceEntry (definido no orchestrator).

import type { Assets, Brand, ContributingAgent, Icon } from '../schema/visual-assets.js';
import type { VisualTraceEntry } from '../orchestrator.js';

/** Nome do agent no trace + audit. */
export type VisualAgentName =
  | 'visual-director'
  | 'brand-forge'
  | 'hero-designer'
  | 'lifestyle-composer'
  | 'icon-generator'
  | 'social-proof-designer';

/**
 * Direção visual — output da Fase 1 (Visual Director), input da Fase 2 (5 agents).
 * NÃO persiste sozinha — o Director assembla no VisualAssets final.
 */
export interface VisualDirection {
  palette: Brand['palette'];
  typography: Brand['typography'];
  /** Tom visual descritivo (ex.: "energético e aspiracional"). */
  tone_descriptor: string;
  /**
   * Guidance textual pros agents downstream (ex.: "priorizar tomadas outdoor,
   * cores quentes, sem pessoas na frame do hero").
   */
  style_guidance: string;
}

/** Output do Brand Forge — nome + tagline + 3 logo URLs + trace. */
export interface BrandForgeOutput {
  name: string;
  tagline: string;
  logo_urls: Brand['logo_urls'];
  traces: VisualTraceEntry[];
}

/** Output do Hero Designer — 3 URLs por tamanho + traces. */
export interface HeroDesignerOutput {
  urls_by_size: Assets['hero']['urls_by_size'];
  traces: VisualTraceEntry[];
}

/** Output do Lifestyle Composer — 3-5 URLs + traces. */
export interface LifestyleComposerOutput {
  urls: string[];
  traces: VisualTraceEntry[];
}

/** Output do Icon Generator — 5-8 icons + traces. */
export interface IconGeneratorOutput {
  icons: Icon[];
  traces: VisualTraceEntry[];
}

/** Output do Social Proof Designer — badges + before/after + backgrounds. */
export interface SocialProofDesignerOutput {
  trust_badges: string[];
  before_after: string[];
  backgrounds: string[];
  traces: VisualTraceEntry[];
}

/** Contribuição agregada (para popular contributing_agents no VisualAssets final). */
export function makeContribution(
  agent: VisualAgentName,
  blocks: string[],
): ContributingAgent {
  return { agent, blocks_contributed: blocks };
}

/** Trace helper — cria entry padrão de trace pra agent que falhou completamente. */
export function makeFailedTrace(
  agent: VisualAgentName,
  provider: VisualTraceEntry['provider'],
  error: string,
  latency_ms = 0,
): VisualTraceEntry {
  return {
    agent,
    provider,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    latency_ms,
    error,
  };
}
