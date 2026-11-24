// Story-Driven — emotional narrative flow (Halbert-style).
//
// Story 13.6 AC20.
//
// Structure (emotional arc):
//   1. Emotional hero (headline focused on transformation)
//   2. Long personal story section (largest visual weight)
//   3. Reveal — product introduction mid-page
//   4. Testimonials with faces (from social_proof.testimonials_content)
//   5. Offer stack
//   6. Guarantee
//   7. Final CTA
//
// Used when: pir.voc.top_pains[0].intensity >= 8 OR avatar.emotional_signals
// are present — high-empathy framing.

import * as React from 'react';

import {
  BrandStyle,
  CtaButton,
  GuaranteeBlock,
  HeroBlock,
  OfferBlock,
  StoryBlock,
  TestimonialsBlock,
  TrustBadges,
  findSection,
} from './shared.js';
import type { TemplateSlots } from './types.js';

export const StoryDriven: React.FC<TemplateSlots> = (slots) => {
  const story: {
    kind: 'story';
    heading: string;
    paragraphs: string[];
    image_url?: string;
  } =
    findSection(slots.body_sections, 'story') ?? {
      kind: 'story',
      heading: 'The turning point',
      paragraphs: [slots.hero.subhead],
    };
  const guarantee = findSection(slots.body_sections, 'guarantee');
  const testimonials = slots.social_proof.testimonials_content;

  return (
    <>
      <BrandStyle brand={slots.brand} />
      <HeroBlock brand={slots.brand} hero={slots.hero} />
      <StoryBlock
        heading={story.heading}
        paragraphs={story.paragraphs}
        image_url={story.image_url ?? slots.social_proof.before_after_urls[0]}
      />
      <section className="ll-section" style={{ textAlign: 'center' }}>
        <div className="ll-container">
          <h2>Meet the {slots.brand.name}</h2>
          <p style={{ fontSize: '1.125rem' }}>{slots.brand.tagline}</p>
          <img
            src={slots.hero.image_url}
            alt={slots.brand.name}
            loading="lazy"
            style={{ margin: '1.5rem auto', maxWidth: 640, borderRadius: 12 }}
          />
        </div>
      </section>
      {testimonials.length > 0 ? (
        <TestimonialsBlock heading="Real transformations" items={testimonials} />
      ) : null}
      <TrustBadges items={slots.trust_badges} />
      <OfferBlock offer={slots.offer_stack} cta={slots.ctas.primary} />
      {guarantee ? <GuaranteeBlock heading={guarantee.heading} body={guarantee.body} /> : null}
      <section className="ll-section">
        <div className="ll-container ll-cta-block">
          <h2>Your turn</h2>
          <CtaButton cta={slots.ctas.primary} />
        </div>
      </section>
    </>
  );
};
