export const VSL_PROGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECKOUT_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id','fbclid','gclid','ttclid','src','sck','ref'] as const;
/** Story 16.3: `ref`/`fn` já presentes no link de destino nunca são sobrescritos nem removidos. */
const PROTECTED_CHECKOUT_PARAMS: readonly string[] = ['ref', 'fn'];

export type PlaybackSignal = 'play'|'playing'|'timeupdate'|'pause'|'waiting'|'stalled'|'seeking'|'seeked'|'ended'|'visibilitychange';

/** Monotonic client clock. It never credits seeks, hidden tabs, speed multipliers or long suspension gaps. */
export class VslPlaybackClock {
  private active = false;
  private last: number | undefined;
  private total = 0;
  constructor(private readonly maxGapMs = 2_000) {}
  signal(signal: PlaybackSignal, nowMs: number, visible = true, rate = 1) {
    if (this.active && this.last !== undefined && visible && rate > 0 && rate <= 1.25) {
      const delta = nowMs - this.last;
      if (delta >= 0 && delta <= this.maxGapMs) this.total += delta / 1000;
    }
    this.last = nowMs;
    if (signal === 'playing' || signal === 'play') this.active = visible;
    if (signal === 'pause' || signal === 'waiting' || signal === 'stalled' || signal === 'seeking' || signal === 'ended' || signal === 'visibilitychange') this.active = false;
    if (!visible) this.active = false;
    return this.total;
  }
  seconds() { return this.total; }
}

export interface ProgressStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export interface VslProgress { seconds: number; touchedAt: number; ruleVersion: string; videoId: string; }

export class VslProgressStore {
  private memory = new Map<string, VslProgress>();
  constructor(private readonly storage?: ProgressStorage, private readonly now = () => Date.now()) {}
  key(pageId: string, videoId: string, ruleVersion: string) { return `vsl:progress:${pageId}:${videoId}:${ruleVersion}`; }
  read(pageId: string, videoId: string, ruleVersion: string): VslProgress | null {
    const key = this.key(pageId, videoId, ruleVersion); let raw: string | null = null;
    try { raw = this.storage?.getItem(key) ?? null; } catch { raw = null; }
    const value = raw ? JSON.parse(raw) as VslProgress : this.memory.get(key);
    if (!value || value.videoId !== videoId || value.ruleVersion !== ruleVersion || this.now() - value.touchedAt > VSL_PROGRESS_TTL_MS) return null;
    return value;
  }
  write(pageId: string, videoId: string, ruleVersion: string, seconds: number) {
    const value = { seconds: Math.max(0, seconds), touchedAt: this.now(), ruleVersion, videoId };
    const key = this.key(pageId, videoId, ruleVersion); this.memory.set(key, value);
    try { this.storage?.setItem(key, JSON.stringify(value)); } catch { /* memory fallback */ }
    return value;
  }
}

export function validateTimer(seconds: number, duration: number) {
  if (!Number.isInteger(seconds) || seconds < 0 || !Number.isFinite(duration) || duration <= 0 || seconds > duration) throw new Error('Invalid VSL timer');
  return seconds;
}
export function shouldReleaseOffer(seconds: number, timer: number, started: boolean) { return timer === 0 ? started : seconds >= timer; }

export function buildHotmartCheckout(raw: string, configured: Record<string, string | undefined> = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/(^|\.)hotmart\.com$/i.test(url.hostname) || url.hostname.toLowerCase().endsWith('.hotmart.com.evil')) throw new Error('Invalid Hotmart checkout host');
  for (const key of CHECKOUT_PARAMS) {
    if (PROTECTED_CHECKOUT_PARAMS.includes(key) && url.searchParams.has(key)) continue;
    const value = configured[key] ?? url.searchParams.get(key); if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  for (const key of [...url.searchParams.keys()]) if (!CHECKOUT_PARAMS.includes(key as typeof CHECKOUT_PARAMS[number]) && !PROTECTED_CHECKOUT_PARAMS.includes(key) && !(configured[key] !== undefined)) url.searchParams.delete(key);
  return url.toString();
}
