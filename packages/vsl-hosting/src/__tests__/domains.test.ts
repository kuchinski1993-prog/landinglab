import { describe, expect, it } from 'vitest';

import { assertVslPublishReady, nextVslDomainState, normalizeVslHostname } from '../domains.js';
describe('VSL domain contract', () => {
  it('normalizes safe hostnames and rejects malformed values', () => { expect(normalizeVslHostname(' Example.VSL.test. ')).toBe('example.vsl.test'); expect(() => normalizeVslHostname('https://evil.test')).toThrow(); });
  it('converges states without skipping verification', () => { expect(nextVslDomainState('pending_dns','dns_ok')).toBe('pending_verification'); expect(nextVslDomainState('pending_verification','verify_ok')).toBe('pending_ssl'); expect(nextVslDomainState('pending_ssl','ssl_ok')).toBe('active'); });
  it('requires all publish prerequisites', () => { expect(() => assertVslPublishReady({manifest:true,videoReady:true,checkout:true,hostnameActive:false})).toThrow(); expect(assertVslPublishReady({manifest:true,videoReady:true,checkout:true,hostnameActive:true})).toBe(true); });
});
