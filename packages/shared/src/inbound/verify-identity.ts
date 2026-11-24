// Verificação de identidade do remetente (política DMARC-relaxed).
//
// Consolida a função que estava em apps/api/src/lib/inbound-pipeline.ts +
// cópia inline em apps/worker/src/processors/analyze-inbound.processor.ts.
// Consumidores importam de @blackshop/shared.
//
// POLÍTICA:
//   - Autenticação passa se DKIM=pass OU SPF=pass (padrão DMARC RFC 7489).
//   - spf=none é NEUTRO, não fail. Muito comum quando há forward
//     (Cloudflare Email Routing quebra SPF por design; DKIM sobrevive).
//     Também comum quando o sender não publicou SPF.
//   - Só degrada pra unknown_sender quando NENHUM sinal positivo de auth
//     existe (ambos são fail/none/ausentes) — não pune ausência de política.
//   - suspicious_claim só quando há sinal POSITIVO de mismatch: cliente
//     cita order_number cujo customer_email do pedido difere do from
//     (email normalizado). Nunca por mera ausência de SPF.
//   - Match de email usa normalização Gmail (dot + plus insensitive) via
//     `@blackshop/shared` normalize-email.ts.
//
// 4 estados preservados (mesmo enum que a UI já mostra):
//   verified_match     — from bate com orders.customer_email + auth OK
//   verified_via_order — cliente forneceu order_number cujo email bate
//   unknown_sender     — sem match a pedido ou sem auth alguma
//   suspicious_claim   — sinal positivo de mismatch (cross_check_failed)

import { emailsMatch } from './normalize-email.js';

export type VerificationState =
  | 'verified_match'
  | 'verified_via_order'
  | 'unknown_sender'
  | 'suspicious_claim';

export interface VerifyIdentityInput {
  fromAddress: string;
  spfResult: string | null | undefined;   // 'pass' | 'fail' | 'softfail' | 'none' | null
  dkimResult: string | null | undefined;  // 'pass' | 'fail' | 'none' | null
  /**
   * Lookup em `orders` já feito pelo caller. Match é por email normalizado —
   * o caller pode passar todos os pedidos cujo customer_email (normalizado)
   * bate com o from (normalizado). Array vazio quando nenhum bate.
   */
  ordersMatchingFrom: Array<{ id: string; customerEmail: string }>;
  /** Se a IA detectou um order_number no body e o caller resolveu o pedido. */
  claimedOrderId?: string | null;
  claimedOrderCustomerEmail?: string | null;
}

export interface VerifyIdentityResult {
  state: VerificationState;
  associatedOrderId: string | null;
  /**
   * Razão estruturada pra debug/log:
   *   - 'match'              → email OK + achou pedido
   *   - 'no_match'           → auth OK mas nenhum pedido bate
   *   - 'no_auth'            → sem sinal positivo de autenticação
   *   - 'cross_check_failed' → claimed_order.customer_email ≠ from (suspicious)
   */
  reason: 'match' | 'no_match' | 'no_auth' | 'cross_check_failed' | null;
}

/**
 * DMARC-relaxed identity check.
 *
 * Retorna verified_match sempre que possível pra não penalizar clientes
 * legítimos com forwards (Gmail forward zera SPF; DKIM sobrevive).
 */
export function verifyIdentity(input: VerifyIdentityInput): VerifyIdentityResult {
  const spf = input.spfResult?.toLowerCase() ?? null;
  const dkim = input.dkimResult?.toLowerCase() ?? null;

  const spfPass = spf === 'pass';
  const dkimPass = dkim === 'pass';
  const spfFail = spf === 'fail';
  const dkimFail = dkim === 'fail';

  // Passa quando qualquer mecanismo alinha (DMARC RFC 7489).
  const authOk = spfPass || dkimPass;

  // 1) suspicious_claim: sinal POSITIVO de mismatch — cliente cita um pedido
  //    cujo customer_email difere do from (normalizado). Preserva a régua
  //    "IA nunca responde suspicious".
  if (input.claimedOrderId && input.claimedOrderCustomerEmail) {
    if (!emailsMatch(input.claimedOrderCustomerEmail, input.fromAddress)) {
      return {
        state: 'suspicious_claim',
        associatedOrderId: input.claimedOrderId,
        reason: 'cross_check_failed',
      };
    }
    // Emails batem (via normalização) — se auth OK, é verified_via_order.
    if (authOk) {
      return {
        state: 'verified_via_order',
        associatedOrderId: input.claimedOrderId,
        reason: 'match',
      };
    }
    // Sem auth alguma mas order cross-check passa: degrada pra unknown com
    // vínculo ao pedido (associatedOrderId setado). Operador vê o pedido no
    // painel, mas fluxo trata como não-verificado (pede ack + info).
    if (!spfFail && !dkimFail) {
      return {
        state: 'unknown_sender',
        associatedOrderId: input.claimedOrderId,
        reason: 'no_auth',
      };
    }
  }

  // 2) Sem sinal positivo de autenticação NEM order match: unknown.
  //    Diferente do bug anterior: NÃO exigimos SPF+DKIM=pass; basta um.
  //    E ausência (none) não é fail — só sinal negativo (fail) pesa.
  if (!authOk) {
    return { state: 'unknown_sender', associatedOrderId: null, reason: 'no_auth' };
  }

  // 3) Auth OK: procura match em pedidos.
  if (input.ordersMatchingFrom.length > 0) {
    const order = input.ordersMatchingFrom[0]!;
    return { state: 'verified_match', associatedOrderId: order.id, reason: 'match' };
  }

  // 4) Auth OK mas sem pedido: unknown (não verified porque não há vínculo).
  return { state: 'unknown_sender', associatedOrderId: null, reason: 'no_match' };
}
