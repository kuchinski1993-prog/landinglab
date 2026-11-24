// Story 20.10a (retrabalho) — fila das prévias dos cartões: no máximo `max` páginas carregando ao
// mesmo tempo, na ordem em que os cartões entraram na tela. Sem DOM, testável em unidade.
//
// Cada cartão pede uma vaga quando aparece na tela (`request`) e devolve quando o iframe terminou
// (`load`) ou desistiu (tempo esgotado, cartão saiu da tela antes da vez, cartão desmontado). A vaga
// devolvida passa para o próximo da fila.

export interface PreviewQueue {
  /** Pede uma vaga; `start` roda quando houver. Devolve a função que libera a vaga (ou sai da fila). */
  request(start: () => void): () => void;
  /** Para teste/diagnóstico: quantas prévias carregando e quantas esperando. */
  stats(): { active: number; waiting: number };
}

export function createPreviewQueue(max: number): PreviewQueue {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiting: Array<{ start: () => void; granted: boolean; done: boolean }> = [];

  function pump(): void {
    while (active < limit && waiting.length > 0) {
      const next = waiting.shift();
      if (!next || next.done) continue;
      next.granted = true;
      active += 1;
      next.start();
    }
  }

  return {
    request(start) {
      const ticket = { start, granted: false, done: false };
      waiting.push(ticket);
      pump();
      return () => {
        if (ticket.done) return; // liberar duas vezes não abre vaga extra
        ticket.done = true;
        if (ticket.granted) {
          active -= 1;
          pump();
        } else {
          const i = waiting.indexOf(ticket);
          if (i >= 0) waiting.splice(i, 1);
        }
      };
    },
    stats() {
      return { active, waiting: waiting.filter((t) => !t.done).length };
    },
  };
}

/** Prévias carregando ao mesmo tempo na lista (cada uma é uma página inteira). */
export const MAX_CONCURRENT_PREVIEWS = 3;
/** Uma prévia que não terminou em 15 s devolve a vaga (o iframe continua, só não segura a fila). */
export const PREVIEW_SLOT_TIMEOUT_MS = 15_000;

/** Fila única da tela (os cartões de uma página da lista dividem as mesmas vagas). */
export const previewQueue = createPreviewQueue(MAX_CONCURRENT_PREVIEWS);

/** Sem rolagem há este tempo = a pessoa parou de rolar. */
export const SCROLL_IDLE_MS = 200;

let lastScrollAt = Number.NEGATIVE_INFINITY;
let listening = false;

function listenScroll(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = (): void => {
    lastScrollAt = performance.now();
  };
  window.addEventListener('scroll', mark, { capture: true, passive: true });
  window.addEventListener('wheel', mark, { capture: true, passive: true });
  window.addEventListener('touchmove', mark, { capture: true, passive: true });
}

/**
 * Roda `run` quando a pessoa não está rolando a tela (e o navegador está ocioso). A prévia é uma
 * página inteira no mesmo processo da tela: montar o documento dela (HTML e CSS de loja clonada,
 * centenas de KB) no meio da rolagem trava quadros — medido: até 150 ms com 24 cartões de páginas
 * pesadas. Devolve a função que cancela.
 */
export function whenScrollIdle(run: () => void): () => void {
  listenScroll();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let cancelled = false;
  const check = (): void => {
    if (cancelled) return;
    const wait = lastScrollAt + SCROLL_IDLE_MS - performance.now();
    if (wait > 0) {
      timer = setTimeout(check, wait);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(
        () => {
          if (!cancelled) run();
        },
        { timeout: 1000 },
      );
    } else {
      run();
    }
  };
  check();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
  };
}
