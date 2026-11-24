// Provider error taxonomy (Story 13.8 — Squad 5, AC11).
//
// Two categories, mirrored from packages/landinglab-build/src/providers/claude-haiku.ts:
//   - ProviderConfigError: missing env / bad config → NOT retryable, surface to
//     operator via backoffice error banner ("contact ops"). BullMQ MUST NOT retry.
//   - ProviderRetryableError: transient HTTP failure (5xx, rate limit, timeout)
//     → orchestrator applies bounded retry (see AC13/AC14). If retries exhaust,
//     converts to publish_failed with descriptive error_reason.

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export class ProviderRetryableError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderRetryableError';
  }
}

/** Thrown by Wave 1 stubs — signals downstream code that real impl lands in Wave 2. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} — real implementation lands in Wave 2 (Story 13.8)`);
    this.name = 'NotImplementedError';
  }
}
