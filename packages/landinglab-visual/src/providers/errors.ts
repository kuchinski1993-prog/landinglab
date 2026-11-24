// Shared error types for Squad 3 provider clients.
//
// Wave 1: stubs throw NotImplementedError.
// Wave 2 replaces com real HTTP calls (Freepik Mystic API + Higgsfield fallback).
//
// Padrão espelha packages/landinglab-copy/src/providers/errors.ts (Squad 2)
// e packages/landinglab-research/src/providers/errors.ts (Squad 1).

/** Provider not implemented — Wave 1 stub marker. Wave 2 removes throws. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what} — Wave 2 of Story 13.5 will implement`);
    this.name = 'NotImplementedError';
  }
}

/** Credential ausente no ambiente — falha na primeira invocação (não no import). */
export class ProviderConfigError extends Error {
  constructor(providerName: string, envVar: string) {
    super(
      `Provider "${providerName}" requires ${envVar} in environment. ` +
        `Set it in apps/worker/.env or export before running.`,
    );
    this.name = 'ProviderConfigError';
  }
}

/** HTTP failure genérica. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${providerName} HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'ProviderHttpError';
  }
}

/**
 * Erro específico do Freepik provider.
 * `retryable: true` para 429/5xx (retry com backoff); `false` para 4xx outros
 * (não retry — provavelmente prompt inválido ou quota esgotada).
 * Orchestrator usa `retryable` pra decidir se cai pro fallback Higgsfield.
 */
export class FreepikProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`Freepik provider error (HTTP ${statusCode}, retryable=${retryable}): ${message}`);
    this.name = 'FreepikProviderError';
  }
}

/** Erro específico do Higgsfield provider (fallback). */
export class HiggsFieldProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`Higgsfield provider error (HTTP ${statusCode}): ${message}`);
    this.name = 'HiggsFieldProviderError';
  }
}
