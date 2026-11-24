// Story 0.6 — chamadas do navegador ao publicador (checklist + "Verificar
// novamente") e o mapeamento estado → tom do banner, compartilhados por
// PublishActions.tsx e editor/sections/PublishSection.tsx.

import type { LandingPublishCheckItem } from '@/lib/landing-publish-check';

export type PublishUiStatus = 'published' | 'awaiting_ssl' | 'awaiting_dns' | 'publish_failed' | 'rejected';

/** Resposta JSON da rota publish-on-domain e do /verify (PublishCoreResult sem httpStatus). */
export interface PublishApiPayload {
  ok: boolean;
  status?: PublishUiStatus;
  code?: string;
  message?: string;
  retryable?: boolean;
  hostname?: string;
  publishedUrl?: string;
  deploymentId?: string;
  sslProvisioned?: boolean;
  /** Republicação de endereço já no ar com reverificação falhando (continua publicada). */
  warning?: { code: string; message: string };
  details?: {
    items?: LandingPublishCheckItem[];
    conflict?: { landingId: string; landingTitle: string | null; hostname: string };
    dnsRecords?: unknown;
    verification?: Array<{ type: string; domain: string; value: string; reason?: string }>;
    fixUrl?: string;
  };
}

export interface PublishCheckPayload {
  ok: boolean;
  ready?: boolean;
  items?: LandingPublishCheckItem[];
  message?: string;
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POST /api/landing-domains/publish-on-domain/verify. Nunca lança. */
export async function verifyPublication(deploymentId: string): Promise<PublishApiPayload> {
  try {
    const res = await fetch('/api/landing-domains/publish-on-domain/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deploymentId }),
    });
    const payload = await readJson<PublishApiPayload>(res);
    return payload ?? { ok: false, status: 'publish_failed', message: `Falha ao verificar (HTTP ${res.status}). Tente de novo.` };
  } catch (err) {
    return {
      ok: false,
      status: 'publish_failed',
      retryable: true,
      message: `Sem conexão com o backoffice (${err instanceof Error ? err.message : String(err)}). Tente de novo.`,
    };
  }
}

/** GET /api/landing-pages/[id]/publish-check. `null` se não deu para carregar. */
export async function loadPublishCheck(landingPageId: string): Promise<PublishCheckPayload | null> {
  try {
    const res = await fetch(`/api/landing-pages/${encodeURIComponent(landingPageId)}/publish-check`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return await readJson<PublishCheckPayload>(res);
  } catch {
    return null;
  }
}

export function bannerToneFor(
  status: PublishUiStatus | undefined,
  ok: boolean,
  hasWarning = false,
): 'success' | 'warning' | 'critical' {
  if (ok && status === 'published') return hasWarning ? 'warning' : 'success';
  if (status === 'awaiting_ssl' || status === 'awaiting_dns') return 'warning';
  return 'critical';
}

/** Registros DNS (landing_domains.dns_records ou verificação da Vercel) em linhas legíveis. */
export function describeDnsRecords(payload: Pick<PublishApiPayload, 'details'>): string[] {
  const lines: string[] = [];
  for (const v of payload.details?.verification ?? []) {
    lines.push(`${v.type} ${v.domain} → ${v.value}`);
  }
  const raw = payload.details?.dnsRecords;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { records?: unknown }).records)
      ? ((raw as { records: unknown[] }).records)
      : [];
  for (const r of list) {
    if (r && typeof r === 'object') {
      const rec = r as { type?: unknown; name?: unknown; host?: unknown; value?: unknown; content?: unknown; answer?: unknown };
      const type = typeof rec.type === 'string' ? rec.type : '';
      const name = typeof rec.name === 'string' ? rec.name : typeof rec.host === 'string' ? rec.host : '';
      const value =
        typeof rec.value === 'string' ? rec.value : typeof rec.content === 'string' ? rec.content : typeof rec.answer === 'string' ? rec.answer : '';
      if (type || value) lines.push(`${type} ${name || '@'} → ${value}`.trim());
    }
  }
  return lines;
}
