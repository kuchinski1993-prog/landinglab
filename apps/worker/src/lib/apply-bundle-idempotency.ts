// apply-bundle-idempotency — Utilities pra medir idempotência real do render.
//
// Fase 9A do Landing Lab Stabilization Roadmap (26/09/2026).
//
// CONTRATO IDEMPOTÊNCIA (definição correta):
//
//   output1 = render(input, data)
//   output2 = render(output1, mesmos data)
//   assertIdempotent(output1, output2)  →  SHA(output2) === SHA(output1)
//
// NÃO é medir SHA(input) === SHA(output1). Mutação legítima muda output.
// Idempotência = "aplicar 2x com os mesmos dados não continua modificando".
//
// APLICAÇÃO EM TESTES:
//   Rodar render() 2x sobre input → data. Segunda chamada deve produzir
//   output byte-idêntico ao da primeira. Se não → bug de determinismo.
//
// APLICAÇÃO EM PROD (métrica passiva, sem overhead):
//   Persistir sha256_after em landing_html_snapshots. Se próximo job com
//   os MESMOS dados ler input com aquele sha256 e produzir sha256 DIFERENTE,
//   é evidência de não-idempotência real (não regride, só sinaliza).
//
// Zero deps além de node:crypto (ESM top-level, evita bug 'require' do hotfix).

import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface IdempotencyCheck {
  ok: boolean;
  output1Sha: string;
  output2Sha: string;
  diverged: boolean;
  message?: string;
}

/**
 * Executa `render` duas vezes com o mesmo input+data e compara SHAs
 * dos dois outputs.
 *
 * Uso em testes:
 *   const result = assertRenderIdempotent(html, offers, (h, o) => processBundle(h, o));
 *   expect(result.ok).toBe(true);
 *
 * @param input        HTML de entrada.
 * @param data         Dados canônicos (offers, currency, etc). Passado
 *                     inalterado nas 2 chamadas.
 * @param renderFn     Função pura render(html, data): htmlNovo.
 * @returns            IdempotencyCheck com SHAs e verdict.
 */
export function assertRenderIdempotent<D>(
  input: string,
  data: D,
  renderFn: (html: string, data: D) => string,
): IdempotencyCheck {
  const output1 = renderFn(input, data);
  const output2 = renderFn(output1, data);
  const sha1 = sha256Hex(output1);
  const sha2 = sha256Hex(output2);
  const diverged = sha1 !== sha2;
  return {
    ok: !diverged,
    output1Sha: sha1,
    output2Sha: sha2,
    diverged,
    message: diverged
      ? `render() não é idempotente: 2ª aplicação com mesmos dados produziu SHA diferente (${sha1.slice(0, 12)} → ${sha2.slice(0, 12)})`
      : undefined,
  };
}

/**
 * Métrica passiva pra produção. Compara sha256 do output atual com o
 * sha256_after do último snapshot da mesma landing. Se os inputs (data)
 * eram idênticos, sha256 iguais = idempotente.
 *
 * NÃO usar isso pra bloquear write. É observabilidade.
 *
 * @param currentOutputSha SHA do HTML que acabou de ser gerado.
 * @param previousAfterSha SHA do sha256_after do último snapshot (nullable).
 * @param dataFingerprint  Hash dos dados canônicos (offers+currency+etc).
 * @param previousDataFingerprint Hash dos dados do job anterior (nullable).
 * @returns 'idempotent' | 'diverged' | 'no_baseline' | 'data_changed'
 */
export function classifyIdempotency(
  currentOutputSha: string,
  previousAfterSha: string | null,
  dataFingerprint: string,
  previousDataFingerprint: string | null,
): 'idempotent' | 'diverged' | 'no_baseline' | 'data_changed' {
  if (!previousAfterSha || !previousDataFingerprint) return 'no_baseline';
  if (dataFingerprint !== previousDataFingerprint) return 'data_changed';
  return currentOutputSha === previousAfterSha ? 'idempotent' : 'diverged';
}

/**
 * Fingerprint dos dados canônicos usados por apply-bundle.
 * Determinístico: mesmos dados sempre geram mesmo hash.
 *
 * IMPORTANTE: incluir SÓ os campos que afetam o render. Timestamps e IDs
 * internos são excluídos.
 */
export interface RenderDataForFingerprint {
  currency: string;
  offers: Array<{
    position: number;
    priceCents: number;
    compareAtCents: number | null;
    qty: number;
    variantId: string | null;
  }>;
}

export function fingerprintRenderData(data: RenderDataForFingerprint): string {
  // JSON.stringify + sort de offers por position pra ser determinístico
  const sorted = {
    currency: (data.currency ?? 'EUR').toUpperCase(),
    offers: [...data.offers]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({
        position: o.position,
        priceCents: o.priceCents,
        compareAtCents: o.compareAtCents ?? null,
        qty: o.qty,
        variantId: o.variantId ?? null,
      })),
  };
  return sha256Hex(JSON.stringify(sorted));
}
