import { describe, expect, it } from 'vitest';

import type { PublicOrderView } from '../post-sale-api';
import { trackingLocale, trackingStrings, type TrackingStrings } from '../post-sale-i18n';
import { buildTrackingDisplay, safeHttpUrl } from '../tracking-view';

const it_ = trackingStrings('it');

function order(partial: Partial<PublicOrderView>): PublicOrderView {
  return {
    orderNumber: 'LL-1001',
    status: 'paid',
    locale: 'it',
    placedAt: '2026-10-01T10:00:00.000Z',
    tracking: null,
    events: [{ type: 'paid', at: '2026-10-01T10:00:00.000Z', details: {} }],
    ...partial,
  };
}

function allStrings(t: TrackingStrings): string[] {
  return Object.values(t).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v as Record<string, string>)));
}

describe('i18n do /rastreio', () => {
  it('italiano pelo idioma do mercado, fallback en', () => {
    expect(trackingStrings('it-IT').title).toBe('Traccia il tuo ordine');
    expect(trackingStrings('de').title).toBe('Track your order');
    expect(trackingStrings(null).title).toBe('Track your order');
    expect(trackingLocale('it-IT')).toBe('it');
    expect(trackingLocale('fr')).toBe('en');
  });

  it('nenhum texto promete prazo/data (D12): sem números', () => {
    for (const lang of ['it', 'en']) {
      for (const text of allStrings(trackingStrings(lang))) expect(text).not.toMatch(/\d/);
    }
  });
});

describe('buildTrackingDisplay', () => {
  it('sem código: estado honesto (em preparação), sem rastreio inventado', () => {
    const view = buildTrackingDisplay(
      order({
        status: 'preparing',
        events: [
          { type: 'paid', at: '2026-10-01T10:00:00.000Z', details: {} },
          { type: 'preparing', at: '2026-10-03T10:15:00.000Z', details: {} },
        ],
      }),
      it_,
      'it-IT',
    );
    expect(view.statusLabel).toBe('In preparazione');
    expect(view.statusNote).toContain('in preparazione');
    expect(view.tracking).toBeNull();
    expect(view.awaitingTracking).toBe(true);
    expect(view.timeline.map((r) => r.label)).toEqual(['Ordine in preparazione', 'Ordine confermato']);
  });

  it('enviado: código + transportadora + link reais; correção vira "dados atualizados"', () => {
    const view = buildTrackingDisplay(
      order({
        status: 'shipped',
        tracking: { code: 'RR123IT', carrier: 'Poste Italiane', url: 'https://track.example/RR123IT' },
        events: [
          { type: 'paid', at: '2026-10-01T10:00:00.000Z', details: {} },
          { type: 'shipped', at: '2026-10-04T09:00:00.000Z', details: { carrier: 'Poste', code: 'RR000IT', url: null } },
          {
            type: 'shipped',
            at: '2026-10-04T11:00:00.000Z',
            details: { carrier: 'Poste Italiane', code: 'RR123IT', url: 'https://track.example/RR123IT' },
          },
        ],
      }),
      it_,
      'it-IT',
    );
    expect(view.tracking).toEqual({
      code: 'RR123IT',
      carrier: 'Poste Italiane',
      url: 'https://track.example/RR123IT',
    });
    expect(view.awaitingTracking).toBe(false);
    expect(view.timeline[0]).toMatchObject({ label: 'Dati di spedizione aggiornati', detail: 'Poste Italiane · RR123IT' });
    expect(view.timeline[1]).toMatchObject({ label: 'Ordine spedito', detail: 'Poste · RR000IT' });
  });

  it('link de rastreio que não é http(s) é descartado', () => {
    const view = buildTrackingDisplay(
      order({ status: 'shipped', tracking: { code: 'X1', carrier: 'GLS', url: 'javascript:alert(1)' } }),
      it_,
      'it',
    );
    expect(view.tracking?.url).toBeNull();
    expect(safeHttpUrl('ftp://x')).toBeNull();
    expect(safeHttpUrl('http://ok.example/a')).toBe('http://ok.example/a');
  });

  it('enviado sem código não exibe a nota que cita o código', () => {
    const view = buildTrackingDisplay(order({ status: 'shipped' }), it_, 'it');
    expect(view.statusNote).toBeNull();
    expect(view.awaitingTracking).toBe(false);
  });

  it('reembolso mostra valor e moeda do evento', () => {
    const view = buildTrackingDisplay(
      order({
        status: 'refunded',
        events: [
          { type: 'paid', at: '2026-10-01T10:00:00.000Z', details: {} },
          { type: 'refunded', at: '2026-10-02T10:00:00.000Z', details: { amountMinor: 1500, currency: 'eur', full: false } },
        ],
      }),
      it_,
      'it-IT',
    );
    expect(view.statusLabel).toBe('Rimborsato');
    expect(view.timeline[0]?.label).toBe('Rimborso parziale effettuato');
    expect(view.timeline[0]?.detail).toMatch(/15,00/);
    expect(view.timeline[0]?.detail).toContain('€');
  });

  it('status desconhecido cai num rótulo genérico', () => {
    expect(buildTrackingDisplay(order({ status: 'weird' }), it_, 'it').statusLabel).toBe('In corso');
  });
});
