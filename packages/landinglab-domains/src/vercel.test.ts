import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createVercelDomainsClient,
  VercelDomainsConfigError,
  VercelDomainsHttpError,
} from './vercel.js';

// ─────────────────────────────────────────────────────────────────────────
// Vercel Domains adapter tests.
//
// Escopo: HTTP client puro — usamos vi.stubGlobal('fetch') pra mockar
// respostas da Vercel API. Nenhum banco, nenhum drizzle, nenhum I/O real.
// ─────────────────────────────────────────────────────────────────────────

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchOk(bodyJson: unknown): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => bodyJson,
    text: async () => JSON.stringify(bodyJson),
  } as unknown as Response);
}

function mockFetchStatus(status: number, body = ''): FetchMock {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createVercelDomainsClient — addDomainToProject', () => {
  it('POSTs to /v10/projects/{projectId}/domains with correct payload and returns verified=true', async () => {
    const fetchMock = mockFetchOk({ verified: true, verification: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const result = await client.addDomainToProject('shop.example.com', 'prj_123', 'tkn_abc');

    expect(result).toEqual({ verified: true, verificationToken: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v10/projects/prj_123/domains');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn_abc');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'shop.example.com' }));
  });

  it('returns TXT verificationToken when Vercel replies with unverified + TXT challenge', async () => {
    const fetchMock = mockFetchOk({
      verified: false,
      verification: [
        { type: 'CNAME', value: 'cname-val' },
        { type: 'TXT', value: 'vercel-verify=abc123' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const result = await client.addDomainToProject('a.example.com', 'prj', 'tk');

    expect(result.verified).toBe(false);
    expect(result.verificationToken).toBe('vercel-verify=abc123');
  });

  it('throws VercelDomainsConfigError when projectId is missing', async () => {
    const client = createVercelDomainsClient();
    await expect(client.addDomainToProject('x.com', '', 'tk')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });

  it('throws VercelDomainsConfigError when token is missing', async () => {
    const client = createVercelDomainsClient();
    await expect(client.addDomainToProject('x.com', 'prj', '')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });

  it('URL-encodes projectId to protect against injection', async () => {
    const fetchMock = mockFetchOk({ verified: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    await client.addDomainToProject('x.com', 'prj/../secret', 'tk');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('prj%2F..%2Fsecret');
  });

  it('throws VercelDomainsHttpError on 4xx with status + body', async () => {
    const fetchMock = mockFetchStatus(400, 'domain already exists');
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const promise = client.addDomainToProject('x.com', 'prj', 'tk');
    await expect(promise).rejects.toBeInstanceOf(VercelDomainsHttpError);
    await expect(promise).rejects.toMatchObject({ status: 400, body: 'domain already exists' });
    // 4xx should NOT retry — exactly 1 call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createVercelDomainsClient — retry policy', () => {
  it('retries on 5xx up to MAX_RETRIES_ON_5XX (2) + initial = 3 total calls, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'boom' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ verified: true }),
        text: async () => '{}',
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const result = await client.addDomainToProject('x.com', 'prj', 'tk');

    expect(result.verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 (rate limit) same as 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ verified: true }),
        text: async () => '{}',
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const result = await client.addDomainToProject('x.com', 'prj', 'tk');
    expect(result.verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after retries exhausted and throws VercelDomainsHttpError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => 'down' } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    await expect(client.addDomainToProject('x.com', 'prj', 'tk')).rejects.toBeInstanceOf(
      VercelDomainsHttpError,
    );
    // 1 initial + 2 retries = 3 total attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('createVercelDomainsClient — removeDomain', () => {
  it('DELETEs /v9/projects/{projectId}/domains/{domain}', async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    await client.removeDomain('shop.example.com', 'prj_abc', 'tkn');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v9/projects/prj_abc/domains/shop.example.com',
    );
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
  });

  it('URL-encodes the domain (subdomain edge case)', async () => {
    const fetchMock = mockFetchOk({});
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    await client.removeDomain('deep.sub.example.com', 'prj', 'tk');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('deep.sub.example.com');
  });

  it('throws VercelDomainsConfigError when projectId is missing', async () => {
    const client = createVercelDomainsClient();
    await expect(client.removeDomain('x.com', '', 'tk')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });

  it('throws VercelDomainsConfigError when token is missing', async () => {
    const client = createVercelDomainsClient();
    await expect(client.removeDomain('x.com', 'prj', '')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });
});

describe('createVercelDomainsClient — getDomainStatus', () => {
  it('returns verified=true when misconfigured=false and acceptedChallenges non-empty', async () => {
    const fetchMock = mockFetchOk({
      misconfigured: false,
      acceptedChallenges: ['dns-01'],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const status = await client.getDomainStatus('x.com', 'prj', 'tk');
    expect(status).toEqual({ verified: true, reason: undefined });
  });

  it('returns verified=false with reason=dns_misconfigured when misconfigured=true', async () => {
    const fetchMock = mockFetchOk({ misconfigured: true, acceptedChallenges: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const status = await client.getDomainStatus('x.com', 'prj', 'tk');
    expect(status).toEqual({ verified: false, reason: 'dns_misconfigured' });
  });

  it('returns verified=false with reason=awaiting_ssl_challenge when misconfigured=false but no challenges', async () => {
    const fetchMock = mockFetchOk({ misconfigured: false, acceptedChallenges: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const status = await client.getDomainStatus('x.com', 'prj', 'tk');
    expect(status).toEqual({ verified: false, reason: 'awaiting_ssl_challenge' });
  });

  it('handles missing acceptedChallenges field (defaults to 0 length)', async () => {
    const fetchMock = mockFetchOk({ misconfigured: false });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    const status = await client.getDomainStatus('x.com', 'prj', 'tk');
    expect(status.verified).toBe(false);
    expect(status.reason).toBe('awaiting_ssl_challenge');
  });

  it('uses GET method and correct URL path', async () => {
    const fetchMock = mockFetchOk({ misconfigured: false, acceptedChallenges: ['x'] });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVercelDomainsClient();
    await client.getDomainStatus('shop.example.com', 'prj_x', 'tk');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v9/projects/prj_x/domains/shop.example.com/config',
    );
    expect(init.method).toBe('GET');
  });
});

describe('createVercelDomainsClient — legacy shims (attachDomain / pollVerification)', () => {
  it('attachDomain reads LANDINGLAB_VERCEL_TOKEN from env and delegates to addDomainToProject', async () => {
    const fetchMock = mockFetchOk({ verified: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LANDINGLAB_VERCEL_TOKEN', 'env_token_123');

    const client = createVercelDomainsClient();
    const result = await client.attachDomain('prj_leg', 'legacy.example.com');

    expect(result).toEqual({ verified: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env_token_123');
  });

  it('attachDomain throws VercelDomainsConfigError when env token is unset', async () => {
    vi.stubEnv('LANDINGLAB_VERCEL_TOKEN', '');
    const client = createVercelDomainsClient();
    await expect(client.attachDomain('prj', 'x.com')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });

  it('pollVerification reads env token and delegates to getDomainStatus', async () => {
    const fetchMock = mockFetchOk({ misconfigured: false, acceptedChallenges: ['a'] });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LANDINGLAB_VERCEL_TOKEN', 'poll_token');

    const client = createVercelDomainsClient();
    const status = await client.pollVerification('prj_p', 'poll.example.com');
    expect(status.verified).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/v9/projects/prj_p/domains/poll.example.com/config');
  });

  it('pollVerification throws VercelDomainsConfigError when env token is unset', async () => {
    vi.stubEnv('LANDINGLAB_VERCEL_TOKEN', '');
    const client = createVercelDomainsClient();
    await expect(client.pollVerification('prj', 'x.com')).rejects.toBeInstanceOf(
      VercelDomainsConfigError,
    );
  });
});

describe('VercelDomainsHttpError', () => {
  it('exposes status and body on the error instance', () => {
    const err = new VercelDomainsHttpError('boom', 502, 'gateway down');
    expect(err.name).toBe('VercelDomainsHttpError');
    expect(err.status).toBe(502);
    expect(err.body).toBe('gateway down');
    expect(err instanceof Error).toBe(true);
  });
});

describe('VercelDomainsConfigError', () => {
  it('is a distinct Error subclass', () => {
    const err = new VercelDomainsConfigError('no token');
    expect(err.name).toBe('VercelDomainsConfigError');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof VercelDomainsHttpError).toBe(false);
  });
});
