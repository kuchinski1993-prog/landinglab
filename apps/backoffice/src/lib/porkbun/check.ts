// Story 13.10 (AC5) — checagem de candidatos respeitando o rate limit da Porkbun.
//
// Estratégia (registrada na story):
//   1. Um único POST /domain/checkDomain em lote (≤ 25 domínios; orçamento
//      próprio de 200 domínios/60 s — bem acima do single de 10/10 s).
//   2. 429 no lote: se Retry-After ≤ 5 s, espera e tenta UMA vez; senão
//      devolve os candidatos como "indeterminado" (rateLimited=true).
//   3. Outro erro no lote: fallback para checagens individuais, sequenciais
//      com concorrência 2 e no máx. 10 domínios; 429 interrompe o restante.
//   4. Falha de uma checagem vira "indeterminado" — nunca derruba a lista.

import {
  checkDomain,
  checkDomainsBulk,
  PorkbunRateLimitError,
  unknownQuote,
  type DomainQuote,
  type PorkbunCredentials,
} from './client';

export const MAX_RETRY_WAIT_SEC = 5;
export const SINGLE_FALLBACK_MAX = 10;
export const SINGLE_FALLBACK_CONCURRENCY = 2;

export interface CheckOutcome {
  quotes: DomainQuote[];
  rateLimited: boolean;
  retryAfterSec: number | null;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMIT_REASON = 'Limite de consultas da Porkbun — tente de novo em instantes';

export async function checkCandidates(
  creds: PorkbunCredentials,
  domains: string[],
  sleep: Sleep = defaultSleep,
): Promise<CheckOutcome> {
  if (domains.length === 0) return { quotes: [], rateLimited: false, retryAfterSec: null };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const quotes = await checkDomainsBulk(creds, domains);
      return { quotes, rateLimited: false, retryAfterSec: null };
    } catch (err) {
      if (err instanceof PorkbunRateLimitError) {
        const wait = err.retryAfterSec;
        if (attempt === 0 && wait !== null && wait <= MAX_RETRY_WAIT_SEC) {
          await sleep(wait * 1000);
          continue;
        }
        return {
          quotes: domains.map((d) => unknownQuote(d, RATE_LIMIT_REASON)),
          rateLimited: true,
          retryAfterSec: wait,
        };
      }
      break; // erro não-429 → fallback individual
    }
  }

  return checkIndividually(creds, domains);
}

async function checkIndividually(
  creds: PorkbunCredentials,
  domains: string[],
): Promise<CheckOutcome> {
  const targets = domains.slice(0, SINGLE_FALLBACK_MAX);
  const results = new Map<string, DomainQuote>();
  let rateLimited = false;
  let retryAfterSec: number | null = null;
  let next = 0;

  async function worker(): Promise<void> {
    while (!rateLimited && next < targets.length) {
      const domain = targets[next]!;
      next += 1;
      try {
        results.set(domain, await checkDomain(creds, domain));
      } catch (err) {
        if (err instanceof PorkbunRateLimitError) {
          rateLimited = true;
          retryAfterSec = err.retryAfterSec;
          results.set(domain, unknownQuote(domain, RATE_LIMIT_REASON));
        } else {
          results.set(domain, unknownQuote(domain, 'Falha na consulta — tente de novo'));
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SINGLE_FALLBACK_CONCURRENCY, targets.length) }, () => worker()),
  );

  const quotes = domains.map(
    (d) =>
      results.get(d) ??
      unknownQuote(d, rateLimited ? RATE_LIMIT_REASON : 'Não consultado (limite de consultas)'),
  );
  return { quotes, rateLimited, retryAfterSec };
}
