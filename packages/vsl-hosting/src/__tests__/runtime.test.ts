import { describe, expect, it } from 'vitest';

import { VslPlaybackClock, VslProgressStore, buildHotmartCheckout, shouldReleaseOffer, validateTimer, VSL_PROGRESS_TTL_MS } from '../runtime.js';

describe('VSL runtime timing and checkout', () => {
  it('credits only visible confirmed playback and ignores speed/seek/suspension', () => {
    const c = new VslPlaybackClock(); c.signal('playing', 0); c.signal('timeupdate', 1000); c.signal('timeupdate', 2000, true, 2); c.signal('seeking', 2000); c.signal('seeked', 2100); c.signal('playing', 2100); c.signal('timeupdate', 3000, false); expect(c.seconds()).toBe(1);
  });
  it('uses seven-day progress TTL and memory fallback', () => { let now = 0; const s = new VslProgressStore(undefined, () => now); s.write('p','v','r',4); expect(s.read('p','v','r')?.seconds).toBe(4); now = VSL_PROGRESS_TTL_MS + 1; expect(s.read('p','v','r')).toBeNull(); });
  it('validates timer boundaries and zero release', () => { expect(validateTimer(0,10)).toBe(0); expect(shouldReleaseOffer(0,0,true)).toBe(true); expect(shouldReleaseOffer(10,10,false)).toBe(true); expect(() => validateTimer(11,10)).toThrow(); });
  it('Story 16.3: ref/fn of the destination are never overwritten nor dropped', () => {
    expect(buildHotmartCheckout('https://pay.hotmart.com/x?ref=prod&fn=f1', { ref: 'visit', utm_source: 'a' })).toBe('https://pay.hotmart.com/x?ref=prod&fn=f1&utm_source=a');
    expect(buildHotmartCheckout('https://pay.hotmart.com/x', { ref: 'visit' })).toBe('https://pay.hotmart.com/x?ref=visit');
  });
  it('allowlists Hotmart parameters and rejects lookalike hosts', () => { expect(buildHotmartCheckout('https://pay.hotmart.com/x?evil=y&utm_source=a',{gclid:'z'})).toBe('https://pay.hotmart.com/x?utm_source=a&gclid=z'); expect(() => buildHotmartCheckout('https://hotmart.com.evil/x')).toThrow(); });
});
