import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { normalizeVslHostname } from './domains.js';
export class VslDomainRepository {
  constructor(private readonly sql: Sql) {}
  async create(pageId:string, rawHostname:string){const hostname=normalizeVslHostname(rawHostname); const [row]=await this.sql`INSERT INTO vsl_domains(id,page_id,hostname) VALUES(${randomUUID()},${pageId},${hostname}) RETURNING *`; return row;}
  async get(id:string){const [row]=await this.sql`SELECT * FROM vsl_domains WHERE id=${id}`; return row ?? null;}
  async transition(id:string, state:{dnsStatus?:string;sslStatus?:string;publicationStatus?:string;error?:string}, expected?:string){const dns=state.dnsStatus??null, ssl=state.sslStatus??null, publication=state.publicationStatus??null, error=state.error??null, version=expected??null; const [row]=await this.sql`UPDATE vsl_domains SET dns_status=COALESCE(${dns},dns_status),ssl_status=COALESCE(${ssl},ssl_status),publication_status=COALESCE(${publication},publication_status),last_error=${error},updated_at=now() WHERE id=${id} AND (${version}::timestamptz IS NULL OR updated_at=${version}::timestamptz) RETURNING *`; if(!row) throw new Error('VSL domain concurrency conflict'); return row;}
  async publish(pageId:string, domainId:string, revisionId:string){return this.sql.begin(async tx=>{const [domain]=await tx`SELECT * FROM vsl_domains WHERE id=${domainId} AND page_id=${pageId} FOR UPDATE`; if(!domain||domain.dns_status!=='verified'||domain.ssl_status!=='provisioned') throw new Error('VSL domain is not ready'); await tx`UPDATE vsl_domains SET publication_status='published',updated_at=now() WHERE id=${domainId}`; await tx`UPDATE landing_pages SET published_version_id=${revisionId},updated_at=now() WHERE id=${pageId}`; await tx`INSERT INTO vsl_publications(id,page_id,domain_id,revision_id) VALUES(${randomUUID()},${pageId},${domainId},${revisionId}) ON CONFLICT(page_id,revision_id) DO NOTHING`; await tx`INSERT INTO vsl_cache_invalidations(id,page_id,domain_id,cache_key,reason) VALUES(${randomUUID()},${pageId},${domainId},${pageId},'publish')`; return {pageId,domainId,revisionId};});}
}
