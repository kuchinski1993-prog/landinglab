// GET HTTP(S) protegido contra SSRF para o import inteligente (recursos externos e "Importar de um link").
// Story 18.2: a implementação mora em packages/shared/src/http/safe-fetch.ts (`@blackshop/shared/http/safe-fetch`),
// sem mudança de comportamento; este arquivo só reexporta — nenhum import do VSL muda.
// Caminho relativo (não '@blackshop/shared/...'): entra no bundle Vercel do vsl-storefront, que só empacota
// fontes de workspace por caminho relativo (commit 488edfef; mesmo padrão de errors.ts).
export {
  SAFE_FETCH_USER_AGENT,
  SafeFetchError,
  parsePublicHttpUrl,
  safeFetch,
  type SafeFetchFailure,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SafeFetcher,
} from '../../shared/src/http/safe-fetch.js';
