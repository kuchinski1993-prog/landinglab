// Story 18.3b · plano de sincronização de variantes na republicação (retry com `existingProductGid`).
// Função PURA: casa cada variante do payload com no máximo uma variante remota e decide o que
// atualizar, criar e remover — antes de qualquer escrita na Shopify. Regras, na ordem:
//   R1 · `mirrorVariantId` (com ou sem `gid://`) existe no remoto → casou.
//   R2 · sem vínculo (ou vínculo que não existe mais): mesma combinação de opções normalizada
//        (lowercase, sem espaço/_/-, 3 posições — a MESMA normalização do publish.processor),
//        única dos dois lados → casou.
//   R3 · 1 variante nos dois lados, sem casamento por R1/R2 → casou ("Default Title").
//   R4 · resto do payload = criar; resto do remoto = órfão (remover).
// Órfã só é removível se for do BlackShop (QA 18.3b): SKU da MESMA família do payload (`BS-xxxxxx-NNN`,
// mesmo radical sem o serial). Variante criada à mão só na Shopify (SKU vazio/outro) → plano recusado.
// Ambiguidade nunca vira chute: o plano é recusado (ShopifyVariantPlanError) sem escrever nada.

import type { ShopifyVariantInput } from './adapter.interface.js';

export type ShopifyVariantPlanErrorCode =
  | 'shopify.variant_plan_duplicate_mirror'
  | 'shopify.variant_plan_remote_truncated'
  | 'shopify.variant_plan_no_match'
  | 'shopify.variant_plan_ambiguous'
  | 'shopify.variant_plan_foreign_orphan';

/** Plano recusado: nenhuma mutação foi enviada à Shopify. Mensagem em português, sem token nem URL. */
export class ShopifyVariantPlanError extends Error {
  readonly code: ShopifyVariantPlanErrorCode;

  constructor(code: ShopifyVariantPlanErrorCode, detail: string) {
    super(`Plano de variantes recusado (${code}): ${detail} Nada foi alterado na Shopify.`);
    this.name = 'ShopifyVariantPlanError';
    this.code = code;
  }
}

export interface RemoteVariantState {
  /** Id numérico (sem `gid://`). */
  id: string;
  /** Valores de `selectedOptions`, na ordem das opções do produto. */
  options: string[];
  /** SKU da variante na Shopify (ausente = desconhecido → nunca removida automaticamente). */
  sku?: string | null;
}

export interface VariantSyncPlan {
  /** Casadas: índice no payload ↔ id remoto, na ordem do payload. */
  update: Array<{ index: number; remoteId: string }>;
  /** Índices do payload a criar, na ordem do payload. */
  create: number[];
  /** Ids remotos órfãos (sem par no payload), na ordem do remoto. */
  remove: string[];
  /** Um item por variante do payload, na ordem do payload; `remoteId: null` = será criada. */
  ordered: Array<{ index: number; remoteId: string | null }>;
}

const VARIANT_GID = 'gid://shopify/ProductVariant/';

const stripVariantGid = (id: string): string => (id.startsWith(VARIANT_GID) ? id.slice(VARIANT_GID.length) : id);

/** Mesma normalização do publish.processor (casamento por opções do snapshot). */
export const normalizeOption = (v: string | null | undefined): string => (v ? v.toLowerCase().replace(/[\s_-]+/g, '') : '');

const optionKey = (values: ReadonlyArray<string | null | undefined>): string => [0, 1, 2].map((i) => normalizeOption(values[i])).join('|');

// Radical do SKU sem o serial final: `BS-abc123-002` → `BS-abc123`. Sem serial → null.
const skuStem = (sku: string | null | undefined): string | null => {
  const m = /^(.+)-\d+$/.exec((sku ?? '').trim());
  return m ? m[1]! : null;
};

/** Radical comum a TODOS os SKUs do payload (a família de SKUs do produto no BlackShop), ou null. */
export function ownedSkuStem(payload: readonly ShopifyVariantInput[]): string | null {
  const stems = new Set(payload.map((v) => skuStem(v.sku)));
  if (stems.size !== 1) return null;
  const [stem] = [...stems];
  return stem ?? null;
}

/** O chamador conhece o vínculo quando pelo menos uma variante traz o campo (mesmo `null`). */
export function payloadKnowsMirror(variants: readonly ShopifyVariantInput[]): boolean {
  return variants.some((v) => v.mirrorVariantId !== undefined);
}

export function planVariantSync(
  remote: readonly RemoteVariantState[],
  payload: readonly ShopifyVariantInput[],
  opts: {
    remoteHasNextPage?: boolean;
    /** Recusa o plano se alguma órfã não for do BlackShop (padrão true; o adapter passa `removeOrphans`). */
    refuseForeignOrphans?: boolean;
  } = {},
): VariantSyncPlan {
  if (opts.remoteHasNextPage) {
    throw new ShopifyVariantPlanError(
      'shopify.variant_plan_remote_truncated',
      'o produto tem mais de 100 variantes na Shopify e a leitura veio incompleta — o plano seria feito sobre uma lista parcial. ' +
        'Reduza as variantes do produto na Shopify para no máximo 100 e publique de novo.',
    );
  }

  // (a) duas variantes do payload com o mesmo vínculo.
  const seenMirror = new Map<string, number>();
  payload.forEach((v, index) => {
    if (!v.mirrorVariantId) return;
    const id = stripVariantGid(v.mirrorVariantId);
    if (seenMirror.has(id)) {
      throw new ShopifyVariantPlanError(
        'shopify.variant_plan_duplicate_mirror',
        `as variantes ${seenMirror.get(id)! + 1} e ${index + 1} do produto apontam para a mesma variante da Shopify (${id}). ` +
          'Corrija o vínculo de uma delas (republicar sem vínculo deixa o casamento por opções resolver) e publique de novo.',
      );
    }
    seenMirror.set(id, index);
  });

  const matchOf = new Map<number, string>(); // payload index → remote id
  const usedRemote = new Set<string>();
  const remoteIds = new Set(remote.map((r) => r.id));

  // R1 · vínculo.
  payload.forEach((v, index) => {
    if (!v.mirrorVariantId) return;
    const id = stripVariantGid(v.mirrorVariantId);
    if (remoteIds.has(id) && !usedRemote.has(id)) {
      matchOf.set(index, id);
      usedRemote.add(id);
    }
  });

  // R2 · opções normalizadas, únicas dos dois lados (entre as ainda não casadas).
  const freePayload = payload.map((_, i) => i).filter((i) => !matchOf.has(i));
  const freeRemote = remote.filter((r) => !usedRemote.has(r.id));
  const payloadByKey = new Map<string, number[]>();
  for (const i of freePayload) {
    const key = optionKey(payload[i]!.optionValues ?? []);
    payloadByKey.set(key, [...(payloadByKey.get(key) ?? []), i]);
  }
  const remoteByKey = new Map<string, RemoteVariantState[]>();
  for (const r of freeRemote) {
    const key = optionKey(r.options);
    remoteByKey.set(key, [...(remoteByKey.get(key) ?? []), r]);
  }
  for (const [key, indexes] of payloadByKey) {
    const candidates = remoteByKey.get(key);
    if (!candidates || key === '||') continue;
    if (indexes.length > 1 || candidates.length > 1) {
      throw new ShopifyVariantPlanError(
        'shopify.variant_plan_ambiguous',
        `${indexes.length} variante(s) do produto e ${candidates.length} variante(s) da Shopify têm a mesma combinação de opções ` +
          `(${key.split('|').filter(Boolean).join(' / ')}) e não há vínculo que as diferencie. ` +
          'Deixe cada combinação de opções única no produto e publique de novo.',
      );
    }
    matchOf.set(indexes[0]!, candidates[0]!.id);
    usedRemote.add(candidates[0]!.id);
  }

  // R3 · 1 variante nos dois lados.
  if (payload.length === 1 && remote.length === 1 && matchOf.size === 0) {
    matchOf.set(0, remote[0]!.id);
    usedRemote.add(remote[0]!.id);
  }

  // (c) nada casa num produto de várias variantes: recriar tudo seria destrutivo.
  if (matchOf.size === 0 && payload.length > 0 && remote.length > 0 && (payload.length > 1 || remote.length > 1)) {
    throw new ShopifyVariantPlanError(
      'shopify.variant_plan_no_match',
      `nenhuma das ${payload.length} variante(s) do produto casa com as ${remote.length} variante(s) da Shopify (nem por vínculo, nem por opções) — ` +
        'recriar todas apagaria o catálogo da Shopify. Confira os vínculos e as opções das variantes e publique de novo.',
    );
  }

  // Órfã que não é do BlackShop (criada à mão só na Shopify): nunca apagar — recusa sem escrever.
  const orphans = remote.filter((r) => !usedRemote.has(r.id));
  if (opts.refuseForeignOrphans !== false && orphans.length > 0) {
    const stem = ownedSkuStem(payload);
    const foreign = orphans.filter((r) => stem === null || skuStem(r.sku) !== stem);
    if (foreign.length > 0) {
      throw new ShopifyVariantPlanError(
        'shopify.variant_plan_foreign_orphan',
        `a(s) variante(s) ${foreign.map((r) => r.id).join(', ')} existe(m) na Shopify, não está(ão) no produto e o SKU não é da família ` +
          `deste produto no BlackShop${stem ? ` (${stem}-NNN)` : ''} — provavelmente criada(s) à mão na Shopify, por isso não será(ão) apagada(s). ` +
          'Remova-a(s) na Shopify (ou cadastre-a(s) no produto do BlackShop) e publique de novo.',
      );
    }
  }

  // R4 · resto.
  const ordered = payload.map((_, index) => ({ index, remoteId: matchOf.get(index) ?? null }));
  return {
    update: ordered.filter((o): o is { index: number; remoteId: string } => o.remoteId !== null),
    create: ordered.filter((o) => o.remoteId === null).map((o) => o.index),
    remove: orphans.map((r) => r.id),
    ordered,
  };
}
