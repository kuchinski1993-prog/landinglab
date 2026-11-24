import { describe, expect, it } from 'vitest';

import { validatePublishSteps } from '../publication.js';

const base = { id: 'quiz', project_id: 'project', position: 0, name: 'Quiz', type: 'QUIZ', pathname: '/quiz', status: 'ready',
  render_mode: 'IMPORTED_PAGE', page_revision_id: 'revision', video_asset_id: null, video_placement: {},
  checkout_config: {}, cta_config: {}, tracking_config: {}, next_step_id: null };

describe('VSL publication gate', () => {
  it('accepts a quiz without video and a dedicated VSL step', () => {
    expect(() => validatePublishSteps([{ ...base, next_step_id: 'vsl' },
      { ...base, id: 'vsl', name: 'VSL', position: 1, pathname: '/vsl', type: 'VSL',
        render_mode: 'NATIVE_VIDEO', page_revision_id: null, video_asset_id: 'video', video_placement: { strategy: 'DEDICATED' } }])).not.toThrow();
  });
  it('rejects missing content, invalid redirect and ambiguous video placement', () => {
    expect(() => validatePublishSteps([{ ...base, page_revision_id: null }])).toThrow('page revision');
    expect(() => validatePublishSteps([{ ...base, render_mode: 'REDIRECT', page_revision_id: null,
      checkout_config: { url: 'http://pay.example.com' } }])).toThrow('HTTPS');
    expect(() => validatePublishSteps([{ ...base, video_asset_id: 'video', video_placement: {} }])).toThrow('placement');
  });
});
