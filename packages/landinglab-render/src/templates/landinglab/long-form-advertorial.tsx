// Long-Form Advertorial — VSL-style long-scroll template.
//
// Story 13.6 AC18.
//
// Structure (top to bottom):
//   1. Hero (image + headline + subhead + primary CTA)
//   2. Story (Halbert-style narrative — filtered kind='story')
//   3. Big bullets (5-8 benefits, one per row with icon)
//   4. Comparison (product vs alternatives)
//   5. Stats / social proof
//   6. Guarantee (bold, boxed)
//   7. Offer stack (Hormozi value stack)
//   8. Urgency
//   9. FAQ (5-8 items)
//  10. Final CTA row (repeat primary + secondary)
//
// Used when: pir.market.sophistication_level >= 3 AND category is complex
// (see agents/template-selector.ts).

import * as React from 'react';

import {
  BrandStyle,
  BulletsBlock,
  ComparisonBlock,
  CtaButton,
  FaqBlock,
  GuaranteeBlock,
  HeroBlock,
  OfferBlock,
  StatsBlock,
  StoryBlock,
  TestimonialsBlock,
  TrustBadges,
  UrgencyBlock,
  findSection,
} from './shared.js';
import type { TemplateSlots } from './types.js';

export const LongFormAdvertorial: React.FC<TemplateSlots> = (slots) => {
  const story = findSection(slots.body_sections, 'story');
  const bullets = findSection(slots.body_sections, 'bullets');
  const comparison = findSection(slots.body_sections, 'comparison');
  const stats = findSection(slots.body_sections, 'stats');
  const testimonials =
    findSection(slots.body_sections, 'testimonials') ??
    (slots.social_proof.testimonials_content.length > 0
      ? ({
          kind: 'testimonials' as const,
          heading: 'What people are saying',
          items: slots.social_proof.testimonials_content,
        } as const)
      : undefined);
  const guarantee = findSection(slots.body_sections, 'guarantee');
  const urgency = findSection(slots.body_sections, 'urgency');
  const faq = findSection(slots.body_sections, 'faq');

  return (
    <>
      <BrandStyle brand={slots.brand} />
      <HeroBlock brand={slots.brand} hero={slots.hero} />
      {story ? (
        <StoryBlock heading={story.heading} paragraphs={story.paragraphs} image_url={story.image_url} />
      ) : null}
      {bullets ? <BulletsBlock heading={bullets.heading} items={bullets.items} /> : null}
      {comparison ? <ComparisonBlock heading={comparison.heading} rows={comparison.rows} /> : null}
      {stats ? <StatsBlock heading={stats.heading} items={stats.items} /> : null}
      {testimonials ? (
        <TestimonialsBlock heading={testimonials.heading} items={testimonials.items} />
      ) : null}
      <TrustBadges items={slots.trust_badges} />
      {guarantee ? <GuaranteeBlock heading={guarantee.heading} body={guarantee.body} /> : null}
      <OfferBlock offer={slots.offer_stack} cta={slots.ctas.primary} />
      {urgency ? <UrgencyBlock heading={urgency.heading} body={urgency.body} /> : null}
      {faq ? <FaqBlock heading={faq.heading} items={faq.items} /> : null}
      <section className="ll-section">
        <div className="ll-container ll-cta-block">
          <h2>Ready to start?</h2>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <CtaButton cta={slots.ctas.primary} />
            {slots.ctas.secondary ? (
              <CtaButton cta={slots.ctas.secondary} variant="secondary" />
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
};
