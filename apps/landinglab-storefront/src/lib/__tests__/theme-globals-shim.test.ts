// Utilitários globais do Dawn: definidos só quando o tema não tem os seus; debounce/throttle
// funcionam de verdade (a galeria do tema depende deles). Roda em node:vm, sem DOM real.
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { THEME_GLOBALS_SHIM_SCRIPT } from '../theme-globals-shim';

const js = THEME_GLOBALS_SHIM_SCRIPT.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

function run(existing: Record<string, unknown> = {}, document: unknown = { querySelectorAll: () => [] }) {
  const window: Record<string, unknown> = { ...existing };
  runInNewContext(js, { window, document, setTimeout, clearTimeout, Date });
  return window as Record<string, (...args: unknown[]) => unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('THEME_GLOBALS_SHIM_SCRIPT', () => {
  it('define os utilitários do Dawn que faltam', () => {
    const w = run();
    for (const name of ['debounce', 'throttle', 'fetchConfig', 'pauseAllMedia', 'getFocusableElements', 'trapFocus', 'removeTrapFocus', 'onKeyUpEscape']) {
      expect(typeof w[name]).toBe('function');
    }
    expect(w.fetchConfig()).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
  });

  it('não sobrescreve o que o tema já definiu', () => {
    const own = () => 'do tema';
    const w = run({ debounce: own });
    expect(w.debounce).toBe(own);
  });

  it('debounce chama uma vez só, com os últimos argumentos', () => {
    vi.useFakeTimers();
    const w = run();
    const fn = vi.fn();
    const d = w.debounce(fn, 300) as (v: number) => void;
    d(1); d(2); d(3);
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('pauseAllMedia pausa os vídeos da página', () => {
    const video = { pause: vi.fn() };
    const document = { querySelectorAll: (sel: string) => (sel === 'video' ? [video] : []) };
    const w = run({}, document);
    w.pauseAllMedia();
    expect(video.pause).toHaveBeenCalledOnce();
  });
});
