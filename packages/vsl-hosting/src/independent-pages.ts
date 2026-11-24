import type { Sql } from 'postgres';

import { vslError } from './errors.js';
import type { VslStorage } from './storage.js';

/** Páginas G3. O import (HTML/ZIP) é assíncrono: ver page-import-jobs.ts. */
export class VslIndependentPages {
  constructor(readonly sql: Sql, readonly storage: VslStorage) {}

  async list() {
    // `usedBy`: etapas ativas (projeto não arquivado) que usam qualquer revisão desta página.
    return this.sql`SELECT p.id, p.name, p.locale, p.current_revision_id, p.created_at, p.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId',pr.id,'projectName',pr.name,'stepId',s.id,'stepName',s.name,'pageRevisionId',s.page_revision_id)
          ORDER BY pr.name, s.position)
        FROM vsl_steps s JOIN vsl_page_revisions r ON r.id=s.page_revision_id JOIN vsl_projects pr ON pr.id=s.project_id
        WHERE r.page_id=p.id AND s.status<>'archived' AND pr.status<>'archived'), '[]'::jsonb) AS "usedBy"
      FROM vsl_pages p WHERE p.store_id='l0i' ORDER BY p.updated_at DESC`;
  }

  async create(name: string) {
    if (!name?.trim() || name.trim().length > 200) throw vslError('validation_failed', { field: 'name' });
    const [row] = await this.sql`INSERT INTO vsl_pages(name,store_id) VALUES(${name.trim()},'l0i') RETURNING *`;
    return row!;
  }

  async get(pageId: string) {
    const [page] = await this.sql`SELECT * FROM vsl_pages WHERE id=${pageId} AND store_id='l0i'`;
    if (!page) throw vslError('page_not_found');
    const revisions = await this.sql`SELECT id,version_number,entry_path,storage_prefix,validation_report,status,created_at FROM vsl_page_revisions WHERE page_id=${pageId} ORDER BY version_number DESC`;
    return { page, revisions };
  }
}
