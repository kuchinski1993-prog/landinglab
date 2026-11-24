// @blackshop/errors — catálogo de erros PT-BR e resposta { code, message, details } (Story 18.1).
// Núcleo sem Fastify e sem banco; handler Fastify em `@blackshop/errors/fastify`.
export { AppError, isAppError, type AppErrorOptions } from './app-error.js';
export {
  buildBody,
  catalogOwner,
  defineCatalog,
  type AnyCatalog,
  type Catalog,
  type CatalogOptions,
  type ErrorBody,
  type ErrorEntries,
  type ErrorEntry,
} from './catalog.js';
export { COMMON_CATALOG, COMMON_ERRORS, type CommonErrorCode } from './common.js';
export { CAMBIO_CATALOG, CAMBIO_ERRORS, type CambioErrorCode } from './cambio.js';
export { toErrorResponse, type ErrorResponse, type ToErrorResponseOptions } from './to-response.js';
