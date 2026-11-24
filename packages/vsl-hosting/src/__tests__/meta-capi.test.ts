// VSL-13 (Fase A) — contrato compartilhado da Meta CAPI: nomes padrão, consentimento, token, contexto e HMAC.
import { describe, expect, it } from 'vitest';

import { validateTrackingConfig } from '../funnel-config.js';
import {
  isPlausibleMetaCapiToken, isVslCapiPageUrl, signVslCapiRequest, validateVslCapiBrowserContext, validateVslCapiForwardPayload,
  verifyVslCapiRequest, vslCapiStandardEvent, vslCapiTokenKey, vslConsentRequired,
} from '../meta-capi.js';

const HOST = 'oferta.example.com';
const UUID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'x'.repeat(40);
const NOW = Date.UTC(2026, 9, 10, 12);

describe('standard event mapping (D1/D3)', () => {
  it('maps only PageView, VSL25 and CheckoutClick; custom events never go to CAPI', () => {
    expect(vslCapiStandardEvent('PageView')).toBe('PageView');
    expect(vslCapiStandardEvent('VSL25')).toBe('ViewContent');
    expect(vslCapiStandardEvent('CheckoutClick')).toBe('InitiateCheckout');
    for (const name of ['VSLStart', 'VSL50', 'VSL75', 'VSLComplete', 'CTAVisible', 'CTAClick', 'WatchProgress', 'Diagnostic', 'toString', '__proto__'])
      expect(vslCapiStandardEvent(name)).toBeNull();
  });
});

describe('consent (same rule as LandingLab)', () => {
  it('requires consent in EU/EEA/UK/CH and for unknown countries; LATAM does not', () => {
    for (const country of ['IT', 'de', 'GB', 'CH', 'NO', ' fr ']) expect(vslConsentRequired(country)).toBe(true);
    for (const country of [null, undefined, '', 'XX1', 'BRA']) expect(vslConsentRequired(country)).toBe(true);
    for (const country of ['BR', 'MX', 'AR', 'CO', 'US', 'cl']) expect(vslConsentRequired(country)).toBe(false);
  });
});

describe('token per pixel (AC1)', () => {
  it('derives the vault key from metaPixelId and rejects implausible tokens', () => {
    expect(vslCapiTokenKey('123456789012345')).toBe('vsl_meta_capi:123456789012345');
    expect(() => vslCapiTokenKey('bad pixel')).toThrow();
    expect(isPlausibleMetaCapiToken(`EAA${'b'.repeat(120)}`)).toBe(true);
    for (const value of ['', '   ', 'short', `EAA ${'b'.repeat(60)}`, `${'b'.repeat(60)}\n`, 'a'.repeat(1025), 42, null]) expect(isPlausibleMetaCapiToken(value)).toBe(false);
  });
  it('keeps any token key out of tracking_config', () => {
    for (const key of ['capiToken', 'metaCapiToken', 'accessToken', 'token'])
      expect(() => validateTrackingConfig({ metaPixelId: '123456789012345', [key]: `EAA${'b'.repeat(60)}` })).toThrow();
  });
});

describe('browser context (AC5)', () => {
  const fbp = 'fb.1.1712345678901.1234567890';
  const fbc = 'fb.1.1712345678901.IwAR0abc_DEF-123';
  it('accepts strict formats with a https URL of the same host and without query/fragment', () => {
    expect(validateVslCapiBrowserContext({ eventId: UUID, fbp, fbc, url: `https://${HOST}/vsl/` }, HOST)).toEqual({ eventId: UUID, fbp, fbc, url: `https://${HOST}/vsl/` });
    expect(validateVslCapiBrowserContext({ eventId: UUID, fbclid: 'IwAR0abc' }, HOST)).toEqual({ eventId: UUID, fbclid: 'IwAR0abc' });
  });
  it('rejects unknown keys, bad ids, cookies and URLs from another host/with query', () => {
    for (const input of [
      null, [], { eventId: 'x' }, { eventId: UUID, extra: 1 }, { eventId: UUID, fbp: 'abc' }, { eventId: UUID, fbc: 'fb.1.1.x' },
      { eventId: UUID, fbclid: 'a b' }, { eventId: UUID, url: `http://${HOST}/` }, { eventId: UUID, url: 'https://evil.example.org/' },
      { eventId: UUID, url: `https://${HOST}/?utm_source=x` }, { eventId: UUID, url: `https://${HOST}/#a` }, { eventId: UUID, url: `https://${HOST}/?` },
      { eventId: UUID, url: `https://user:pw@${HOST}/` }, { eventId: UUID, url: `https://${HOST}:8443/` },
    ]) expect(() => validateVslCapiBrowserContext(input, HOST)).toThrow();
    expect(isVslCapiPageUrl(`https://${HOST}/${'a'.repeat(1100)}`, HOST)).toBe(false);
  });
});

describe('internal payload and authentication (AC4)', () => {
  const payload = { hostname: HOST, projectId: UUID, stepId: UUID, releaseId: UUID, eventName: 'ViewContent', eventId: UUID,
    eventTime: Math.floor(NOW / 1000) - 60, ip: '203.0.113.7', userAgent: 'Mozilla/5.0', consentRequired: false, consentGranted: false };
  it('validates the forwarded payload strictly', () => {
    expect(validateVslCapiForwardPayload(payload, NOW)).toEqual(payload);
    for (const patch of [{ eventName: 'VSL25' }, { eventName: 'Purchase' }, { ip: 'not-an-ip' }, { userAgent: 'a\nb' }, { eventTime: Math.floor(NOW / 1000) - 8 * 86400 },
      { eventTime: Math.floor(NOW / 1000) + 3600 }, { consentRequired: 'no' }, { pixelId: '123' }, { capiToken: 'x' }, { hostname: 'Not A Host' }])
      expect(() => validateVslCapiForwardPayload({ ...payload, ...patch }, NOW)).toThrow();
  });
  it('verifies HMAC + timestamp in constant time and rejects missing/wrong/expired/unsigned', () => {
    const body = JSON.stringify(payload);
    const ts = Math.floor(NOW / 1000);
    const signature = signVslCapiRequest(body, ts, SECRET);
    expect(verifyVslCapiRequest(body, String(ts), signature, SECRET, NOW)).toBe(true);
    expect(verifyVslCapiRequest(`${body} `, String(ts), signature, SECRET, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, String(ts), signVslCapiRequest(body, ts, 'y'.repeat(40)), SECRET, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, String(ts - 301), signVslCapiRequest(body, ts - 301, SECRET), SECRET, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, undefined, signature, SECRET, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, String(ts), undefined, SECRET, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, String(ts), signature, null, NOW)).toBe(false);
    expect(verifyVslCapiRequest(body, String(ts), signVslCapiRequest(body, ts, 'short'), 'short', NOW)).toBe(false);
  });
});
