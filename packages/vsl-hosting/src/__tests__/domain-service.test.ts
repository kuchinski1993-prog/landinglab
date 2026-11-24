// Domínios G3: validação, instruções de DNS, "Verificar agora" (DoH + /__vsl/health + Vercel) e remoção.
import { createServer, type AddressInfo, type Socket } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dnsInstructions, isPrivateVslAddress, pinnedHealthProbe, VslDomainService, vercelProjectDomainsFromEnv,
  type VercelProjectDomains, type VslHealthTarget } from '../domain-service.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

let db: VslTestDatabase;
beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

type Answer = { type: number; data: string };
function network(options: { answers?: Answer[]; health?: 'ok' | 'other' | 'tls' | 'down' } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/')) {
      const v6 = url.endsWith('type=AAAA');
      return Response.json({ Status: 0, Answer: (options.answers ?? []).filter((item) => item.type === 5 || item.type === (v6 ? 28 : 1)) });
    }
    if (url.endsWith('/__vsl/health')) {
      if (options.health === 'tls') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
      if (options.health === 'down' || !options.health) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return Response.json(options.health === 'ok' ? { service: 'blackshop-vsl-runtime' } : { service: 'landinglab' });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}
/** Probe de teste: registra o alvo fixado e responde pelo mesmo mock de rede (URL do health). */
const probes: VslHealthTarget[] = [];
const probeVia = (fetcher: typeof fetch) => async (target: VslHealthTarget) => {
  probes.push(target);
  const response = await fetcher(`https://${target.hostname}${target.path}`);
  return { status: response.status, body: await response.text() };
};
const service = (fetcher = network(), vercel: VercelProjectDomains | null = null, env: NodeJS.ProcessEnv = { VSL_PREVIEW_DOMAIN: 'preview.vsl.test' }) =>
  new VslDomainService(db.sql, { fetch: fetcher, vercel, env, healthProbe: probeVia(fetcher) });
beforeEach(() => { probes.length = 0; });

describe('VslDomainService.add', () => {
  it('validates hostnames, reserved domains and LandingLab conflicts', async () => {
    const domains = service();
    await expect(domains.add('not a host')).rejects.toMatchObject({ code: 'domain_invalid' });
    await expect(domains.add('co.uk')).rejects.toMatchObject({ code: 'domain_invalid' });
    await expect(domains.add('x.preview.vsl.test')).rejects.toMatchObject({ code: 'domain_reserved' });
    await expect(domains.add('meu-app.vercel.app')).rejects.toMatchObject({ code: 'domain_reserved' });
    await db.sql`INSERT INTO landing_pages(slug,title,currency,fulfillment_type,html_body,price) VALUES('x','x','EUR','physical','',1)`;
    await db.sql`INSERT INTO landing_domains(landing_page_id,domain,role) SELECT id,'loja.com','primary' FROM landing_pages LIMIT 1`;
    await expect(domains.add('loja.com')).rejects.toMatchObject({ code: 'domain_landinglab_conflict' });
    await expect(domains.add('WWW.Loja.com.')).rejects.toMatchObject({ code: 'domain_landinglab_conflict' });
    // QA F4 M2: o LandingLab serve `sub.apex` como slug do apex, então o apex inteiro fica reservado.
    await expect(domains.add('vsl.loja.com')).rejects.toMatchObject({ code: 'domain_reserved_landinglab', statusCode: 400, details: { landingDomain: 'loja.com' } });
    const { domain, created } = await domains.add('vsl.outra-loja.com');
    expect(created).toBe(true);
    expect(domain).toMatchObject({ hostname: 'vsl.outra-loja.com', isApex: false, status: { code: 'pending_dns' } });
    expect((await domains.add('vsl.outra-loja.com')).created).toBe(false);
  });

  // QA F4 M2: subdomínios servidos por wildcard do LandingLab ficam reservados no código, sem depender de env.
  it('reserves LandingLab wildcard domains by default; env lists only add to it', async () => {
    const domains = service();
    for (const host of ['bepurex-it.cubipiccanti.online', 'cubipiccanti.online', 'x.y.landinglab.app', 'LANDINGLAB.APP.'])
      await expect(domains.add(host), host).rejects.toMatchObject({ code: 'domain_reserved_landinglab', statusCode: 400 });
    // Sufixo parecido não é falso positivo.
    expect((await domains.add('malicious-cubipiccanti.online')).created).toBe(true);
    const extra = service(network(), null, { VSL_PREVIEW_DOMAIN: 'preview.vsl.test', LANDING_DOMAIN_SUFFIXES: '.minhas-landings.com', VSL_RESERVED_DOMAINS: 'interno.com' });
    await expect(extra.add('a.minhas-landings.com')).rejects.toMatchObject({ code: 'domain_reserved_landinglab' });
    await expect(extra.add('a.interno.com')).rejects.toMatchObject({ code: 'domain_reserved' });
    await expect(extra.add('a.cubipiccanti.online')).rejects.toMatchObject({ code: 'domain_reserved_landinglab' });
    // Apex de landing_domains é consultado na hora (landing criada depois do boot também conta).
    await db.sql`INSERT INTO landing_pages(slug,title,currency,fulfillment_type,html_body,price) VALUES('y','y','EUR','physical','',1)`;
    await db.sql`INSERT INTO landing_domains(landing_page_id,domain,role) SELECT id,'shop.nova-marca.de','primary' FROM landing_pages LIMIT 1`;
    await expect(domains.add('vsl.nova-marca.de')).rejects.toMatchObject({ code: 'domain_reserved_landinglab', details: { landingDomain: 'shop.nova-marca.de' } });
  });

  it('never attaches to Vercel a domain registered before it became reserved', async () => {
    const attach = vi.fn(async () => ({ status: 'attached' as const, verified: true }));
    const domains = service(network({ answers: [{ type: 1, data: '76.76.21.21' }], health: 'ok' }), { attach, detach: vi.fn() });
    const [row] = await db.sql`INSERT INTO blackshop_domains(hostname) VALUES('bepurex-it.cubipiccanti.online') RETURNING id`;
    await expect(domains.verify(row!.id)).rejects.toMatchObject({ code: 'domain_reserved_landinglab' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('returns DNS instructions: CNAME for subdomains, A for apex, plus Vercel TXT', () => {
    expect(dnsInstructions('vsl.oferta.com.br')).toEqual([{ type: 'CNAME', name: 'vsl', host: 'vsl.oferta.com.br', value: 'cname.vercel-dns.com' }]);
    expect(dnsInstructions('oferta.com')).toEqual([{ type: 'A', name: '@', host: 'oferta.com', value: '76.76.21.21' }]);
    expect(dnsInstructions('a.oferta.com', [{ type: 'TXT', domain: '_vercel.oferta.com', value: 'vc-domain-verify=abc' }])[1])
      .toMatchObject({ type: 'TXT', name: '_vercel', value: 'vc-domain-verify=abc' });
  });
});

describe('VslDomainService.verify', () => {
  it('without Vercel token: manual attach instruction, DNS ok but runtime missing', async () => {
    const domains = service(network({ answers: [{ type: 5, data: 'cname.vercel-dns.com.' }, { type: 1, data: '76.76.21.21' }], health: 'other' }));
    const { domain } = await domains.add('vsl.oferta.com');
    const checked = await domains.verify(domain.id);
    expect(checked).toMatchObject({ dnsStatus: 'verified', sslStatus: 'pending', lifecycleStatus: 'registered',
      status: { code: 'runtime_unreachable' }, vercel: { mode: 'manual', code: 'manual_attach_required' } });
    expect(checked.vercel.message).toMatch(/blackshop-vsl-storefront/);
  });

  it('activates when DNS points to Vercel and /__vsl/health answers the runtime marker', async () => {
    const attach = vi.fn(async () => ({ status: 'attached' as const, verified: true }));
    const domains = service(network({ answers: [{ type: 1, data: '76.76.21.21' }], health: 'ok' }), { attach, detach: vi.fn() });
    const { domain } = await domains.add('oferta.com');
    const checked = await domains.verify(domain.id);
    expect(attach).toHaveBeenCalledWith('oferta.com');
    expect(checked).toMatchObject({ dnsStatus: 'verified', sslStatus: 'provisioned', lifecycleStatus: 'active', status: { code: 'active' },
      vercel: { mode: 'api', attached: true, code: 'vercel_attached' } });
    // Já anexado: não chama a API de novo.
    await domains.verify(domain.id);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('marks DNS pointing elsewhere as failed and TLS errors as SSL pending', async () => {
    const elsewhere = service(network({ answers: [{ type: 1, data: '8.8.8.8' }], health: 'down' }));
    const { domain } = await elsewhere.add('x.oferta.com');
    expect(await elsewhere.verify(domain.id)).toMatchObject({ dnsStatus: 'failed', status: { code: 'dns_mismatch' } });
    const tls = service(network({ answers: [{ type: 5, data: 'abc.vercel-dns-017.com.' }, { type: 1, data: '216.198.79.65' }], health: 'tls' }));
    const checked = await tls.verify(domain.id);
    expect(checked).toMatchObject({ dnsStatus: 'verified', sslStatus: 'pending', status: { code: 'pending_ssl' } });
    expect(checked.lastCheck?.health.code).toBe('ssl_pending');
  });

  it('never probes private addresses (DNS rebinding) and reports Vercel conflicts', async () => {
    const fetcher = network({ answers: [{ type: 1, data: '10.0.0.5' }], health: 'ok' });
    const domains = service(fetcher, { attach: async () => ({ status: 'conflict' }), detach: vi.fn() });
    const { domain } = await domains.add('int.oferta.com');
    const checked = await domains.verify(domain.id);
    expect(checked.lastCheck?.health.code).toBe('dns_private_address');
    expect(checked.vercel.code).toBe('vercel_domain_in_use');
    expect((fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([url]) => String(url).includes('__vsl/health'))).toBe(false);
  });

  // QA F4 M3: AAAA também é consultado e IPv6 interno bloqueia o health.
  it('queries AAAA and blocks private/link-local/loopback IPv6 (and IPv4-mapped) answers', async () => {
    for (const ip of ['::1', 'fd00::5', 'fe80::1', '::ffff:10.0.0.1', '::']) {
      const fetcher = network({ answers: [{ type: 5, data: 'cname.vercel-dns.com.' }, { type: 28, data: ip }], health: 'ok' });
      const domains = service(fetcher);
      const { domain } = await domains.add(`v6-${ip.replace(/[^a-f0-9]/g, 'x')}.oferta.com`);
      const checked = await domains.verify(domain.id);
      expect(checked.lastCheck?.dns.records, ip).toContainEqual({ type: 'AAAA', data: ip });
      expect(checked.lastCheck?.health.code, ip).toBe('dns_private_address');
      const urls = (fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.endsWith('type=AAAA'))).toBe(true);
      expect(urls.some((url) => url.includes('__vsl/health'))).toBe(false);
    }
    expect(probes).toEqual([]);
  });

  it('pins the health GET to the address validated by DoH (A first, AAAA when it is the only one)', async () => {
    const domains = service(network({ answers: [{ type: 1, data: '76.76.21.21' }, { type: 28, data: '2606:4700::6810:84e5' }], health: 'ok' }));
    const { domain } = await domains.add('pin.oferta.com');
    expect(await domains.verify(domain.id)).toMatchObject({ lifecycleStatus: 'active' });
    expect(probes).toEqual([expect.objectContaining({ hostname: 'pin.oferta.com', address: '76.76.21.21', family: 4, path: '/__vsl/health' })]);
    const v6 = service(network({ answers: [{ type: 5, data: 'cname.vercel-dns.com.' }, { type: 28, data: '2606:4700::6810:84e5' }], health: 'ok' }));
    const other = (await v6.add('pin6.oferta.com')).domain;
    await v6.verify(other.id);
    expect(probes[1]).toMatchObject({ hostname: 'pin6.oferta.com', address: '2606:4700::6810:84e5', family: 6 });
  });

  it('does not follow redirects from the health endpoint', async () => {
    const domains = new VslDomainService(db.sql, { fetch: network({ answers: [{ type: 1, data: '76.76.21.21' }] }), vercel: null,
      env: { VSL_PREVIEW_DOMAIN: 'preview.vsl.test' }, healthProbe: async () => ({ status: 302, body: '' }) });
    const { domain } = await domains.add('redir.oferta.com');
    const checked = await domains.verify(domain.id);
    expect(checked.lastCheck?.health).toEqual({ ok: false, code: 'runtime_marker_missing', status: 302 });
    expect(checked.lifecycleStatus).toBe('registered');
  });

  it('does not demote an active domain on a transient failure', async () => {
    const domains = service(network({ health: 'down' }));
    const { domain } = await domains.add('live.oferta.com');
    await db.sql`UPDATE blackshop_domains SET dns_status='verified',ssl_status='provisioned',lifecycle_status='active' WHERE id=${domain.id}`;
    const checked = await domains.verify(domain.id);
    expect(checked).toMatchObject({ lifecycleStatus: 'active', lastCheck: { degraded: true } });
  });
});

describe('VslDomainService.remove', () => {
  it('blocks domains with published routes, archives used ones and deletes unused ones', async () => {
    const detach = vi.fn(async () => undefined);
    const domains = service(network(), { attach: vi.fn(), detach });
    const unused = (await domains.add('a.oferta.com')).domain;
    await db.sql`UPDATE blackshop_domains SET last_check=${db.sql.json({ vercel: { mode: 'api', attached: true, code: 'vercel_attached' } })} WHERE id=${unused.id}`;
    expect(await domains.remove(unused.id)).toEqual({ id: unused.id, removed: 'deleted' });
    expect(detach).toHaveBeenCalledWith('a.oferta.com');

    const used = (await domains.add('b.oferta.com')).domain;
    const [project] = await db.sql`INSERT INTO vsl_projects(name,domain_id) VALUES('P',${used.id}) RETURNING id`;
    const [step] = await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname) VALUES(${project!.id},0,'S','/') RETURNING id`;
    const [release] = await db.sql`INSERT INTO vsl_project_releases(project_id,version_number,domain_id) VALUES(${project!.id},1,${used.id}) RETURNING id`;
    const [stepRelease] = await db.sql`INSERT INTO vsl_step_releases(project_release_id,step_id,position,name,type,pathname,render_mode) VALUES(${release!.id},${step!.id},0,'S','PAGE','/','IMPORTED_PAGE') RETURNING id`;
    await db.sql`INSERT INTO vsl_public_routes(domain_id,pathname,project_id,step_id,active_project_release_id,active_step_release_id) VALUES(${used.id},'/',${project!.id},${step!.id},${release!.id},${stepRelease!.id})`;
    await expect(domains.remove(used.id)).rejects.toMatchObject({ code: 'domain_in_use' });
    await db.sql`UPDATE vsl_public_routes SET publication_status='unpublished',active_project_release_id=NULL,active_step_release_id=NULL`;
    expect(await domains.remove(used.id)).toEqual({ id: used.id, removed: 'archived' });
    const [projectAfter] = await db.sql`SELECT domain_id FROM vsl_projects WHERE id=${project!.id}`;
    expect(projectAfter?.domain_id).toBeNull();
    expect((await domains.list()).map((item) => item.hostname)).toEqual([]);
    // Readicionar reativa o mesmo registro.
    const again = await domains.add('b.oferta.com');
    expect(again).toMatchObject({ created: true, domain: { id: used.id, lifecycleStatus: 'registered' } });
  });
});

describe('vercelProjectDomainsFromEnv', () => {
  it('is null without token/project and treats 409 as already attached when the project owns the domain', async () => {
    expect(vercelProjectDomainsFromEnv({})).toBeNull();
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') return new Response('{"error":{"code":"domain_already_in_use"}}', { status: 409 });
      return Response.json({ name: 'a.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.a.com', value: 'v' }] });
    }) as unknown as typeof fetch;
    const client = vercelProjectDomainsFromEnv({ LANDINGLAB_VERCEL_TOKEN: 't', VSL_VERCEL_PROJECT_ID: 'prj_1', VSL_VERCEL_TEAM_ID: 'team_1' }, fetcher)!;
    expect(await client.attach('a.com')).toMatchObject({ status: 'already_attached', verification: [{ type: 'TXT' }] });
    expect(calls).toEqual(['POST https://api.vercel.com/v10/projects/prj_1/domains?teamId=team_1', 'GET https://api.vercel.com/v9/projects/prj_1/domains/a.com?teamId=team_1']);
  });
});

describe('isPrivateVslAddress', () => {
  it('blocks private, loopback, link-local and reserved v4/v6; allows public addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'ff02::1', 'not-an-ip'])
      expect(isPrivateVslAddress(ip), ip).toBe(true);
    for (const ip of ['76.76.21.21', '8.8.8.8', '216.198.79.1', '2606:4700::6810:84e5', '2001:4860:4860::8888'])
      expect(isPrivateVslAddress(ip), ip).toBe(false);
  });
});

describe('pinnedHealthProbe', () => {
  // Conecta no IP fixado mesmo com hostname que não resolve, e manda o hostname no SNI (ClientHello).
  it('connects to the pinned address with SNI = hostname, without resolving DNS again', async () => {
    let hello = Buffer.alloc(0);
    const server = createServer((socket) => {
      socket.once('data', (chunk) => { hello = Buffer.concat([hello, chunk]); socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(pinnedHealthProbe({ hostname: 'pinned.vsl-test.invalid', address: '127.0.0.1', family: 4, path: '/__vsl/health', timeoutMs: 2000, port }))
        .rejects.toBeDefined();
    } finally {
      server.close();
    }
    expect(hello.length).toBeGreaterThan(0);
    expect(hello.includes(Buffer.from('pinned.vsl-test.invalid'))).toBe(true);
  });

  it('times out a silent server', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    try {
      await expect(pinnedHealthProbe({ hostname: 'slow.vsl-test.invalid', address: '127.0.0.1', family: 4, path: '/__vsl/health', timeoutMs: 100, port })).rejects.toBeDefined();
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
