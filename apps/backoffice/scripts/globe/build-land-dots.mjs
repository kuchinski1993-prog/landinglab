/* eslint-env node */
/* eslint-disable no-console */
// Story 21.2a-v3 (plano B) — gera a grade de pontos de terra do globo do canto
// (components/live/land-dots.json). Roda UMA vez, fora do bundle.
//
// Fonte: Natural Earth "land" 1:50m (domínio público), no formato TopoJSON do
// pacote `world-atlas@2` (ISC). Uso:
//   node apps/backoffice/scripts/globe/build-land-dots.mjs [land-50m.json]
// Sem argumento, baixa https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json.
//
// Grade: linhas de latitude a cada STEP graus; cada linha tem
// round(360·cos(lat)/STEP) pontos (≈ área igual), linhas ímpares deslocadas
// meio passo (padrão em "colmeia", como o do admin da Shopify). A saída é um
// bitset (1 = terra) na ordem linha → ponto, em base64. A mesma grade é
// refeita em tempo de execução por `landDotVectors()` (components/live/dot-globe.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const STEP = 0.9;
const SOURCE = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../src/components/live/land-dots.json');

/** Mesma fórmula de `landDotVectors()` em dot-globe.ts. */
function rows(step) {
  const out = [];
  const count = Math.round(180 / step);
  for (let i = 0; i < count; i += 1) {
    const lat = -90 + (i + 0.5) * (180 / count);
    const n = Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / step));
    out.push({ lat, n, shift: i % 2 ? 0.5 : 0 });
  }
  return out;
}

function decodeTopology(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
  const ring = (ids) => {
    const pts = [];
    for (const id of ids) {
      const a = id < 0 ? [...arcs[~id]].reverse() : arcs[id];
      pts.push(...(pts.length ? a.slice(1) : a));
    }
    return pts;
  };
  const rings = [];
  const walk = (g) => {
    if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
    else if (g.type === 'Polygon') g.arcs.forEach((r) => rings.push(ring(r)));
    else if (g.type === 'MultiPolygon') g.arcs.forEach((p) => p.forEach((r) => rings.push(ring(r))));
  };
  walk(topo.objects.land);
  return rings;
}

async function main() {
  const arg = process.argv[2];
  const topo = arg ? JSON.parse(readFileSync(arg, 'utf8')) : await (await fetch(SOURCE)).json();
  const rings = decodeTopology(topo);
  const edges = [];
  for (const r of rings) {
    for (let i = 0; i < r.length - 1; i += 1) {
      const [x1, y1] = r[i];
      const [x2, y2] = r[i + 1];
      if (Math.abs(x2 - x1) > 180) continue; // aresta que cruza o antimeridiano (corte do NE)
      edges.push([x1, y1, x2, y2]);
    }
  }
  const grid = rows(STEP);
  const total = grid.reduce((s, r) => s + r.n, 0);
  const bits = new Uint8Array(Math.ceil(total / 8));
  let k = 0;
  let land = 0;
  for (const { lat, n, shift } of grid) {
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if (y1 <= lat !== y2 <= lat) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    let c = 0;
    for (let j = 0; j < n; j += 1, k += 1) {
      const lon = -180 + ((j + 0.5 + shift) * 360) / n;
      while (c < xs.length && xs[c] < lon) c += 1;
      if (c % 2 === 1) {
        bits[k >> 3] |= 1 << (k & 7);
        land += 1;
      }
    }
  }
  const data = Buffer.from(bits).toString('base64');
  const json = `${JSON.stringify({ source: 'Natural Earth 1:50m land (world-atlas@2, domínio público)', step: STEP, points: total, land, data })}\n`;
  writeFileSync(OUT, json);
  console.log(`grade ${STEP}° → ${total} pontos, ${land} em terra; ${json.length} B (${gzipSync(json, { level: 9 }).length} B gzip) → ${OUT}`);
}

await main();
