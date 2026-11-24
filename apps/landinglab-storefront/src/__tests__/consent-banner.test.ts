// Banner de consentimento: sem "Accetta" o pixel não carrega e o relay CAPI não sai.
import { describe, expect, it, vi } from 'vitest';

import { buildConsentScript, consentRequired, consentTexts, stripPixelNoscript } from '../lib/consent-banner';

interface FakeEl {
  id?: string;
  tagName: string;
  children: FakeEl[];
  parentNode: FakeEl | null;
  text: string;
  src?: string;
  onclick?: () => void;
  className?: string;
  appendChild: (child: FakeEl) => FakeEl;
  removeChild: (child: FakeEl) => void;
  setAttribute: (k: string, v: string) => void;
}

function el(tagName: string): FakeEl {
  const node: FakeEl = {
    tagName,
    children: [],
    parentNode: null,
    text: '',
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
      child.parentNode = null;
    },
    setAttribute() {},
  };
  return node;
}

function find(root: FakeEl, pred: (n: FakeEl) => boolean): FakeEl | null {
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

function setup(cookie = '', options: { required?: boolean } = {}) {
  const head = el('head');
  const body = el('body');
  const document = {
    cookie,
    readyState: 'complete',
    head,
    body,
    documentElement: head,
    createElement: el,
    createTextNode: (text: string) => ({ ...el('#text'), text }),
    getElementById: (id: string) => find(body, (n) => n.id === id),
    addEventListener: () => {},
  };
  const fetchCalls: Array<{ url: string; body: string }> = [];
  const window: Record<string, unknown> = {
    __LL_TRACK_EVENT_API__: 'https://api.example.com/tracking/event',
    fetch: (url: string, init: { body: string }) => {
      fetchCalls.push({ url, body: init.body });
      return Promise.resolve();
    },
  };
  const script = /<script id="ll-consent-runtime">([\s\S]*?)<\/script>/.exec(buildConsentScript('it', options))![1]!;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', 'location', script)(window, document, { protocol: 'https:' });
  return { window, document, head, body, fetchCalls };
}

// Snippet oficial do pixel (como sai do pixel-injector).
function officialSnippet(window: Record<string, unknown>, document: { head: FakeEl }): boolean {
  if (window['fbq']) return false;
  const s = el('script');
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);
  return true;
}

describe('banner de consentimento', () => {
  it('sem escolha: mostra o banner em italiano, segura o pixel na fila e não envia CAPI', () => {
    const { window, document, head, body } = setup();
    expect(find(body, (n) => n.id === 'll-consent')).not.toBeNull();
    expect(officialSnippet(window, document)).toBe(false);
    const fbq = window['fbq'] as ((...a: unknown[]) => void) & { queue: unknown[] };
    fbq('init', '1741152926934827');
    fbq('track', 'PageView');
    expect(fbq.queue).toHaveLength(2);
    expect(head.children).toHaveLength(0);
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('Accetta: carrega fbevents.js com a fila e libera o CAPI', () => {
    vi.useFakeTimers();
    const { window, document, head, body } = setup();
    const fbq = window['fbq'] as ((...a: unknown[]) => void) & { queue: unknown[] };
    fbq('track', 'ViewContent');
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    const accept = find(body, (n) => n.className === 'll-consent-accept')!;
    accept.onclick!();
    expect(document.cookie).toContain('ll_consent=granted');
    expect(find(body, (n) => n.id === 'll-consent')).toBeNull();
    expect(head.children.map((c) => c.src)).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    expect(fbq.queue).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('Rifiuta: não carrega o pixel, nunca envia CAPI e mostra o link de preferências', () => {
    const { window, document, head, body, fetchCalls } = setup();
    const fbq = window['fbq'] as ((...a: unknown[]) => void) & { queue: unknown[] };
    fbq('track', 'PageView');
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    find(body, (n) => n.className === 'll-consent-reject')!.onclick!();
    expect(document.cookie).toContain('ll_consent=denied');
    expect(head.children).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(find(body, (n) => n.id === 'll-consent-overlay')).toBeNull();
    expect(find(body, (n) => n.id === 'll-consent-prefs')).not.toBeNull();
    // Taxa de aceite: só a escolha, no endpoint de consentimento.
    expect(fetchCalls).toEqual([
      { url: 'https://api.example.com/tracking/consent', body: JSON.stringify({ choice: 'denied' }) },
    ]);
  });

  it('recusou e depois aceitou pelo link: envia o que ficou na fila da visita', () => {
    vi.useFakeTimers();
    const { window, head, body } = setup();
    const fbq = window['fbq'] as ((...a: unknown[]) => void) & { queue: unknown[] };
    fbq('track', 'PageView');
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    find(body, (n) => n.className === 'll-consent-reject')!.onclick!();
    find(body, (n) => n.id === 'll-consent-prefs')!.onclick!();
    expect(find(body, (n) => n.id === 'll-consent-prefs')).toBeNull();
    find(body, (n) => n.className === 'll-consent-accept')!.onclick!();
    expect(head.children.map((c) => c.src)).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    expect(fbq.queue).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('visita seguinte com consentimento: pixel carrega normal, sem banner, CAPI imediato', () => {
    const { window, document, head, body } = setup('ll_consent=granted');
    expect(find(body, (n) => n.id === 'll-consent')).toBeNull();
    expect(officialSnippet(window, document)).toBe(true);
    expect(head.children).toHaveLength(1);
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('visita seguinte com recusa: sem banner e sem pixel', () => {
    const { window, document, body } = setup('ll_consent=denied');
    expect(find(body, (n) => n.id === 'll-consent')).toBeNull();
    expect(officialSnippet(window, document)).toBe(false);
  });

  it('textos por idioma com fallback em inglês, e remove o <noscript> do pixel', () => {
    expect(consentTexts('it-IT').accept).toBe('Accetta');
    expect(consentTexts('xx').accept).toBe('Accept');
    const html = '<head><noscript><img src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"/></noscript><noscript>outro</noscript></head>';
    expect(stripPixelNoscript(html)).toBe('<head><noscript>outro</noscript></head>');
  });
});

describe('banner só na UE/EEE/UK/CH', () => {
  it('consentRequired: Europa e país desconhecido exigem; resto não', () => {
    for (const cc of ['IT', 'it', 'FR', 'DE', 'GB', 'CH', 'NO', null, '', 'XX1']) {
      expect(consentRequired(cc as string | null)).toBe(true);
    }
    for (const cc of ['BR', 'US', 'MX', 'AR', 'CO']) expect(consentRequired(cc)).toBe(false);
  });

  it('fora da Europa: sem banner, pixel do HTML carrega normal e CAPI imediato', () => {
    const { window, document, body } = setup('', { required: false });
    expect(find(body, (n) => n.id === 'll-consent-overlay')).toBeNull();
    expect(window['__LL_CONSENT__']).toBe('granted');
    expect(document.cookie).toContain('ll_consent=granted');
    expect(officialSnippet(window, document)).toBe(true);
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fora da Europa com recusa anterior: continua respeitando (pixel na fila, sem CAPI)', () => {
    const { window, document } = setup('ll_consent=denied', { required: false });
    expect(officialSnippet(window, document)).toBe(false);
    const send = vi.fn();
    (window['__LL_ON_CONSENT__'] as (cb: () => void) => void)(send);
    expect(send).not.toHaveBeenCalled();
  });
});
