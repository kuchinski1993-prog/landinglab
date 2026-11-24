// Shared template building blocks.
//
// Small stateless React components reused by long-form-advertorial,
// short-form-direct, and story-driven templates. Keeping them here avoids
// copy-paste and centralizes CSS-var usage (var(--color-primary), etc).
//
// Story 13.6 AC17-AC20.

import * as React from 'react';

import type {
  BodySection,
  BrandSlot,
  BulletSlot,
  CtaSlot,
  FaqSlot,
  OfferStackSlot,
  TestimonialSlot,
} from './types.js';

// ─── Brand style tag — injects palette + typography as CSS custom properties ──

export function BrandStyle({ brand }: { brand: BrandSlot }): React.ReactElement {
  const { palette, typography } = brand;
  // Font faces loaded via <link> in <head>; only vars go here.
  const css = `:root{--color-primary:${palette.primary};--color-secondary:${palette.secondary};--color-accent:${palette.accent};--color-bg:${palette.bg};--color-text:${palette.text};--font-headline:'${typography.headline_font}',sans-serif;--font-body:'${typography.body_font}',sans-serif}body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg);line-height:1.5;padding-bottom:80px}h1,h2,h3,h4{font-family:var(--font-headline);color:var(--color-text);line-height:1.15;margin:0 0 0.5em}h1{font-size:clamp(2rem,5vw,3.5rem)}h2{font-size:clamp(1.5rem,3.5vw,2.25rem)}h3{font-size:clamp(1.15rem,2.5vw,1.5rem)}p{margin:0 0 1em}img{max-width:100%;height:auto;display:block}a{color:var(--color-primary)}.ll-container{max-width:960px;margin:0 auto;padding:0 1rem}.ll-section{padding:3.5rem 0}.ll-cta{display:inline-block;background:var(--color-primary);color:#fff;padding:1rem 2rem;border-radius:8px;font-weight:700;text-decoration:none;font-size:1.125rem;border:0;cursor:pointer}.ll-cta--secondary{background:transparent;color:var(--color-primary);border:2px solid var(--color-primary)}.ll-cta--tertiary{background:var(--color-secondary)}.ll-hero{background:linear-gradient(180deg,var(--color-bg) 0%,rgba(0,0,0,0.03) 100%);padding:3.5rem 0}.ll-hero__grid{display:grid;grid-template-columns:1fr;gap:2rem;align-items:center}@media (min-width:768px){.ll-hero__grid{grid-template-columns:1.1fr 1fr}}.ll-hero__image{border-radius:12px;overflow:hidden}.ll-bullets{list-style:none;padding:0;margin:0;display:grid;gap:1rem}.ll-bullet{display:grid;grid-template-columns:auto 1fr;gap:0.75rem;align-items:start;padding:0.75rem 0}.ll-bullet__icon{width:2rem;height:2rem}.ll-bullet__dot{width:0.75rem;height:0.75rem;background:var(--color-accent);border-radius:999px;margin-top:0.5rem}.ll-offer{background:var(--color-bg);border:2px solid var(--color-primary);border-radius:12px;padding:2rem;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08)}.ll-offer__price{font-size:2.5rem;font-weight:800;color:var(--color-primary);margin:1rem 0 0.25rem}.ll-offer__value{text-decoration:line-through;color:#888;font-size:1.125rem}.ll-offer__savings{color:var(--color-accent);font-weight:700;margin:0.25rem 0 1.25rem}.ll-guarantee{border:3px dashed var(--color-secondary);padding:2rem;border-radius:12px;background:#fff;text-align:center}.ll-urgency{background:var(--color-secondary);color:#fff;padding:2rem;border-radius:12px;text-align:center}.ll-urgency h2{color:#fff}.ll-testimonial{padding:1.5rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.05);border-left:4px solid var(--color-accent);margin-bottom:1rem}.ll-testimonial__source{font-size:0.875rem;color:#666;margin-top:0.5rem}.ll-badges{display:flex;flex-wrap:wrap;gap:1rem;justify-content:center;align-items:center;padding:1rem 0}.ll-badges img{max-height:64px;width:auto}.ll-faq details{border-bottom:1px solid #ddd;padding:1rem 0}.ll-faq summary{cursor:pointer;font-weight:700;font-family:var(--font-headline);font-size:1.125rem}.ll-comparison{border-collapse:collapse;width:100%}.ll-comparison th,.ll-comparison td{padding:0.75rem;border:1px solid #ddd;text-align:left}.ll-comparison th{background:var(--color-primary);color:#fff}.ll-story p{font-size:1.125rem;line-height:1.7;margin-bottom:1.25rem}.ll-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;text-align:center}.ll-stat__value{font-size:2rem;font-weight:800;color:var(--color-primary);display:block}.ll-cta-block{text-align:center;padding:2rem 0}.ll-ba{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1.5rem}@media (max-width:640px){.ll-ba{grid-template-columns:1fr}}.ll-ba__side{margin:0;position:relative}.ll-ba__side img{border-radius:12px;width:100%;aspect-ratio:1/1;object-fit:cover}.ll-ba__label{position:absolute;top:1rem;left:1rem;padding:0.35rem 0.75rem;border-radius:999px;font-weight:700;font-size:0.875rem;color:#fff}.ll-ba__label--before{background:#666}.ll-ba__label--after{background:var(--color-primary)}.ll-benefits{list-style:none;padding:0;margin:2rem 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.5rem}.ll-benefit{display:flex;flex-direction:column;align-items:center;text-align:center;padding:1.5rem;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.05)}.ll-benefit img{width:64px;height:64px;margin-bottom:0.75rem}.ll-benefit__num{display:flex;align-items:center;justify-content:center;width:48px;height:48px;background:var(--color-primary);color:#fff;border-radius:50%;font-weight:800;font-size:1.25rem;margin-bottom:0.75rem}.ll-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.75rem;margin-top:1.5rem}.ll-gallery__item{aspect-ratio:1/1;overflow:hidden;border-radius:8px;background:rgba(0,0,0,0.03)}.ll-gallery__item img{width:100%;height:100%;object-fit:cover;transition:transform 200ms ease}.ll-gallery__item:hover img{transform:scale(1.05)}.ll-sticky-cta{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid rgba(0,0,0,0.1);box-shadow:0 -4px 16px rgba(0,0,0,0.08);z-index:9999;padding:0.75rem 1rem;padding-bottom:calc(0.75rem + env(safe-area-inset-bottom,0))}.ll-sticky-cta__inner{max-width:960px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:1rem}.ll-sticky-cta__price{font-weight:700;color:var(--color-text);font-size:0.9rem}.ll-sticky-cta__btn{background:var(--color-primary);color:#fff;padding:0.75rem 1.25rem;border-radius:8px;font-weight:700;text-decoration:none;white-space:nowrap;font-size:0.95rem}@media (min-width:768px){.ll-sticky-cta__price{font-size:1rem}.ll-sticky-cta__btn{padding:0.85rem 1.5rem;font-size:1rem}}`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

// ─── CTA button ────────────────────────────────────────────────────────────

export function CtaButton({
  cta,
  variant = 'primary',
  className,
}: {
  cta: CtaSlot;
  variant?: 'primary' | 'secondary' | 'tertiary';
  className?: string;
}): React.ReactElement {
  const base =
    variant === 'primary'
      ? 'll-cta'
      : variant === 'secondary'
        ? 'll-cta ll-cta--secondary'
        : 'll-cta ll-cta--tertiary';
  const cls = className ? `${base} ${className}` : base;
  return (
    <a className={cls} href="#offer" data-cta-variant={cta.variant} data-urgency={cta.urgency_type}>
      {cta.text}
    </a>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────

export function HeroBlock({
  brand,
  hero,
  className,
}: {
  brand: BrandSlot;
  hero: {
    headline: string;
    subhead: string;
    image_url: string;
    cta_primary: CtaSlot;
    image_srcset?: { mobile?: string; og?: string; desktop?: string };
  };
  className?: string;
}): React.ReactElement {
  const srcset = hero.image_srcset
    ? [
        hero.image_srcset.mobile ? `${hero.image_srcset.mobile} 600w` : null,
        hero.image_srcset.og ? `${hero.image_srcset.og} 1200w` : null,
        hero.image_srcset.desktop ? `${hero.image_srcset.desktop} 1920w` : null,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;
  return (
    <section className={className ? `ll-hero ${className}` : 'll-hero'}>
      <div className="ll-container">
        <div className="ll-hero__grid">
          <div>
            <p style={{ margin: 0, color: 'var(--color-accent)', fontWeight: 700 }}>
              {brand.name}
            </p>
            <h1>{hero.headline}</h1>
            <p style={{ fontSize: '1.25rem', color: '#555' }}>{hero.subhead}</p>
            <div style={{ marginTop: '1.5rem' }}>
              <CtaButton cta={hero.cta_primary} />
            </div>
          </div>
          <div className="ll-hero__image">
            <img
              src={hero.image_url}
              alt={hero.headline}
              fetchPriority="high"
              loading="eager"
              width={1200}
              height={800}
              {...(srcset ? { srcSet: srcset, sizes: '(min-width: 768px) 50vw, 100vw' } : {})}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Body sections ─────────────────────────────────────────────────────────

export function BulletsBlock({
  heading,
  items,
  className,
}: {
  heading: string;
  items: BulletSlot[];
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2>{heading}</h2>
        <ul className="ll-bullets">
          {items.map((b, i) => (
            <li key={i} className="ll-bullet">
              {b.icon_url ? (
                <img src={b.icon_url} alt="" className="ll-bullet__icon" loading="lazy" />
              ) : (
                <span className="ll-bullet__dot" />
              )}
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function StoryBlock({
  heading,
  paragraphs,
  image_url,
  className,
}: {
  heading: string;
  paragraphs: string[];
  image_url?: string;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ll-story ${className}` : 'll-section ll-story'}>
      <div className="ll-container">
        <h2>{heading}</h2>
        {image_url ? (
          <img
            src={image_url}
            alt=""
            loading="lazy"
            style={{ borderRadius: 12, marginBottom: '1.5rem' }}
          />
        ) : null}
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </section>
  );
}

export function ComparisonBlock({
  heading,
  rows,
  className,
}: {
  heading: string;
  rows: Array<{ feature: string; ours: string; theirs: string }>;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2>{heading}</h2>
        <table className="ll-comparison">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Us</th>
              <th>Others</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.feature}</td>
                <td>
                  <strong>{r.ours}</strong>
                </td>
                <td>{r.theirs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function StatsBlock({
  heading,
  items,
  className,
}: {
  heading: string;
  items: Array<{ label: string; value: string }>;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2>{heading}</h2>
        <div className="ll-stats">
          {items.map((s, i) => (
            <div key={i}>
              <span className="ll-stat__value">{s.value}</span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function TestimonialsBlock({
  heading,
  items,
  className,
}: {
  heading: string;
  items: TestimonialSlot[];
  className?: string;
}): React.ReactElement {
  return (
    <section
      className={className ? `ll-section ${className}` : 'll-section'}
      style={{ background: 'rgba(0,0,0,0.03)' }}
    >
      <div className="ll-container">
        <h2>{heading}</h2>
        {items.map((t, i) => (
          <blockquote key={i} className="ll-testimonial">
            <p style={{ margin: 0 }}>&ldquo;{t.content}&rdquo;</p>
            {t.source ? <p className="ll-testimonial__source">— {t.source}</p> : null}
          </blockquote>
        ))}
      </div>
    </section>
  );
}

export function FaqBlock({
  heading,
  items,
  className,
}: {
  heading: string;
  items: FaqSlot[];
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ll-faq ${className}` : 'll-section ll-faq'}>
      <div className="ll-container">
        <h2>{heading}</h2>
        {items.map((f, i) => (
          <details key={i}>
            <summary>{f.question}</summary>
            <p style={{ marginTop: '0.5rem' }}>{f.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function GuaranteeBlock({
  heading,
  body,
  className,
}: {
  heading: string;
  body: string;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <div className="ll-guarantee">
          <h2>{heading}</h2>
          <p>{body}</p>
        </div>
      </div>
    </section>
  );
}

export function UrgencyBlock({
  heading,
  body,
  className,
}: {
  heading: string;
  body: string;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <div className="ll-urgency">
          <h2>{heading}</h2>
          <p>{body}</p>
        </div>
      </div>
    </section>
  );
}

// ─── Fase 3: novos blocos de alta conversão ──────────────────────────────

export function BeforeAfterBlock({
  heading,
  before,
  after,
  className,
}: {
  heading: string;
  before: { image_url: string; label: string };
  after: { image_url: string; label: string };
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2 style={{ textAlign: 'center' }}>{heading}</h2>
        <div className="ll-ba">
          <figure className="ll-ba__side">
            <img src={before.image_url} alt={`Before: ${before.label}`} loading="lazy" />
            <figcaption className="ll-ba__label ll-ba__label--before">{before.label}</figcaption>
          </figure>
          <figure className="ll-ba__side">
            <img src={after.image_url} alt={`After: ${after.label}`} loading="lazy" />
            <figcaption className="ll-ba__label ll-ba__label--after">{after.label}</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

/**
 * Bloco de problema/agitação — cria tensão antes da solução.
 * Boa prática Schwartz pra público com awareness baixa (unaware/problem-aware).
 */
export function ProblemAgitationBlock({
  heading,
  paragraphs,
  className,
}: {
  heading: string;
  paragraphs: string[];
  className?: string;
}): React.ReactElement {
  return (
    <section
      className={className ? `ll-section ${className}` : 'll-section'}
      style={{ background: 'rgba(0,0,0,0.02)' }}
    >
      <div className="ll-container ll-story">
        <h2>{heading}</h2>
        {paragraphs.map((p, i) => (
          <p key={i} style={{ fontSize: '1.15rem', color: '#333' }}>
            {p}
          </p>
        ))}
      </div>
    </section>
  );
}

/**
 * Solução em 3-5 benefícios — semelhante ao BulletsBlock mas semanticamente
 * separado (aparece após problem_agitation, com bullets em ícone destacado).
 */
export function SolutionBenefitsBlock({
  heading,
  benefits,
  className,
}: {
  heading: string;
  benefits: BulletSlot[];
  className?: string;
}): React.ReactElement {
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2 style={{ textAlign: 'center' }}>{heading}</h2>
        <ul className="ll-benefits">
          {benefits.map((b, i) => (
            <li key={i} className="ll-benefit">
              {b.icon_url ? (
                <img src={b.icon_url} alt="" loading="lazy" />
              ) : (
                <span className="ll-benefit__num">{i + 1}</span>
              )}
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Galeria de imagens do produto — usa media_urls do Firecrawl scrape do
 * AliExpress. Renderiza como grid clicável (sem lightbox por ora — HTML puro).
 */
export function GalleryBlock({
  heading,
  image_urls,
  className,
}: {
  heading: string;
  image_urls: string[];
  className?: string;
}): React.ReactElement | null {
  if (image_urls.length === 0) return null;
  return (
    <section className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <h2 style={{ textAlign: 'center' }}>{heading}</h2>
        <div className="ll-gallery">
          {image_urls.slice(0, 8).map((url, i) => (
            <div key={i} className="ll-gallery__item">
              <img src={url} alt={`${heading} ${i + 1}`} loading="lazy" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Sticky CTA no rodapé — sempre visível em mobile.
 * CSS: fixed bottom, z-index alto, background sólido.
 */
export function StickyCtaBar({
  text,
  price_hint,
  className,
}: {
  text: string;
  price_hint?: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className ? `ll-sticky-cta ${className}` : 'll-sticky-cta'}>
      <div className="ll-sticky-cta__inner">
        {price_hint ? <span className="ll-sticky-cta__price">{price_hint}</span> : null}
        <a href="#offer" className="ll-sticky-cta__btn">
          {text}
        </a>
      </div>
    </div>
  );
}

// ─── Offer stack ───────────────────────────────────────────────────────────

export function OfferBlock({
  offer,
  cta,
  className,
}: {
  offer: OfferStackSlot;
  cta: CtaSlot;
  className?: string;
}): React.ReactElement {
  return (
    <section id="offer" className={className ? `ll-section ${className}` : 'll-section'}>
      <div className="ll-container">
        <div className="ll-offer">
          <h2>{offer.core}</h2>
          {offer.bonuses.length > 0 ? (
            <div style={{ margin: '1rem 0', textAlign: 'left' }}>
              <p style={{ fontWeight: 700 }}>Plus bonuses:</p>
              <ul>
                {offer.bonuses.map((b, i) => (
                  <li key={i}>
                    <strong>{b.name}</strong> ({b.perceived_value}) — {b.description}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="ll-offer__value">Total value {offer.total_value}</p>
          <p className="ll-offer__price">{offer.actual_price}</p>
          <p className="ll-offer__savings">You save {offer.savings}</p>
          <CtaButton cta={cta} />
          <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>
            {offer.guarantee}
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── Trust badges row ──────────────────────────────────────────────────────

export function TrustBadges({
  items,
  className,
}: {
  items: Array<{ url: string; alt: string }>;
  className?: string;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className={className ? `ll-container ${className}` : 'll-container'}>
      <div className="ll-badges">
        {items.map((b, i) => (
          <img key={i} src={b.url} alt={b.alt} loading="lazy" />
        ))}
      </div>
    </div>
  );
}

// ─── Body section router ───────────────────────────────────────────────────

/**
 * Renders any BodySection. Templates can choose to render all sections in order
 * (long-form-advertorial) or filter to a subset (short-form-direct).
 */
export function renderBodySection(section: BodySection, key: number): React.ReactElement | null {
  switch (section.kind) {
    case 'bullets':
      return <BulletsBlock key={key} heading={section.heading} items={section.items} />;
    case 'story':
      return (
        <StoryBlock
          key={key}
          heading={section.heading}
          paragraphs={section.paragraphs}
          image_url={section.image_url}
        />
      );
    case 'comparison':
      return <ComparisonBlock key={key} heading={section.heading} rows={section.rows} />;
    case 'stats':
      return <StatsBlock key={key} heading={section.heading} items={section.items} />;
    case 'testimonials':
      return <TestimonialsBlock key={key} heading={section.heading} items={section.items} />;
    case 'faq':
      return <FaqBlock key={key} heading={section.heading} items={section.items} />;
    case 'guarantee':
      return <GuaranteeBlock key={key} heading={section.heading} body={section.body} />;
    case 'urgency':
      return <UrgencyBlock key={key} heading={section.heading} body={section.body} />;
    case 'before_after':
      return (
        <BeforeAfterBlock
          key={key}
          heading={section.heading}
          before={section.before}
          after={section.after}
        />
      );
    case 'problem_agitation':
      return (
        <ProblemAgitationBlock
          key={key}
          heading={section.heading}
          paragraphs={section.paragraphs}
        />
      );
    case 'solution_benefits':
      return (
        <SolutionBenefitsBlock
          key={key}
          heading={section.heading}
          benefits={section.benefits}
        />
      );
    case 'gallery':
      return (
        <GalleryBlock key={key} heading={section.heading} image_urls={section.image_urls} />
      );
  }
}

/** Helper to find a section by kind (nullable). */
export function findSection<K extends BodySection['kind']>(
  sections: BodySection[],
  kind: K,
): Extract<BodySection, { kind: K }> | undefined {
  return sections.find((s): s is Extract<BodySection, { kind: K }> => s.kind === kind);
}

// ─── SM-5.3 aliases (AC1) ─────────────────────────────────────────────────
// Skeletons Bepurex (SM-1.2/SM-1.3) referenciam esses nomes na story.
// Escolha por Option B: consumir *Block direto e expor aliases nominais
// evita duplicação de componentes item-level. Ver Change Log SM-5.3.
export const Bullet = BulletsBlock;
export const FaqItem = FaqBlock;
export const Testimonial = TestimonialsBlock;
export const Guarantee = GuaranteeBlock;
export const OfferStack = OfferBlock;
