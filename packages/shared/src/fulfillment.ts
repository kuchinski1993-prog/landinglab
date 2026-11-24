// Story 23.3 · regra pura de disponibilidade por variante ("pronta entrega enquanto houver estoque;
// depois, feita sob encomenda"). Sem I/O: API pública, carrinho, checkout e (na 23.5) o pedido usam
// ESTA função — a regra nunca é reescrita em outro lugar.
//
// Políticas (por produto):
//   stock_only               — vende só o que há em estoque. Com sellWithoutStock = vende sem limite
//                              (disponível, sem "restam"). É o padrão e o comportamento de hoje.
//   stock_then_made_to_order — pronta entrega enquanto houver; sem estoque suficiente, a LINHA
//                              inteira vira sob encomenda (decisão 74 — não divide em duas).
//   made_to_order_only       — sempre sob encomenda; ignora estoque.
// sellWithoutStock só tem efeito em stock_only (nas outras a política já diz o que fazer quando acaba).
// Estoque null (não controlado) conta como 0 — mesma leitura do ProductCard da vitrine.
// Prazo: o da variante vence o do produto; fora de 1–365 (ou não inteiro) = ausente.

export const FULFILLMENT_POLICIES = ['stock_only', 'stock_then_made_to_order', 'made_to_order_only'] as const;
export type FulfillmentPolicy = (typeof FULFILLMENT_POLICIES)[number];
export const DEFAULT_FULFILLMENT_POLICY: FulfillmentPolicy = 'stock_only';

export type Availability = 'in_stock' | 'made_to_order' | 'sold_out';

export const LEAD_TIME_MIN_DAYS = 1;
export const LEAD_TIME_MAX_DAYS = 365;

export interface FulfillmentInput {
  policy: string | null | undefined;
  sellWithoutStock: boolean | null | undefined;
  stock: number | null | undefined;
  variantLeadTimeDays?: number | null;
  productLeadTimeDays?: number | null;
}

export interface FulfillmentResult {
  availability: Availability;
  /** Unidades em estoque — só em `in_stock` com estoque contado (nunca em made_to_order/sold_out). */
  remaining: number | null;
  /** Prazo de produção em dias — só em `made_to_order`. */
  leadTimeDays: number | null;
}

/** Formato de `orders.line_items[].fulfillment` (gravado pela 23.5). Única fonte deste formato. */
export interface OrderLineFulfillmentSnapshot {
  mode: 'in_stock' | 'made_to_order';
  leadTimeDays: number | null;
}

export function isFulfillmentPolicy(value: unknown): value is FulfillmentPolicy {
  return typeof value === 'string' && (FULFILLMENT_POLICIES as readonly string[]).includes(value);
}

export function isValidLeadTimeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= LEAD_TIME_MIN_DAYS && value <= LEAD_TIME_MAX_DAYS;
}

/** Prazo resolvido: variante → produto → null. */
export function resolveLeadTimeDays(variantLeadTimeDays: number | null | undefined, productLeadTimeDays: number | null | undefined): number | null {
  if (isValidLeadTimeDays(variantLeadTimeDays)) return variantLeadTimeDays;
  if (isValidLeadTimeDays(productLeadTimeDays)) return productLeadTimeDays;
  return null;
}

function countedStock(stock: number | null | undefined): number {
  return typeof stock === 'number' && Number.isFinite(stock) && stock > 0 ? Math.trunc(stock) : 0;
}

/**
 * Disponibilidade de uma linha com `qty` unidades da variante. `qty` inválido (< 1, não inteiro)
 * conta como 1.
 */
export function resolveLineFulfillment(input: FulfillmentInput, qty: number): FulfillmentResult {
  const units = Number.isInteger(qty) && qty >= 1 ? qty : 1;
  const policy: FulfillmentPolicy = isFulfillmentPolicy(input.policy) ? input.policy : DEFAULT_FULFILLMENT_POLICY;
  const stock = countedStock(input.stock);
  const madeToOrder = (): FulfillmentResult => ({
    availability: 'made_to_order',
    remaining: null,
    leadTimeDays: resolveLeadTimeDays(input.variantLeadTimeDays, input.productLeadTimeDays),
  });

  if (policy === 'made_to_order_only') return madeToOrder();

  if (policy === 'stock_then_made_to_order') {
    return stock >= units ? { availability: 'in_stock', remaining: stock, leadTimeDays: null } : madeToOrder();
  }

  // stock_only
  if (input.sellWithoutStock === true) return { availability: 'in_stock', remaining: null, leadTimeDays: null };
  return stock >= units
    ? { availability: 'in_stock', remaining: stock, leadTimeDays: null }
    : { availability: 'sold_out', remaining: null, leadTimeDays: null };
}

/** Disponibilidade da variante para exibição (1 unidade). */
export function resolveVariantAvailability(input: FulfillmentInput): FulfillmentResult {
  return resolveLineFulfillment(input, 1);
}

/** Snapshot da linha para o pedido; `null` quando a linha está esgotada (não pode virar pedido). */
export function buildOrderLineSnapshot(result: FulfillmentResult): OrderLineFulfillmentSnapshot | null {
  if (result.availability === 'sold_out') return null;
  return { mode: result.availability, leadTimeDays: result.availability === 'made_to_order' ? result.leadTimeDays : null };
}

/**
 * Prazo obrigatório (decisão 75): política que permite encomenda precisa de prazo no produto OU em
 * todas as variantes. Produto sem variantes precisa do prazo no produto.
 */
export function isLeadTimeResolvable(
  policy: string | null | undefined,
  productLeadTimeDays: number | null | undefined,
  variantLeadTimeDays: ReadonlyArray<number | null | undefined>,
): boolean {
  if (!isFulfillmentPolicy(policy) || policy === 'stock_only') return true;
  if (isValidLeadTimeDays(productLeadTimeDays)) return true;
  return variantLeadTimeDays.length > 0 && variantLeadTimeDays.every((d) => isValidLeadTimeDays(d));
}
