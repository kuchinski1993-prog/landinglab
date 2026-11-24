// Helper reutilizável pra enfileirar job apply-bundle no worker BullMQ.
// Uso: chamar sempre que alguma coisa que afeta o HTML da landing mudar:
//   - Variants criados/editados (preços, currency)
//   - Pixel Meta criado/editado
//   - Subs config alterado
//   - Publish (garantir HTML final tem tudo antes de servir)
//   - Slider-images alterado
//
// Zero risco: se a API ou o Redis estiverem fora, retorna false sem throw.
// Chamador loga warn mas segue. Idempotente no worker (§4 apply-bundle limpa
// markers anteriores antes de reinjetar).

import { enqueueJob } from './api-queue';

export interface EnqueueResult {
  queued: boolean;
  jobId?: string;
  reason?: string;
  deduped?: boolean;
}

/**
 * Enfileira job apply-bundle pro worker reprocessar HTML da landing.
 *
 * @param landingPageId — UUID da landing_pages
 * @param source — quem chamou (pra log — ex: "publish", "pixel-update", "variants-changed")
 *
 * Dedupe: se já existe job pra mesma landingPageId em waiting/active/delayed,
 * retorna o jobId existente ao invés de enfileirar duplicado. Evita spam quando
 * usuário salva bundles várias vezes seguidas (worker leva ~10s por rodada).
 */
export async function enqueueApplyBundle(
  landingPageId: string,
  source: string,
): Promise<EnqueueResult> {
  try {
    // Dedupe na API: job pendente para a mesma landing → devolve o existente.
    const { jobId, deduped } = await enqueueJob(
      'landinglab.apply-bundle',
      'apply-bundle',
      { landingPageId, source },
      { attempts: 3, removeOnComplete: { age: 24 * 3600, count: 100 } },
      { dedupeBy: 'landingPageId' },
    );
    return deduped ? { queued: true, jobId, deduped: true } : { queued: true, jobId };
  } catch (err) {
    console.warn(
      `[enqueue-apply-bundle from=${source}] failed (non-critical):`,
      (err as Error).message,
    );
    return { queued: false, reason: (err as Error).message };
  }
}
