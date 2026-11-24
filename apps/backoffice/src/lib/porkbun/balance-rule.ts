// Story 13.10 (AC6) — regra pura do saldo (importável no client e no server).
//
//   - saldo AO VIVO < preço → BLOQUEIA a compra;
//   - só o ÚLTIMO SALDO CONHECIDO < preço → apenas AVISA (pode estar
//     desatualizado; a Porkbun é a árbitra final).

export type BalanceSource = 'live' | 'last_known' | 'none';

export interface BalanceView {
  source: BalanceSource;
  balanceCents: number | null;
  /** ISO — momento da leitura (ao vivo) ou da última compra (último conhecido). */
  at: string | null;
}

function formatUsd(cents: number): string {
  return `US$ ${(cents / 100).toFixed(2)}`;
}

export interface BalanceVerdict {
  blocked: boolean;
  /** Mensagem para o operador (bloqueio ou aviso). */
  message: string | null;
}

/** Aplica a regra bloqueia (ao vivo) × avisa (último conhecido). */
export function evaluateBalance(view: BalanceView, priceCents: number): BalanceVerdict {
  if (view.balanceCents === null || view.source === 'none') {
    return {
      blocked: false,
      message: 'Saldo Porkbun desconhecido — confira em porkbun.com antes de comprar.',
    };
  }
  if (view.balanceCents >= priceCents) return { blocked: false, message: null };
  if (view.source === 'live') {
    return {
      blocked: true,
      message: `Saldo Porkbun insuficiente: ${formatUsd(view.balanceCents)} disponível, compra custa ${formatUsd(priceCents)}. Adicione crédito em porkbun.com/account/credit.`,
    };
  }
  return {
    blocked: false,
    message: `O último saldo conhecido (${formatUsd(view.balanceCents)}) é menor que o preço (${formatUsd(priceCents)}). Pode estar desatualizado — a Porkbun recusa a compra se faltar saldo.`,
  };
}
