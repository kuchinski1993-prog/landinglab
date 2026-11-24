'use client';

// Story 0.6 (QA F3) — enquanto a publicação está `awaiting_ssl`, chama
// "Verificar novamente" sozinho com backoff (≈ 3 min no total). O certificado
// de um subdomínio novo costuma levar de 10 a 60 s; sem isso o owner teria de
// clicar manualmente.

import { useEffect, useRef } from 'react';

import { verifyPublication, type PublishApiPayload } from './publish-client';

/** Esperas entre tentativas (ms): 10+15+20+30+45+60 = 180 s. */
export const AUTO_VERIFY_DELAYS_MS: readonly number[] = [10_000, 15_000, 20_000, 30_000, 45_000, 60_000];

interface Options {
  /** Deployment a verificar; `null` desliga. */
  deploymentId: string | null;
  /** Liga o ciclo (ex.: status === 'awaiting_ssl'). */
  active: boolean;
  /** Chamado a cada resposta. O ciclo para quando o status deixa de ser `awaiting_ssl`. */
  onResult: (payload: PublishApiPayload) => void;
  /** Chamado quando as tentativas acabam sem sucesso. */
  onGiveUp?: () => void;
  delaysMs?: readonly number[];
}

export function useAutoVerify({ deploymentId, active, onResult, onGiveUp, delaysMs = AUTO_VERIFY_DELAYS_MS }: Options): void {
  const onResultRef = useRef(onResult);
  const onGiveUpRef = useRef(onGiveUp);
  onResultRef.current = onResult;
  onGiveUpRef.current = onGiveUp;

  useEffect(() => {
    if (!active || !deploymentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (attempt: number): void => {
      if (cancelled) return;
      if (attempt >= delaysMs.length) {
        onGiveUpRef.current?.();
        return;
      }
      timer = setTimeout(async () => {
        if (cancelled) return;
        const payload = await verifyPublication(deploymentId);
        if (cancelled) return;
        onResultRef.current(payload);
        // Continua só enquanto o SSL ainda está a caminho.
        if (payload.status === 'awaiting_ssl' && payload.code === 'SSL_PENDING') schedule(attempt + 1);
      }, delaysMs[attempt]);
    };
    schedule(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, deploymentId, delaysMs]);
}
