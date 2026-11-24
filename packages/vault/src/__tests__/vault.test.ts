import { afterEach, describe, expect, it, vi } from 'vitest';

import { decrypt, encrypt, mask } from '../crypto.js';
import { testShopifyAppCredentials } from '../testers/shopify-app-credentials.tester.js';
import { testShopifyWebhookSecret } from '../testers/shopify-webhook-secret.tester.js';
import { testResendKey } from '../testers/resend.tester.js';
import { testSupabaseUrl, testSupabaseServiceKey } from '../testers/supabase.tester.js';

const SECRET = 'test-vault-secret-must-be-32-chars-long!';

describe('crypto', () => {
  it('round-trip: encrypt → decrypt returns original', async () => {
    const plaintext = 'my-secret-api-key-abc123';
    const blob = await encrypt(plaintext, SECRET);
    const recovered = await decrypt(blob.ciphertext, blob.iv, blob.salt, SECRET);
    expect(recovered).toBe(plaintext);
  });

  it('IV unique: two encryptions of same value produce different ciphertexts', async () => {
    const blob1 = await encrypt('same-value', SECRET);
    const blob2 = await encrypt('same-value', SECRET);
    expect(blob1.ciphertext.toString('hex')).not.toBe(blob2.ciphertext.toString('hex'));
    expect(blob1.iv.toString('hex')).not.toBe(blob2.iv.toString('hex'));
  });

  it('salt unique per encryption', async () => {
    const blob1 = await encrypt('same-value', SECRET);
    const blob2 = await encrypt('same-value', SECRET);
    expect(blob1.salt.toString('hex')).not.toBe(blob2.salt.toString('hex'));
  });

  it('wrong secret fails to decrypt', async () => {
    const blob = await encrypt('secret', SECRET);
    await expect(
      decrypt(blob.ciphertext, blob.iv, blob.salt, 'wrong-secret-that-is-32chars-longg'),
    ).rejects.toThrow();
  });
});

describe('mask', () => {
  it('shows only last 4 chars', () => {
    expect(mask('abcdefgh1234')).toBe('••••••••1234');
  });

  it('short value shows placeholder', () => {
    expect(mask('abc')).toBe('••••');
  });

  it('exactly 4 chars shows placeholder', () => {
    expect(mask('abcd')).toBe('••••');
  });
});

// ─── Testers de credenciais ──────────────────────────────────────────────

describe('testShopifyWebhookSecret', () => {
  it('mesmo valor do client secret → ok', () => {
    const result = testShopifyWebhookSecret('same-value', 'same-value');
    expect(result.status).toBe('ok');
  });

  it('valor diferente do client secret → warning (não error)', () => {
    const result = testShopifyWebhookSecret('a', 'b');
    expect(result.status).toBe('warning');
    expect(result.message).toContain('DIFERE');
  });

  it('client secret ausente → configured (não error)', () => {
    const result = testShopifyWebhookSecret('some-secret', null);
    expect(result.status).toBe('configured');
  });

  it('webhook secret vazio → error', () => {
    const result = testShopifyWebhookSecret('', 'some-client-secret');
    expect(result.status).toBe('error');
  });

  it('comparação é timing-safe: valores de tamanhos diferentes retornam warning sem lançar', () => {
    const result = testShopifyWebhookSecret('short', 'much-longer-value-here');
    expect(result.status).toBe('warning');
  });
});

describe('testShopifyAppCredentials', () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('Shopify aceita → ok', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'shpat_test', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const result = await testShopifyAppCredentials({
      clientId: 'cid',
      clientSecret: 'cs',
      storeDomain: 'authenlondon.myshopify.com',
    });
    expect(result.status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://authenlondon.myshopify.com/admin/oauth/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('Shopify recusa 401 → error (não vaza token)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const result = await testShopifyAppCredentials({
      clientId: 'cid',
      clientSecret: 'cs',
      storeDomain: 'authenlondon.myshopify.com',
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('recusou');
  });

  it('tríade incompleta → error orientativo', async () => {
    const result = await testShopifyAppCredentials({
      clientId: '',
      clientSecret: 'cs',
      storeDomain: 'authenlondon.myshopify.com',
    });
    expect(result.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('testResendKey', () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('200 → ok', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await testResendKey('re_abc');
    expect(result.status).toBe('ok');
  });

  it('401 → error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const result = await testResendKey('bad');
    expect(result.status).toBe('error');
  });

  it('vazio → error sem chamar fetch', async () => {
    const result = await testResendKey('');
    expect(result.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('testSupabaseUrl', () => {
  it('URL malformada → error', async () => {
    const result = await testSupabaseUrl('not-a-url');
    expect(result.status).toBe('error');
  });

  it('vazio → error', async () => {
    const result = await testSupabaseUrl('');
    expect(result.status).toBe('error');
  });
});

describe('testSupabaseServiceKey', () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('sem URL → configured (não error)', async () => {
    const result = await testSupabaseServiceKey('some-key', null);
    expect(result.status).toBe('configured');
  });

  it('vazio → error', async () => {
    const result = await testSupabaseServiceKey('', 'https://ref.supabase.co');
    expect(result.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('200 → ok', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await testSupabaseServiceKey('sk', 'https://ref.supabase.co');
    expect(result.status).toBe('ok');
  });

  it('401 → error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const result = await testSupabaseServiceKey('bad', 'https://ref.supabase.co');
    expect(result.status).toBe('error');
  });
});
