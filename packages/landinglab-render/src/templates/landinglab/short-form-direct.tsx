// Short-Form Direct — single hero + offer above fold.
//
// Story 13.6 AC19.
//
// Structure (compressed, decision above the fold):
//   1. Hero (image + headline + subhead + primary CTA + compressed bullet list)
//   2. Compressed offer stack
//   3. 3-5 core benefits (bulleted)
//   4. 2 testimonials
//   5. Trust badges row
//   6. Short FAQ (max 3 items)
//   7. Final CTA
//
// Used when: sophistication_level 1-2, low emotional intensity — impulse-buy
// framing. Filters out heavy sections (long story, comparison, stats,
// guarantee box, urgency wall) that would delay decision.

import * as React from 'react';

import {
  BrandStyle,
  BulletsBlock,
  CtaButton,
  FaqBlock,
  HeroBlock,
  OfferBlock,
  TestimonialsBlock,
  TrustBadges,
  findSection,
} from './shared.js';
import type { TemplateSlots } from './types.js';

export const ShortFormDirect: React.FC<TemplateSlots> = (slots) => {
  const bullets = findSection(slots.body_sections, 'bullets');
  const trimmedBullets = bullets
    ? { heading: bullets.heading, items: bullets.items.slice(0, 5) }
    : undefined;
  const testimonials = slots.social_proof.testimonials_content.slice(0, 2);
  const faq = findSection(slots.body_sections, 'faq');
  const trimmedFaq = faq ? { heading: faq.heading, items: faq.items.slice(0, 3) } : undefined;

  return (
    <>
      <BrandStyle brand={slots.brand} />
      <HeroBlock brand={slots.brand} hero={slots.hero} />
      <OfferBlock offer={slots.offer_stack} cta={slots.ctas.primary} />
      {trimmedBullets ? (
        <BulletsBlock heading={trimmedBullets.heading} items={trimmedBullets.items} />
      ) : null}
      {testimonials.length > 0 ? (
        <TestimonialsBlock heading="Trusted by customers" items={testimonials} />
      ) : null}
      <TrustBadges items={slots.trust_badges} />
      {trimmedFaq ? <FaqBlock heading={trimmedFaq.heading} items={trimmedFaq.items} /> : null}
      <section className="ll-section">
        <div className="ll-container ll-cta-block">
          <CtaButton cta={slots.ctas.primary} />
        </div>
      </section>
    </>
  );
};
