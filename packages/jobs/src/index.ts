// @blackshop/jobs — padrão de job durável (Story 18.3). Núcleo: classificação, política de retry,
// tipos e erros. Subcaminhos: ./store, ./worker, ./producer, ./gc, ./testing.
// Guia: docs/architecture/jobs-duraveis.md
export { classifyJobError, UNCLASSIFIED_CODE, type ClassifyOptions, type ProcessorClassifier } from './classify.js';
export { RetryPolicy, type AttemptInfo, type RetryDecision } from './retry-policy.js';
export { DeterministicJobError, JobEnqueueError, JobThrewNonError, TransientJobError } from './errors.js';
export {
  JOB_ERROR_ENTRIES,
  JOB_ERRORS,
  LOJA_JOB_ERRORS,
  MARKETING_JOB_ERRORS,
  type JobErrorCode,
  type LojaJobErrorCode,
  type MarketingJobErrorCode,
} from './catalog.js';
export { LAST_ERROR_MAX, messageOf, sanitizeErrorText } from './sanitize.js';
export {
  ACTIVE_STATES,
  JOB_RUN_STATES,
  TERMINAL_STATES,
  type JobErrorClassification,
  type JobErrorKind,
  type JobRun,
  type JobRunKey,
  type JobRunState,
} from './types.js';
