import { describe, expect, it } from 'vitest';

import { validateFunnelGraph } from '../funnels.js';
import { normalizeVslPathname } from '../pathnames.js';

describe('VSL funnel paths and transitions', () => {
  it('normalizes paths and keeps steps independent of content type', () => {
    expect(normalizeVslPathname('/produto//quiz/')).toBe('/produto/quiz');
    expect(() => normalizeVslPathname('/%2e%2e/secrets')).toThrow();
    expect(() => normalizeVslPathname('/quiz?token=1')).toThrow();
    expect(() => validateFunnelGraph([
      { id: 'quiz', pathname: '/quiz', nextStepId: 'vsl' },
      { id: 'vsl', pathname: '/vsl', nextStepId: null },
    ])).not.toThrow();
  });

  it('rejects missing targets, path collisions and cycles', () => {
    expect(() => validateFunnelGraph([{ id: 'quiz', pathname: '/quiz', nextStepId: 'missing' }])).toThrow('belong');
    expect(() => validateFunnelGraph([
      { id: 'a', pathname: '/a', nextStepId: 'b' },
      { id: 'b', pathname: '/b', nextStepId: 'a' },
    ])).toThrow('cycle');
    expect(() => validateFunnelGraph([
      { id: 'a', pathname: '/a', nextStepId: null },
      { id: 'b', pathname: '/a/', nextStepId: null },
    ])).toThrow('Duplicate');
  });
});
