'use client';

// @ds-migrated — Story 21.2a-v3: o globo do admin da Shopify, encaixado no
// canto superior direito e cortado pelas bordas — só o quadrante
// inferior-esquerdo da esfera aparece. Um componente, dois usos (Início e
// login); o enquadramento (contêiner, âncora, escalas por largura, sumir em
// telas estreitas) mora aqui e em styles/live-globe.css (`.ds-corner-globe`).
//
// Decorativo: `aria-hidden`, `pointer-events: none`, fora do Tab, atrás do
// conteúdo (quem usa põe o conteúdo em `z-index: 1`).

import { LiveGlobe, type LiveGlobeFrame, type LiveGlobeMarker } from './LiveGlobe';

/**
 * Contêiner visível (px CSS, a 1x) e esfera. Alvo da story: Ø 550 (±5 %), centro a
 * 17 (±12) px da borda direita e 75 (±12) px do topo; calibrado por correlação
 * dos pontos com o recorte da Shopify → Ø 532, centro a 22 px da direita e 70 px do topo.
 */
export const CORNER_GLOBE_FRAME: LiveGlobeFrame = { width: 340, height: 400, cx: 340 - 22, cy: 70, radius: 266 };

export type CornerGlobeVariant = 'light' | 'dark';
/** `home`: some ≤ 768 px · `login`: some < 640 px (styles/live-globe.css). */
export type CornerGlobePlacement = 'home' | 'login';

const NO_MARKERS: LiveGlobeMarker[] = [];

export interface CornerGlobeProps {
  /** `light` = esfera clara e pontos cinza-escuros (fundo branco) · `dark` = esfera escura sutil e pontos claros (fundo escuro). */
  variant?: CornerGlobeVariant;
  placement: CornerGlobePlacement;
  markers?: LiveGlobeMarker[];
}

export function CornerGlobe({ variant = 'light', placement, markers = NO_MARKERS }: CornerGlobeProps): JSX.Element {
  return (
    <div
      className={`ds-corner-globe ds-corner-globe--${placement} ds-corner-globe--${variant}`}
      aria-hidden="true"
      data-testid="corner-globe"
      data-variant={variant}
    >
      <LiveGlobe decorative size={CORNER_GLOBE_FRAME.width} frame={CORNER_GLOBE_FRAME} markers={markers} />
    </div>
  );
}
