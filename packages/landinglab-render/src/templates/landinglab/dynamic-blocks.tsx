// Dynamic Blocks Template — Fase 3 do redesign.
//
// Ao contrário dos templates fixos (short-form-direct / story-driven /
// long-form-advertorial) que hardcoded a ORDEM e o CONJUNTO de blocos,
// este template respeita 100% a sequência que o layout-planner (Squad 4)
// decidir baseado em PIR + heurísticas de conversão.
//
// Âncoras estruturais fixas (não configuráveis):
//   1. <BrandStyle> (CSS vars + reset) — sempre primeiro
//   2. <HeroBlock> — sempre logo após BrandStyle
//   3. Body sections — na ORDEM que o composer passar (arbitrária)
//      Oferta é uma seção especial (ll-offer com id="offer") inserida via
//      OfferBlock componentizado onde o planner posicionar.
//   4. Final CTA block — sempre último (antes do sticky)
//   5. <StickyCtaBar> — overlay fixed no bottom, se sticky_cta estiver presente

import * as React from 'react';

import {
  BrandStyle,
  CtaButton,
  HeroBlock,
  OfferBlock,
  renderBodySection,
  StickyCtaBar,
  TrustBadges,
} from './shared.js';
import type { TemplateSlots } from './types.js';

export const DynamicBlocks: React.FC<TemplateSlots> = (slots) => {
  const { brand, hero, body_sections, offer_stack, ctas, trust_badges, sticky_cta } = slots;

  return (
    <>
      <BrandStyle brand={brand} />
      <HeroBlock brand={brand} hero={hero} />

      {/* Trust badges logo abaixo do hero — social proof imediato */}
      {trust_badges.length > 0 ? <TrustBadges items={trust_badges} /> : null}

      {/* Renderiza cada body_section na ORDEM planejada.
          Cada bloco vira um <div data-block-id="{kind}-{index}"> pra que a
          Fase 4 (regenerate-inline) possa localizar e substituir apenas o
          conteúdo daquele bloco no HTML pós-build. */}
      {body_sections.map((section, i) => (
        <div key={i} data-block-id={`${section.kind}-${i}`} data-block-kind={section.kind}>
          {renderBodySection(section, i)}
        </div>
      ))}

      {/* Bloco de oferta — âncora fixa no id="offer" pros CTAs linkarem */}
      <OfferBlock offer={offer_stack} cta={ctas.primary} />

      {/* CTA de fechamento — sempre último bloco antes do sticky */}
      <section className="ll-section">
        <div className="ll-container ll-cta-block">
          <h2>Your turn</h2>
          <CtaButton cta={ctas.primary} />
        </div>
      </section>

      {/* Sticky CTA bar — overlay fixed mobile-first */}
      {sticky_cta ? <StickyCtaBar text={sticky_cta.text} price_hint={sticky_cta.price_hint} /> : null}
    </>
  );
};
