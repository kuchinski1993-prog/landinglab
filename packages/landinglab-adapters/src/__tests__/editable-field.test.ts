import { describe, it, expect } from 'vitest';
import {
  validateEditableFieldSource,
  type EditableField,
} from '../types/editable-field.js';

function base(): Omit<EditableField, 'source' | 'value' | 'reference'> {
  return {
    id: 'bundle.0.price',
    region: 'bundles',
    type: 'price',
    label: 'Preço da oferta 3-pack',
    criticality: 'critical',
    confidence: 0.9,
    capabilities: ['edit'],
  };
}

describe('EditableField source invariant (A5)', () => {
  it('canonical: reference required, value forbidden', () => {
    const ok: EditableField = {
      ...base(),
      source: 'canonical',
      reference: { table: 'landing_bundle_offers', column: 'price_cents', rowId: 'r1' },
    };
    expect(validateEditableFieldSource(ok)).toEqual([]);

    const missingRef: EditableField = {
      ...base(),
      source: 'canonical',
    };
    expect(validateEditableFieldSource(missingRef)).toContain(
      'source=canonical requires reference',
    );

    const withValue: EditableField = {
      ...base(),
      source: 'canonical',
      reference: { table: 'landing_bundle_offers', column: 'price_cents' },
      value: '29.95',
    };
    expect(validateEditableFieldSource(withValue)).toContain(
      'source=canonical must not set value',
    );
  });

  it('html: value required, reference forbidden', () => {
    const ok: EditableField = {
      ...base(),
      id: 'hero.headline',
      region: 'headline',
      type: 'text',
      criticality: 'non_critical',
      source: 'html',
      value: 'Never Split the Difference',
    };
    expect(validateEditableFieldSource(ok)).toEqual([]);

    const missingValue: EditableField = {
      ...base(),
      source: 'html',
    };
    expect(validateEditableFieldSource(missingValue)).toContain(
      'source=html requires value',
    );

    const withRef: EditableField = {
      ...base(),
      source: 'html',
      value: 'x',
      reference: { table: 'landing_pages', column: 'currency' },
    };
    expect(validateEditableFieldSource(withRef)).toContain(
      'source=html must not set reference',
    );
  });

  it('derived: value required, reference forbidden', () => {
    const ok: EditableField = {
      ...base(),
      id: 'bundle.0.compareAtFormatted',
      region: 'price_block',
      type: 'price',
      source: 'derived',
      value: '€59.99',
    };
    expect(validateEditableFieldSource(ok)).toEqual([]);

    const withRef: EditableField = {
      ...base(),
      source: 'derived',
      value: '$10.00',
      reference: { table: 'landing_bundle_offers', column: 'compare_at_cents' },
    };
    expect(validateEditableFieldSource(withRef)).toContain(
      'source=derived must not set reference',
    );
  });

  it('null value is allowed for html/derived (means empty/absent)', () => {
    const nullHtml: EditableField = {
      ...base(),
      source: 'html',
      value: null,
    };
    // null !== undefined → treated as "value present"
    expect(validateEditableFieldSource(nullHtml)).toEqual([]);
  });
});
