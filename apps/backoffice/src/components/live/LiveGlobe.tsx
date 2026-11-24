'use client';

// @ds-migrated — Story 21.2a / 21.2a-v3: globo "Ao vivo" leve e acessível —
// decorativo no canto superior direito do Início e do login (CornerGlobe); a
// 21.2c reusa o componente na seção "Ao vivo".
//
// Este wrapper entra no JavaScript da rota, por isso é mínimo (AC4): só decide
// SE e QUANDO o globo carrega. Tudo o mais — desenho dos pontos, laço de
// rotação, movimento reduzido, aba oculta — fica em LiveGlobeCanvas, num chunk
// próprio trazido por `import()` quando o globo está visível e a página ociosa.
//
// • A esfera (sombreado claro, sem aro) é CSS (`.ds-live-globe__sphere`); o
//   canvas 2D só desenha os pontos dos países por cima.
// • Sem canvas 2D (ou falha ao carregar/criar) → fallback estático em CSS, mesmo
//   tamanho e enquadramento.
// • Fora da tela → o canvas pausa o laço (prop `inView`).

import '@/styles/live-globe.css';

import { useCallback, useEffect, useRef, useState } from 'react';

import type LiveGlobeCanvas from './LiveGlobeCanvas';
import type { LiveGlobeFrame, LiveGlobeMarker } from './LiveGlobeCanvas';

export type { LiveGlobeFrame, LiveGlobeMarker } from './LiveGlobeCanvas';

type CanvasComponent = typeof LiveGlobeCanvas;

export interface LiveGlobeProps {
  /** Lado da caixa quadrada em px (CSS); a esfera ocupa 80 % dela, centrada. */
  size: number;
  /** Enquadramento próprio (CornerGlobe): caixa + centro/raio da esfera, que pode sair da caixa. */
  frame?: LiveGlobeFrame;
  markers?: LiveGlobeMarker[];
  /** Decorativo: escondido dos leitores de tela. */
  decorative?: boolean;
  autoRotate?: boolean;
  /** Nome acessível quando `decorative=false`. */
  label?: string;
  className?: string;
}

/** `pending` → aguardando carregar · `ready` → canvas WebGL · `fallback` → versão estática. */
export type LiveGlobeState = 'pending' | 'ready' | 'fallback';

const NO_MARKERS: LiveGlobeMarker[] = [];
let canvasSupport: boolean | null = null;

/** Detecta canvas 2D num canvas descartável (sem lançar e sem `console.error`). */
export function hasCanvas2d(): boolean {
  if (canvasSupport === null) {
    canvasSupport = false;
    // Sem a API (navegadores muito antigos): nem tenta criar contexto.
    if (typeof window.CanvasRenderingContext2D !== 'undefined') {
      try {
        const probe = document.createElement('canvas');
        canvasSupport = Boolean(probe.getContext('2d'));
        probe.width = 0;
      } catch {
        canvasSupport = false; // canvas bloqueado: fica o fallback estático
      }
    }
  }
  return canvasSupport;
}

/** Testes: esquece a detecção anterior. */
export function resetCanvasSupportCache(): void {
  canvasSupport = null;
}

/** Caixa quadrada padrão: esfera de 80 % do lado, centrada. */
export function squareFrame(size: number): LiveGlobeFrame {
  return { width: size, height: size, cx: size / 2, cy: size / 2, radius: size * 0.4 };
}

export function loadGlobeCanvas(): Promise<CanvasComponent> {
  return import('./LiveGlobeCanvas').then((mod) => mod.default);
}

export function LiveGlobe({
  size,
  frame,
  markers = NO_MARKERS,
  decorative = true,
  autoRotate = true,
  label,
  className,
}: LiveGlobeProps): JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<LiveGlobeState>('pending');
  const [inView, setInView] = useState(false);
  const [Canvas, setCanvas] = useState<CanvasComponent | null>(null);
  const box = frame ?? squareFrame(size);

  useEffect(() => {
    if (!hasCanvas2d()) {
      setState('fallback');
      return undefined;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const io = new IntersectionObserver((entries) => setInView(entries[entries.length - 1]!.isIntersecting));
    io.observe(rootRef.current!);
    return () => io.disconnect();
  }, []);

  // Carrega o chunk do globo só quando ele aparece e a página está ociosa.
  useEffect(() => {
    if (!inView || Canvas || state === 'fallback') return undefined;
    let alive = true;
    const load = (): void => {
      loadGlobeCanvas().then(
        (component) => alive && setCanvas(() => component),
        (err: unknown) => {
          console.warn('[LiveGlobe] globo indisponível, usando a versão estática.', err);
          if (alive) setState('fallback');
        },
      );
    };
    const idle = typeof window.requestIdleCallback === 'function';
    const id = idle ? window.requestIdleCallback(load, { timeout: 2000 }) : window.setTimeout(load, 200);
    return () => {
      alive = false;
      if (idle) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, [inView, Canvas, state]);

  const onReady = useCallback(() => setState('ready'), []);
  const onError = useCallback(() => setState('fallback'), []);

  return (
    <span
      ref={rootRef}
      className={className ? `ds-live-globe ${className}` : 'ds-live-globe'}
      style={{ width: box.width, height: box.height }}
      data-globe-state={state}
      data-testid="live-globe"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      <span
        className="ds-live-globe__sphere"
        style={{ left: box.cx - box.radius, top: box.cy - box.radius, width: box.radius * 2, height: box.radius * 2 }}
      >
        {/* Pontos estáticos: somem com transição quando o canvas fica pronto (styles/live-globe.css). */}
        <span className="ds-live-globe__fallback" />
      </span>
      {Canvas && state !== 'fallback' ? (
        <Canvas
          frame={box}
          markers={markers}
          autoRotate={autoRotate}
          inView={inView}
          onReady={onReady}
          onError={onError}
        />
      ) : null}
    </span>
  );
}
