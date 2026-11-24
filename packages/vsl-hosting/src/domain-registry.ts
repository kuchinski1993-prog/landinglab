import { randomUUID } from 'node:crypto';

import { normalizeVslHostname } from './domains.js';
import { normalizeVslPathname } from './pathnames.js';

type Sql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>) & { begin?: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown> };

export class VslDomainRegistryRepository {
  constructor(private readonly sql: Sql) {}

  async list() { return this.sql`SELECT id, hostname, registrar, dns_status AS "dnsStatus", ssl_status AS "sslStatus", lifecycle_status AS "lifecycleStatus", expires_at AS "expiresAt", version, updated_at AS "updatedAt" FROM blackshop_domains ORDER BY hostname`; }
  async adopt(rawHostname: string, registrar?: string) {
    const hostname = normalizeVslHostname(rawHostname);
    const [row] = await this.sql`INSERT INTO blackshop_domains(id, hostname, registrar) VALUES(${randomUUID()}, ${hostname}, ${registrar ?? null}) ON CONFLICT(hostname) DO UPDATE SET updated_at=now() RETURNING id, hostname, registrar, dns_status AS "dnsStatus", ssl_status AS "sslStatus", lifecycle_status AS "lifecycleStatus", version, updated_at AS "updatedAt"`;
    return row;
  }
  async bind(pageId: string, domainId: string, rawPathname: string, revisionId?: string, expectedVersion?: number) {
    const pathname = normalizeVslPathname(rawPathname);
    const [domain] = await this.sql`SELECT id FROM blackshop_domains WHERE id=${domainId} AND lifecycle_status NOT IN ('archived','expired')`;
    if (!domain) throw new Error('Domain not found or unavailable');
    const [row] = await this.sql`INSERT INTO vsl_domain_bindings(id,domain_id,page_id,revision_id,pathname,normalized_pathname) VALUES(${randomUUID()},${domainId},${pageId},${revisionId ?? null},${pathname},${pathname}) ON CONFLICT(domain_id,normalized_pathname) DO UPDATE SET revision_id=COALESCE(EXCLUDED.revision_id,vsl_domain_bindings.revision_id), updated_at=now(), version=vsl_domain_bindings.version+1 WHERE vsl_domain_bindings.page_id=${pageId} AND (${expectedVersion ?? null}::integer IS NULL OR vsl_domain_bindings.version=${expectedVersion ?? null}) RETURNING *`;
    if (!row) throw new Error('Pathname is already bound or concurrency conflict');
    return row;
  }
  async resolve(hostname: string, rawPathname: string) {
    const host = normalizeVslHostname(hostname); const pathname = normalizeVslPathname(rawPathname);
    const [row] = await this.sql`SELECT b.*, d.hostname, d.dns_status AS "dnsStatus", d.ssl_status AS "sslStatus" FROM vsl_domain_bindings b JOIN blackshop_domains d ON d.id=b.domain_id WHERE d.hostname=${host} AND d.lifecycle_status NOT IN ('archived','expired') AND b.normalized_pathname=${pathname} AND b.publication_status='published' LIMIT 1`;
    return row ?? null;
  }
}
