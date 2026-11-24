// @ds-migrated — Story 21.2a-v3 (plano B): globo de pontos em canvas 2D, no
// desenho do admin da Shopify — países em pontinhos sobre uma esfera que é só
// CSS (styles/live-globe.css). Substitui o `cobe` (ver Dev Agent Record da
// story: o shader do `cobe` 2.0.1 limita a grade a ~32 k pontos, fixa o
// tamanho do ponto e ilumina a esfera ao contrário da referência).
//
// Mesma forma de uso do `cobe`: `createDotGlobe(canvas, opções)` desenha 1
// quadro; `update(parcial)` redesenha; `destroy()` solta o canvas. O laço de
// rotação continua em LiveGlobeCanvas.tsx.
//
// A grade de terra vem de land-dots.json (scripts/globe/build-land-dots.mjs):
// linhas de latitude a cada `step` graus, round(360·cos(lat)/step) pontos por
// linha, linhas ímpares deslocadas meio passo; bitset em base64 (1 = terra).

import landDots from './land-dots.json';

export type Rgb = [number, number, number];

export interface DotGlobeMarker {
  location: [number, number];
  size: number;
}

export interface DotGlobeOptions {
  /** Caixa do canvas em px CSS. */
  width: number;
  height: number;
  devicePixelRatio: number;
  /** Centro e raio da esfera em px CSS, relativos à caixa (pode sair da caixa). */
  cx: number;
  cy: number;
  radius: number;
  /** Rotação em torno do eixo da Terra (rad); 0 = meridiano de Greenwich de frente. */
  phi: number;
  /** Inclinação (rad): latitude que fica no centro do disco. */
  theta: number;
  /** Cor dos pontos (0–1) e opacidade máxima. */
  dotColor: Rgb;
  dotOpacity: number;
  /** Lado do ponto em px CSS. */
  dotSize: number;
  markers: DotGlobeMarker[];
  markerColor: Rgb;
}

export interface DotGlobe {
  update: (state: Partial<DotGlobeOptions>) => void;
  destroy: () => void;
}

/** Níveis de opacidade (os pontos somem perto da borda, como na referência). */
const LEVELS = 8;
/** Os pontos chegam à opacidade cheia a partir desta "profundidade" (z) na esfera. */
const FADE_Z = 0.5;

let cachedDots: Float32Array | null = null;

/** Vetores unitários (x, y, z) dos pontos de terra; decodificado uma vez. */
export function landDotVectors(): Float32Array {
  if (cachedDots) return cachedDots;
  const bin = atob(landDots.data);
  const out = new Float32Array(landDots.land * 3);
  const count = Math.round(180 / landDots.step);
  let k = 0;
  let o = 0;
  for (let i = 0; i < count; i += 1) {
    const lat = ((-90 + (i + 0.5) * (180 / count)) * Math.PI) / 180;
    const n = Math.max(1, Math.round((360 * Math.cos(lat)) / landDots.step));
    const shift = i % 2 ? 0.5 : 0;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let j = 0; j < n; j += 1, k += 1) {
      if (!((bin.charCodeAt(k >> 3) >> (k & 7)) & 1)) continue;
      const lon = (-Math.PI + ((j + 0.5 + shift) * 2 * Math.PI) / n);
      out[o++] = cosLat * Math.sin(lon);
      out[o++] = sinLat;
      out[o++] = cosLat * Math.cos(lon);
    }
  }
  cachedDots = o === out.length ? out : out.subarray(0, o);
  return cachedDots;
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(3)})`;
}

export function createDotGlobe(canvas: HTMLCanvasElement, initial: DotGlobeOptions): DotGlobe {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sem contexto 2D');
  const opts: DotGlobeOptions = { ...initial };
  const dots = landDotVectors();
  const count = dots.length / 3;
  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const level = new Uint8Array(count);

  const resize = (): void => {
    canvas.width = Math.round(opts.width * opts.devicePixelRatio);
    canvas.height = Math.round(opts.height * opts.devicePixelRatio);
  };

  const draw = (): void => {
    const { width, height, devicePixelRatio: dpr, cx, cy, radius, phi, theta, dotSize } = opts;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const half = dotSize / 2;
    const used = new Uint8Array(LEVELS + 1);
    for (let i = 0, d = 0; i < count; i += 1, d += 3) {
      const x = dots[d]!;
      const y = dots[d + 1]!;
      const z = dots[d + 2]!;
      const x1 = x * cp + z * sp;
      const z1 = z * cp - x * sp;
      const y2 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      level[i] = 0;
      if (z2 <= 0.02) continue;
      const px = cx + radius * x1;
      const py = cy - radius * y2;
      if (px < -dotSize || py < -dotSize || px > width + dotSize || py > height + dotSize) continue;
      const lv = Math.max(1, Math.ceil(Math.min(1, z2 / FADE_Z) ** 1.6 * LEVELS));
      level[i] = lv;
      used[lv] = 1;
      sx[i] = px - half;
      sy[i] = py - half;
    }
    for (let lv = 1; lv <= LEVELS; lv += 1) {
      if (!used[lv]) continue;
      ctx.fillStyle = rgba(opts.dotColor, (opts.dotOpacity * lv) / LEVELS);
      ctx.beginPath();
      for (let i = 0; i < count; i += 1) if (level[i] === lv) ctx.rect(sx[i]!, sy[i]!, dotSize, dotSize);
      ctx.fill();
    }
    if (opts.markers.length) drawMarkers(cp, sp, ct, st);
  };

  const drawMarkers = (cp: number, sp: number, ct: number, st: number): void => {
    ctx.fillStyle = rgba(opts.markerColor, 1);
    for (const m of opts.markers) {
      const lat = (m.location[0] * Math.PI) / 180;
      const lon = (m.location[1] * Math.PI) / 180;
      const x = Math.cos(lat) * Math.sin(lon);
      const y = Math.sin(lat);
      const z = Math.cos(lat) * Math.cos(lon);
      const x1 = x * cp + z * sp;
      const z1 = z * cp - x * sp;
      const y2 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      if (z2 <= 0) continue;
      ctx.beginPath();
      ctx.arc(opts.cx + opts.radius * x1, opts.cy - opts.radius * y2, Math.max(2, m.size * opts.radius), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  resize();
  draw();

  return {
    update(state) {
      const resized = (state.width !== undefined && state.width !== opts.width) || (state.height !== undefined && state.height !== opts.height);
      Object.assign(opts, state);
      if (resized) resize();
      draw();
    },
    destroy() {
      // Solta o "backing store" do canvas já (não espera o GC).
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
