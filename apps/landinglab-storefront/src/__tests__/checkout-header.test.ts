// Story 15.7 — header do checkout com logo (3 alinhamentos), fallback para o
// nome da marca e quadro neutro no resumo quando não há imagem enviada.
import { checkoutStrings } from '@blackshop/payments/checkout-i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { headerBrandOf } from '../app/checkout/brand';
import { CheckoutHeader } from '../app/checkout/CheckoutShell';
import { OrderSummary } from '../app/checkout/OrderSummary';

const LOGO = 'https://proj.supabase.co/storage/v1/object/public/cloned-landings/landings/l/l/logo.png';

function header(view: Parameters<typeof headerBrandOf>[0]): string {
  return renderToStaticMarkup(createElement(CheckoutHeader, { brand: headerBrandOf(view) }));
}

describe('CheckoutHeader — logo', () => {
  it.each(['left', 'center', 'right'] as const)('renderiza o logo alinhado à %s com altura configurada e alt = marca', (align) => {
    const html = header({ brandName: 'Aurivita', brand: { name: 'Aurivita', logoUrl: LOGO, logoHeight: 48, logoAlign: align } });
    expect(html).toContain(`data-align="${align}"`);
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain('alt="Aurivita"');
    expect(html).toContain('--ll-logo-h:48px');
    // A sacola continua no header em todas as posições.
    expect(html).toContain('<svg');
    // Com logo, o nome não é repetido como texto.
    expect(html).not.toMatch(/data-ll-checkout-brand="">Aurivita</);
  });

  it('sem logo: mostra o nome da marca à esquerda, como antes', () => {
    const html = header({ brandName: 'Aurivita', brand: { name: 'Aurivita', logoUrl: null, logoHeight: 32, logoAlign: 'center' } });
    expect(html).toContain('data-align="left"');
    expect(html).not.toContain('<img');
    expect(html).toContain('>Aurivita</div>');
  });

  it('API antiga (só brandName) continua funcionando', () => {
    const html = header({ brandName: 'Aurivita' });
    expect(html).toContain('>Aurivita</div>');
    expect(html).not.toContain('<img');
  });

  it('valores fora do contrato viram o padrão; URL não-https é ignorada', () => {
    expect(
      headerBrandOf({ brand: { name: 'X', logoUrl: LOGO, logoHeight: 999, logoAlign: 'top' as never } }),
    ).toEqual({ name: 'X', logoUrl: LOGO, logoHeight: 32, logoAlign: 'left' });
    expect(headerBrandOf({ brand: { name: 'X', logoUrl: 'javascript:alert(1)', logoHeight: 32, logoAlign: 'left' } })?.logoUrl).toBeNull();
    expect(headerBrandOf({ brandName: null })).toBeNull();
  });
});

describe('OrderSummary — imagem do item', () => {
  const base = {
    quote: { subtotalMinor: 2990, shippingMinor: 0, totalMinor: 2990, shippingMethod: 'free' as const },
    currency: 'EUR',
    locale: 'it',
    t: checkoutStrings('it'),
    shippingKnown: true,
  };
  const item = { title: 'Spicy Cubes', quantity: 2, unitLabel: null, priceMinor: 2990, compareAtMinor: null };

  it('sem imagem enviada: quadro neutro com o badge de quantidade', () => {
    const html = renderToStaticMarkup(createElement(OrderSummary, { ...base, items: [{ ...item, image: null }] }));
    expect(html).toContain('data-ll-thumb-placeholder');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/>2<\/span>/);
  });

  it('com imagem enviada: mostra a imagem', () => {
    const html = renderToStaticMarkup(createElement(OrderSummary, { ...base, items: [{ ...item, image: LOGO }] }));
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).not.toContain('data-ll-thumb-placeholder');
  });
});
