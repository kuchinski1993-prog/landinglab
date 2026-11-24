import { createHash, randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { applyVslTranslations, extractVslTranslationUnits, type VslTranslationUnit } from './translation-extract.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export class VslTranslationRepository {
  constructor(private readonly sql: Sql) {}
  async createBatch(variantId:string, sourceRevisionId:string, locale:string, html:string): Promise<{id:string;sourceHash:string;units:VslTranslationUnit[]}> {
    const sourceHash=sha(html), id=randomUUID(), units=extractVslTranslationUnits(html, sourceHash);
    await this.sql`INSERT INTO vsl_translation_batches(id,variant_id,source_revision_id,source_hash,target_locale,report) VALUES(${id},${variantId},${sourceRevisionId},${sourceHash},${locale},${JSON.stringify({count:units.length})}::jsonb)`;
    for(const unit of units) await this.sql`INSERT INTO vsl_translation_units(id,batch_id,unit_key,source_hash,locator,extraction_type,attribute,original,context) VALUES(${randomUUID()},${id},${unit.id},${sourceHash},${JSON.stringify(unit.locator)}::jsonb,${unit.type},${unit.attribute??null},${unit.original},${unit.context})`;
    return {id,sourceHash,units};
  }
  async listUnits(batchId:string):Promise<unknown[]> { return Array.from(await this.sql`SELECT * FROM vsl_translation_units WHERE batch_id=${batchId} ORDER BY id`); }
  reinsert(html:string, units:VslTranslationUnit[], values:Record<string,string>, sourceHash:string):string { return applyVslTranslations(html,units,values,sourceHash); }
}
