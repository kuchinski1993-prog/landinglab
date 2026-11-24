import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signFunnelPreview, verifyFunnelPreview } from '../funnel-preview.js';

describe('isolated VSL funnel preview grant', () => {
  it('authorizes one project briefly and rejects tampering or expiry', () => {
    const projectId = randomUUID(), secret = 'preview-secret-with-at-least-thirty-two-characters';
    const token = signFunnelPreview(projectId, secret, 1000, 900);
    expect(verifyFunnelPreview(token, secret, 1001)?.projectId).toBe(projectId);
    expect(verifyFunnelPreview(token, secret, 1900)).toBeNull();
    expect(verifyFunnelPreview(token + 'x', secret, 1001)).toBeNull();
  });
});
