export const VSL_STEP_TYPES = ['PAGE', 'QUIZ', 'PRESELL', 'VSL', 'CHECKOUT', 'CUSTOM'] as const;
export const VSL_RENDER_MODES = ['IMPORTED_PAGE', 'NATIVE_VIDEO', 'REDIRECT'] as const;

export type VslStepType = (typeof VSL_STEP_TYPES)[number];
export type VslRenderMode = (typeof VSL_RENDER_MODES)[number];

export interface FunnelStepEdge {
  id: string;
  pathname: string;
  nextStepId: string | null;
}

export function validateFunnelGraph(steps: readonly FunnelStepEdge[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error('Duplicate step ID');
    ids.add(step.id);
    const path = normalizeVslPathname(step.pathname);
    if (paths.has(path)) throw new Error(`Duplicate step pathname: ${path}`);
    paths.add(path);
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.nextStepId && !byId.has(step.nextStepId)) throw new Error('Next step must belong to this project');
    const seen = new Set<string>();
    let cursor: FunnelStepEdge | undefined = step;
    while (cursor) {
      if (seen.has(cursor.id)) throw new Error('Step transitions contain a cycle');
      seen.add(cursor.id);
      cursor = cursor.nextStepId ? byId.get(cursor.nextStepId) : undefined;
    }
  }
}
import { normalizeVslPathname } from './pathnames.js';
