// Timeout interno do SSE stream. Deve disparar ANTES do Vercel matar a função
// (maxDuration=300s), garantindo que o cliente receba um evento 'aborted' com
// mensagem útil antes do fechamento abrupto que causa ev.data=null no EventSource.
export const STREAM_MAX_DURATION_S = 300;
export const STREAM_TIMEOUT_MS = STREAM_MAX_DURATION_S * 1000 - 10_000; // 290 000ms
