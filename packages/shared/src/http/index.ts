// `@blackshop/shared/http` — chamadas a terceiros (stories 0.8 e 18.2).
// Módulo puro (sem node:*, sem banco). O safe-fetch (usa node:dns/net) fica em
// `@blackshop/shared/http/safe-fetch`, só para servidor.
export * from './errors.js';
export { fetchWithTimeout, parseRetryAfterMs, timeoutFromEnv, type FetchWithTimeoutOptions } from './fetch-with-timeout.js';
export * from './client.js';
