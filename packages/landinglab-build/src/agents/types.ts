// Shared agent types for Squad 4 (Build HTML).
//
// Kept intentionally tiny — build agents are deterministic (except seo-optimizer,
// which optionally calls Claude Haiku). Each agent returns a stable, typed payload
// so the build-chief can wire them without runtime coercion.
//
// Story 13.6 AC9-AC15.

import type { TemplateName } from '../schema/build-output.js';

export type BuildAgentName =
  | 'template-selector'
  | 'content-composer'
  | 'layout-planner' // Fase 3: monta ordem de blocos p/ dynamic-blocks template.
  | 'html-builder'
  | 'seo-optimizer'
  | 'performance-optimizer'
  | 'build-chief';

export interface BuildAgentTrace {
  agent: BuildAgentName;
  language: string;
  cost_usd: number;
  latency_ms: number;
  provider?: 'claude-haiku' | 'none';
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
  notes?: string;
}

export type { TemplateName };
