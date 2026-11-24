'use client';

// @ds-migrated — Story 21.2a / 21.2a-v3: o desenho do globo (carregado tarde
// por `import()` a partir de LiveGlobe.tsx — fica num chunk próprio, junto com
// a grade de pontos de terra).
//
// • v3 (plano B): canvas 2D próprio (dot-globe.ts) no lugar do `cobe` — pontos
//   de países no desenho do admin da Shopify; a esfera (sombreado) é CSS.
// • Cada `globe.update()` desenha 1 quadro. O laço (`requestAnimationFrame`) é
//   nosso e só roda se `autoRotate`, sem "reduzir movimento", com a aba
//   visível e o globo na tela. O estado vai em `data-globe-motion`
//   (static | paused | animating).
// • O canvas é criado aqui (fora do React).
// • Cores e tamanho do ponto vêm dos tokens `--ds-live-globe-*`
//   (styles/live-globe.css) — a variante escura do CornerGlobe só troca tokens.

import { useEffect, useRef } from 'react';

import { createDotGlobe, type DotGlobe, type DotGlobeOptions, type Rgb } from './dot-globe';
import { usePageVisible } from './use-page-visible';
import { useReducedMotion } from './use-reduced-motion';

export interface LiveGlobeMarker {
  location: [number, number];
  size: number;
}

/** Caixa do canvas e esfera (centro/raio) em px CSS. */
export interface LiveGlobeFrame {
  width: number;
  height: number;
  cx: number;
  cy: number;
  radius: number;
}

export const MAX_DEVICE_PIXEL_RATIO = 2;
/** Radianos por milissegundo (~1 volta a cada 63 s). */
export const ROTATION_SPEED = 0.0001;
/** Começa com as Américas de frente (longitude ≈ −47°, latitude ≈ 29° no centro — ajustado por correlação com o print da Shopify). */
export const INITIAL_PHI = 0.82;
/** Latitude no centro do disco (rad). */
export const INITIAL_THETA = 0.5;

export interface LiveGlobeCanvasProps {
  frame: LiveGlobeFrame;
  markers: LiveGlobeMarker[];
  autoRotate: boolean;
  /** Globo visível na tela (IntersectionObserver do wrapper). */
  inView: boolean;
  onReady: () => void;
  onError: () => void;
}

export type LiveGlobeMotion = 'animating' | 'paused' | 'static';

export function parseCssColor(raw: string): Rgb | null {
  const value = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(1, Number(n) / 255)) as Rgb;
  return null;
}

function cssNumber(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const n = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

function cssColor(style: CSSStyleDeclaration, name: string, fallback: Rgb): Rgb {
  return parseCssColor(style.getPropertyValue(name)) ?? fallback;
}

export function globeDevicePixelRatio(): number {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.min(dpr, MAX_DEVICE_PIXEL_RATIO);
}

export function globeOptions(host: HTMLElement, frame: LiveGlobeFrame, markers: LiveGlobeMarker[]): DotGlobeOptions {
  const style = getComputedStyle(host);
  return {
    ...frame,
    devicePixelRatio: globeDevicePixelRatio(),
    phi: INITIAL_PHI,
    theta: cssNumber(style, '--ds-live-globe-theta', INITIAL_THETA),
    dotColor: cssColor(style, '--ds-live-globe-dot', [0.2, 0.2, 0.2]),
    dotOpacity: cssNumber(style, '--ds-live-globe-dot-opacity', 1),
    dotSize: cssNumber(style, '--ds-live-globe-dot-size', 1.3),
    markerColor: cssColor(style, '--ds-live-globe-marker', [0.21, 0.98, 0.63]),
    markers,
  };
}

export default function LiveGlobeCanvas({
  frame,
  markers,
  autoRotate,
  inView,
  onReady,
  onError,
}: LiveGlobeCanvasProps): JSX.Element {
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const animates = autoRotate && !reducedMotion;
  const running = animates && pageVisible && inView;
  const motion: LiveGlobeMotion = !animates ? 'static' : running ? 'animating' : 'paused';
  const hostRef = useRef<HTMLSpanElement>(null);
  const globeRef = useRef<DotGlobe | null>(null);
  const phiRef = useRef(INITIAL_PHI);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const { width, height, cx, cy, radius } = frame;

  // Cria / recria o globo (só quando a caixa ou a esfera mudam).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const box = { width, height, cx, cy, radius };
    const canvas = document.createElement('canvas');
    canvas.className = 'ds-live-globe__canvas';
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    host.appendChild(canvas);

    let globe: DotGlobe;
    try {
      globe = createDotGlobe(canvas, { ...globeOptions(host, box, markersRef.current), phi: phiRef.current });
    } catch (err) {
      console.warn('[LiveGlobe] globo indisponível, usando a versão estática.', err);
      host.replaceChildren();
      callbacks.current.onError();
      return undefined;
    }

    globeRef.current = globe;
    callbacks.current.onReady();

    return () => {
      globe.destroy();
      globeRef.current = null;
      host.replaceChildren();
    };
  }, [width, height, cx, cy, radius]);

  // Marcadores (21.2c) sem recriar o globo.
  useEffect(() => {
    globeRef.current?.update({ markers });
  }, [markers]);

  // Laço de rotação: só existe enquanto `running`.
  useEffect(() => {
    if (!running) return undefined;
    let raf = 0;
    let last: number | null = null;
    const tick = (now: number): void => {
      const elapsed = last === null ? 0 : Math.min(now - last, 64);
      last = now;
      phiRef.current += elapsed * ROTATION_SPEED;
      globeRef.current?.update({ phi: phiRef.current });
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [running]);

  return <span ref={hostRef} className="ds-live-globe__host" data-globe-motion={motion} />;
}
