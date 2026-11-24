// Story 18.2 · AC9 — o VSL reexporta o safe-fetch do shared (os testes completos foram para
// packages/shared/src/__tests__/safe-fetch.test.ts); nenhum import do VSL muda.
import { describe, expect, it } from 'vitest';

import * as shared from '../../../shared/src/http/safe-fetch.js';
import { isPrivateVslAddress } from '../domain-service.js';
import * as vslIndex from '../index.js';
import { parsePublicHttpUrl, SAFE_FETCH_USER_AGENT, safeFetch, SafeFetchError } from '../safe-fetch.js';

describe('safe-fetch do VSL = reexportação do shared', () => {
  it('mesmas referências (safe-fetch.ts e index do pacote)', () => {
    expect(safeFetch).toBe(shared.safeFetch);
    expect(SafeFetchError).toBe(shared.SafeFetchError);
    expect(parsePublicHttpUrl).toBe(shared.parsePublicHttpUrl);
    expect(SAFE_FETCH_USER_AGENT).toBe(shared.SAFE_FETCH_USER_AGENT);
    expect(vslIndex.safeFetch).toBe(shared.safeFetch);
    expect(vslIndex.SafeFetchError).toBe(shared.SafeFetchError);
  });

  it('isPrivateVslAddress continua exportado (alias de isPrivateAddress)', () => {
    expect(isPrivateVslAddress).toBe(shared.isPrivateAddress);
    expect(isPrivateVslAddress('169.254.169.254')).toBe(true);
    expect(isPrivateVslAddress('93.184.216.34')).toBe(false);
  });

  it('contrato observável inalterado: URL privada falha com reason private_address', () => {
    expect(() => parsePublicHttpUrl('http://127.0.0.1/')).toThrow(expect.objectContaining({ reason: 'private_address' }));
    expect(() => parsePublicHttpUrl('http://cdn.example.com:8080/')).toThrow(expect.objectContaining({ reason: 'invalid_url' }));
  });
});
