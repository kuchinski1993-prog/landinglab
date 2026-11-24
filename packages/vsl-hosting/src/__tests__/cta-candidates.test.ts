import { describe, expect, it } from 'vitest';

import { findCtaCandidates, findCtaSuggestions } from '../cta-candidates.js';

describe('findCtaCandidates', () => {
  it('prefers #id, ranks checkout links first and ignores quiz/navigation buttons', () => {
    const html = `<html><body><button id="start">Empezar</button><button class="opt">Mujer</button>
      <form><input type="submit" value="Comprar ahora"></form>
      <div class="wrap" hidden><a id="qzCta" href="/checkout"><span>Quiero mi plan</span> · $24.999 →</a></div>
      <a href="https://pay.kiwify.com.br/abc">Garantir acesso</a><a href="https://evil.example.org/checkout">Ir</a>
      <a href="javascript:void(0)">Buy</a><script>var a = '<a id="fake" href="/checkout">Comprar</a>';</script></body></html>`;
    const candidates = findCtaCandidates(html);
    expect(candidates.map((candidate) => [candidate.selector, candidate.text, candidate.reasons])).toEqual([
      ['#qzCta', 'Quiero mi plan · $24.999 →', ['checkout_link', 'buy_text']],
      ['a[href="https://pay.kiwify.com.br/abc"]', 'Garantir acesso', ['checkout_link']],
      ['body form input', 'Comprar ahora', ['buy_text']],
      // VSL-14: link HTTPS para outro domínio (loja COD, checkout próprio) entra como sugestão, depois dos de checkout.
      ['a[href="https://evil.example.org/checkout"]', 'Ir', ['external_link']],
      ['a[href="javascript:void(0)"]', 'Buy', ['buy_text']],
    ]);
  });

  it('falls back to a short :nth-of-type path when the button has no own selector', () => {
    const candidates = findCtaCandidates('<html><body><div><span><a>Comprar</a></span></div><div><span><a>Comprar</a></span></div></body></html>');
    expect(candidates.map((candidate) => candidate.selector)).toEqual(['body div:nth-of-type(1) span a', 'body div:nth-of-type(2) span a']);
  });

  it('matches the relative path of the next step and keeps every selector unique and API-safe', () => {
    const html = `<html><body>${Array.from({ length: 30 }, (_, index) => `<div class="card"><a class="go" href="/oferta/?x=${index}">Ver</a></div>`).join('')}</body></html>`;
    const candidates = findCtaCandidates(html, { nextPath: '/oferta' });
    expect(candidates).toHaveLength(20);
    expect(new Set(candidates.map((candidate) => candidate.selector)).size).toBe(20);
    for (const candidate of candidates) {
      expect(candidate.reasons).toEqual(['next_step_link']);
      expect(candidate.selector).toMatch(/^[^{};<>]{1,200}$/);
    }
    expect(findCtaCandidates(html)).toEqual([]);
  });
});

// Padrão real (/videoteste/ e /protocolochia/): aviso com spinner acima do CTA, no mesmo slide final do quiz.
const REAL_QUIZ = `<!doctype html><html lang="es"><head><style>.qz__wait{display:flex}.qz__ctawrap{display:none}</style></head><body>
<div class="qz" id="qz">
  <div class="qz__slide is-active" data-step="promise"><h1>Tu plan</h1><p>Respondé y desbloqueá tu plan</p><button class="qz__btn" id="qzStart">Empezar →</button></div>
  <div class="qz__slide qz__final" data-step="final">
    <h2 class="qz__title">Mirá el video con tu plan personalizado</h2>
    <div class="qz__vslwrap" id="qzVsl"><div data-blackshop-video></div></div>

    <!-- Aviso mientras el CTA está bloqueado -->
    <div class="qz__wait" id="qzWait" style="display:none;">
      <span class="qz__wait-spin"></span> Seguí mirando el video para desbloquear tu plan
    </div>

    <!-- CTA con retraso -->
    <div class="qz__ctawrap" id="qzCtaWrap">
      <a class="qz__cta" id="qzCta" href="/checkout">Quiero mi plan · $19.99 →</a>
      <p class="qz__final-note">🔒 Compra 100% segura · Envío a todo el país</p>
    </div>
  </div>
</div></body></html>`;

describe('findCtaSuggestions — mensagem de espera', () => {
  it('finds #qzWait next to #qzCta on the real quiz pattern (not the other slide nor the spinner alone)', () => {
    const { candidates, waitCandidates } = findCtaSuggestions(REAL_QUIZ);
    expect(candidates.map((candidate) => candidate.selector)).toEqual(['#qzCta']);
    expect(waitCandidates).toEqual([{ selector: '#qzWait', text: 'Seguí mirando el video para desbloquear tu plan', ctaSelectors: ['#qzCta'] }]);
    expect(findCtaCandidates(REAL_QUIZ)).toEqual(candidates);
    // Botões do rodapé (irmãos do quiz no <body>) não herdam o aviso nem sugerem o bloco do quiz inteiro.
    const withFooter = REAL_QUIZ.replace('</body>', '<footer><a class="buy" href="https://pay.hotmart.com/X">Garantir</a><button>Compre agora</button></footer></body>');
    expect(findCtaSuggestions(withFooter).waitCandidates).toEqual([{ selector: '#qzWait', text: 'Seguí mirando el video para desbloquear tu plan', ctaSelectors: ['#qzCta'] }]);
  });

  it.each([
    ['pt', 'Continue assistindo para liberar a oferta'],
    ['en', 'Keep watching to see the offer'],
    ['it', "Continua a guardare il video per l'offerta"],
    ['fr', 'Continuez à regarder la vidéo'],
    ['de', 'Bitte weiter ansehen, das Angebot kommt'],
    ['es', 'Sigue viendo el video'],
  ])('recognizes the %s wait text', (_, text) => {
    const html = `<html><body><section><div class="note">${text}</div><div><a class="buy" href="https://pay.hotmart.com/X">Comprar</a></div></section></body></html>`;
    expect(findCtaSuggestions(html).waitCandidates).toEqual([{ selector: '.note', text, ctaSelectors: ['.buy'] }]);
  });

  it('uses the parent of a text-less spinner and ignores far away text, buttons and pages without a CTA', () => {
    const spinner = `<html><body><main><div class="box"><div class="msg"><span class="loader"></span> Aguarde</div><p>Depoimentos</p></div>
      <div class="cta"><a class="buy" href="/checkout">Comprar</a></div></main></body></html>`;
    expect(findCtaSuggestions(spinner).waitCandidates).toEqual([{ selector: '.msg', text: 'Aguarde', ctaSelectors: ['.buy'] }]);
    const far = `<html><body><header><p class="hint">Keep watching to unlock</p></header>
      <main><section><div><div><a class="buy" href="/checkout">Buy</a></div></div><button class="unlock">Unlock now</button></section></main></body></html>`;
    expect(findCtaSuggestions(far).waitCandidates).toEqual([]);
    expect(findCtaSuggestions('<html><body><div class="qz__wait">Seguí mirando</div></body></html>')).toEqual({ candidates: [], waitCandidates: [] });
  });

  it('VSL-14: suggests COD/own-store links on any host and Polish buy texts, ranking them with checkout links', () => {
    const html = `<html><body><a href="/sobre">Sobre</a><a class="p1" href="https://loja-cod.example/checkout?p=1">Zamów teraz</a>
      <a class="p3" href="https://loja-cod.example/checkout?p=3">3 słoiki</a><a href="http://insecure.example/x">Kup</a></body></html>`;
    const candidates = findCtaCandidates(html);
    expect(candidates.map((candidate) => [candidate.selector, candidate.reasons])).toEqual([
      ['.p1', ['external_link', 'buy_text']],
      ['.p3', ['external_link']],
      ['a[href="http://insecure.example/x"]', ['buy_text']],
    ]);
  });
});
