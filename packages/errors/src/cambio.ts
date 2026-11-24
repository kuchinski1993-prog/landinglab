// Story 0.7c · catálogo do câmbio (guarda de câmbio e sync de preço multimoeda).
// Os códigos FX_* já são gravados com esse nome em fx_rate_history.error_code e
// fx_sync_runs.summary — por isso `prefix: ''` + `legacy: true` (nome preservado).
// Documentado em docs/architecture/erros.md (seção "Módulo `cambio`").
import { defineCatalog } from './catalog.js';

export const CAMBIO_CATALOG = defineCatalog(
  'cambio',
  {
    FX_DOUBLE_CONVERSION: {
      status: 409,
      message: 'A regra de câmbio converte para a moeda da própria loja; o preço já está nessa moeda e não é convertido de novo.',
      legacy: true,
    },
  },
  { prefix: '' }
);

export const CAMBIO_ERRORS = CAMBIO_CATALOG.entries;
export type CambioErrorCode = Extract<keyof typeof CAMBIO_ERRORS, string>;
