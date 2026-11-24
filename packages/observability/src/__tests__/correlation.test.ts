import { describe, expect, it } from 'vitest';

import {
  getCorrelationContext,
  getCorrelationId,
  isValidCorrelationId,
  newCorrelationId,
  parseCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from '../correlation.js';
import { isProtectedPath, isProtectedQueue, PROTECTED_QUEUES } from '../protected.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('parseCorrelationId', () => {
  it.each([
    ['ABCDEFGH-1'],
    ['a.b_c-d.e'],
    ['12345678'],
    ['x'.repeat(64)],
    ['3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b'],
  ])('aceita %s', (value) => {
    expect(parseCorrelationId(value)).toBe(value);
    expect(isValidCorrelationId(value)).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['short'],
    ['x'.repeat(65)],
    ['y'.repeat(200)],
    ['abc\r\nSet-Cookie: x'],
    ['com espaços aqui'],
    ['ünïcødé-id-1234'],
    [12345678],
    [{}],
  ])('rejeita %j', (value) => {
    expect(parseCorrelationId(value)).toBeNull();
  });

  it('header repetido (array) usa o primeiro valor', () => {
    expect(parseCorrelationId(['ABCDEFGH-1', 'outro-valor-2'])).toBe('ABCDEFGH-1');
  });
});

describe('resolveCorrelationId / newCorrelationId', () => {
  it('gera UUID v4 quando o valor é inválido', () => {
    expect(resolveCorrelationId('bad value')).toMatch(UUID);
    expect(resolveCorrelationId(undefined)).toMatch(UUID);
  });

  it('mantém id válido', () => {
    expect(resolveCorrelationId('ABCDEFGH-1')).toBe('ABCDEFGH-1');
  });

  it('prefixo opcional', () => {
    const id = newCorrelationId('wk-');
    expect(id.startsWith('wk-')).toBe(true);
    expect(id.slice(3)).toMatch(UUID);
  });
});

describe('contexto AsyncLocalStorage', () => {
  it('fora de contexto → undefined', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getCorrelationContext()).toBeUndefined();
  });

  it('propaga por await', async () => {
    const seen = await runWithCorrelation({ correlationId: 'ABCDEFGH-1' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCorrelationId();
    });
    expect(seen).toBe('ABCDEFGH-1');
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('zonas protegidas', () => {
  it.each([
    ['/admin/tracker/campaigns'],
    ['/admin/tracker/clicks/:id/conversion'],
    ['/api/t/:slug'],
    ['/api/t/meu-slug?x=1'],
    ['/webhooks/email/inbound'],
    ['/inbound-emails'],
    ['/inbox'],
    ['/inbox/mail/flags'],
    ['/refunds/:ticketId/messages'],
    ['/storefront/refunds/:ticketId'],
    ['/automation-config'],
    ['/notifications'],
    ['/notifications/:id/read'],
    ['/email-templates/:eventKey/enabled'],
    ['/storefront/support'],
    ['/storefront/orders/lookup'],
    ['/storefront/orders/:orderId'],
  ])('%s é protegida', (url) => {
    expect(isProtectedPath(url)).toBe(true);
  });

  it.each([['/jobs/:id'], ['/inboxes'], ['/refunds-foo'], ['/notificationsx'], ['/automation-configs'], ['/api/storefront/orders'], ['/api/storefront/products'], ['/api/tracking'], ['/admin/metrics'], [undefined], ['']])(
    '%s não é protegida',
    (url) => {
      expect(isProtectedPath(url)).toBe(false);
    },
  );

  it('filas protegidas', () => {
    expect([...PROTECTED_QUEUES]).toEqual(['email-queue', 'inbound-classify-queue', 'tracker-capi-queue']);
    expect(isProtectedQueue('email-queue')).toBe(true);
    expect(isProtectedQueue('publish-queue')).toBe(false);
  });
});
