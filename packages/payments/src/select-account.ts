// Seleção da conta Stripe que vai cobrar (Story 15.1, AC6 — spec D2).
//
// Regra: entre as contas ativas, a de menor prioridade cujo volume do dia
// ainda está abaixo do limite. Se todas passaram do limite, continua na de
// menor prioridade e sinaliza overLimit (owner é notificado e pausa a campanha).

export interface StripeAccountCandidate {
  id: string;
  priority: number;
  status: string;
  /** Unidade mínima da moeda de saque. null = sem limite. */
  dailyLimitMinor: number | null;
  /** Volume pago hoje na moeda de saque. */
  volumeTodayMinor: number;
}

export interface StripeAccountSelection<T extends StripeAccountCandidate> {
  account: T;
  overLimit: boolean;
}

function underLimit(account: StripeAccountCandidate): boolean {
  return account.dailyLimitMinor === null || account.volumeTodayMinor < account.dailyLimitMinor;
}

export function selectStripeAccount<T extends StripeAccountCandidate>(
  accounts: readonly T[],
): StripeAccountSelection<T> | null {
  const active = accounts
    .filter((a) => a.status === 'active')
    .sort((a, b) => a.priority - b.priority);

  const first = active[0];
  if (!first) return null;

  const available = active.find(underLimit);
  if (available) return { account: available, overLimit: false };

  return { account: first, overLimit: true };
}
