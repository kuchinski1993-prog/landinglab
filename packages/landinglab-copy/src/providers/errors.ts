// Shared error types for Squad 2 provider clients.
//
// Wave 1: stubs throw NotImplementedError.
// Wave 2 replaces com real Claude Opus calls.
//
// Padrão espelha packages/landinglab-research/src/providers/errors.ts (Squad 1).

/** Provider not implemented — Wave 1 stub marker. Wave 2 removes throws. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what} — Wave 2 of Story 13.4 will implement`);
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

/** HTTP failure. */
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
