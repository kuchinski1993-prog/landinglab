// Story 18.3 · Códigos dos jobs no catálogo da 18.1 e em docs/architecture/erros.md (nos dois
// sentidos para os códigos deste pacote) + JobEnqueueError → 503 tipado.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { toErrorResponse } from '@blackshop/errors';
import { assertCatalogDocumented } from '@blackshop/errors/testing';
import { describe, expect, it } from 'vitest';

import { JobEnqueueError, JOB_ERRORS, LOJA_JOB_ERRORS, MARKETING_JOB_ERRORS } from '../index.js';

const doc = path.resolve(import.meta.dirname, '../../../../docs/architecture/erros.md');
const OWN = new Set([
  ...Object.keys(JOB_ERRORS.entries),
  ...Object.keys(LOJA_JOB_ERRORS.entries),
  ...Object.keys(MARKETING_JOB_ERRORS.entries),
]);

/**
 * Story 18.5 · códigos da seção "Módulo `loja` (rotas)" (catálogo LOJA_ERRORS da API, testado nos dois
 * sentidos por apps/api/src/__tests__/errors-doc.test.ts). Mesmo prefixo `loja.`, outro catálogo.
 */
function lojaRouteCodes(): string[] {
  const text = readFileSync(doc, 'utf8');
  const start = text.indexOf('## Módulo `loja` (rotas)');
  if (start < 0) return [];
  const next = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, next < 0 ? undefined : next);
  return [...section.matchAll(/^\|\s*`(loja\.[^`]+)`\s*\|/gm)].map((m) => m[1]!);
}

describe('catálogo dos jobs', () => {
  it('cada código tem linha exata na doc e cada linha loja.*/plataforma.job_* deste pacote existe', () => {
    // Outras linhas (comum, plataforma.job_not_found…) são testadas em packages/errors e apps/api.
    assertCatalogDocumented([JOB_ERRORS, LOJA_JOB_ERRORS, MARKETING_JOB_ERRORS], doc, {
      ignore: { test: (code: string) => !code.startsWith('loja.') && !OWN.has(code) } as RegExp,
      exceptions: lojaRouteCodes().filter((code) => !OWN.has(code)),
    });
  });

  it('códigos esperados pela story', () => {
    expect([...OWN].sort()).toEqual([
      'loja.job_store_mismatch', // Story 17.2b
      'loja.mirror_ambiguous',
      'loja.orders_backfill_invalid_input',
      'loja.orders_backfill_not_configured',
      'loja.orders_backfill_source_rejected',
      'loja.orders_backfill_source_unavailable',
      'loja.reconcile_tag_not_removed',
      'loja.reconcile_too_soon',
      'loja.relink_product_not_found',
      'loja.relink_publish_enqueue_failed',
      'loja.relink_source_empty',
      'loja.relink_source_rejected',
      'loja.relink_source_unavailable',
      'marketing.capi_event_rejected', // Story 18.8
      'marketing.capi_not_configured',
      'marketing.capi_out_of_window',
      'marketing.capi_token_rejected',
      'marketing.capi_unavailable',
      'marketing.catalog_not_configured', // Story 24.4
      'marketing.catalog_rejected',
      'marketing.catalog_token_rejected',
      'marketing.catalog_unavailable',
      'plataforma.job_enqueue_failed',
      'plataforma.job_unclassified',
    ]);
  });

  it('JobEnqueueError vira 503 plataforma.job_enqueue_failed com a mensagem do catálogo', () => {
    const response = toErrorResponse(new JobEnqueueError({ queue: 'q', jobKey: 'k' }), { catalogs: [JOB_ERRORS] });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'plataforma.job_enqueue_failed',
      message: 'Não foi possível agendar a tarefa. Tente de novo.',
    });
  });
});
