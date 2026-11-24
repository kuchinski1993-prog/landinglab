'use client';

// Story 20.5f — aviso das telas DS quando "Ver na loja"/"Ver loja" está desabilitado porque o
// endereço da vitrine falta ou aponta para localhost num build de produção (lib/storefront-url.ts).

import { storefrontUrlProblemMessage, type StorefrontUrlResolution } from '@/lib/storefront-url';

export function StorefrontUrlWarning({ storefront }: { storefront: StorefrontUrlResolution }): JSX.Element | null {
  if (storefront.ok) return null;
  return (
    <s-banner tone="warning" data-testid="storefront-url-warning">
      {storefrontUrlProblemMessage(storefront.reason)}
    </s-banner>
  );
}
