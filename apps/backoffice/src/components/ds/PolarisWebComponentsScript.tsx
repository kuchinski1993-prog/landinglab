// Story 20.1 — <head> do layout raiz: rastreador de falha + o único bundle Polaris 2.
//
// `async`: telas ainda em Polaris React não esperam o CDN (se ele cair ou
// demorar, só as telas migradas mostram o estado de erro do PolarisGate).
// As telas migradas só renderizam `s-*` depois que o bundle registra os
// elementos, então não há divergência de hidratação.

import { POLARIS_WC_ERROR_TRACKER, POLARIS_WC_SCRIPT_ID, POLARIS_WC_SRC } from './polaris-loader';

export function PolarisWebComponentsScript(): JSX.Element {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: POLARIS_WC_ERROR_TRACKER }} />
      <script id={POLARIS_WC_SCRIPT_ID} src={POLARIS_WC_SRC} async />
    </>
  );
}
