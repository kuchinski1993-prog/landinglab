// GET /api/landing-pages/[id]/history
//
// Timeline agregada de snapshots do html_body + deployments para a UI de
// histórico (HistorySection). Retorna até 30 eventos ordenados por createdAt
// desc (20 snapshots + 10 deployments merged).
//
// Sem mutação — auth pattern idêntico aos outros GETs do dir.

import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingDeployments } from '@blackshop/db';
import { landingHtmlSnapshots } from '@blackshop/db/schema-landinglab-core';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { getDb } from '@/lib/landing-db';

export const runtime = 'nodejs';
export const maxDuration = 10;

type EventType = 'snapshot' | 'deployment';

interface HistoryEvent {
  id: string;
  type: EventType;
  label: string;
  actor: string;
  bytes?: number;
  /** Diff bytesAfter - bytes (undefined se snapshot não gravou bytesAfter). */
  changeSize?: number;
  hostname?: string;
  createdAt: string;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function labelForSnapshot(reason: string): string {
  // GAP-11 (2026-09-28): normaliza casing/whitespace antes do switch. Workers
  // podem gravar reason com casing variável ('Apply-Bundle', 'RECLONE', etc)
  // — sem esse normalize, cairiam no default (capitalize raw).
  const normalized = reason.trim().toLowerCase();
  switch (normalized) {
    case 'clone-initial':
      return 'Clone inicial';
    case 'reclone':
      return 'Reclone realizado';
    case 'bundle-rewrite':
      return 'Bundles atualizados';
    case 'apply-bundle':
    case 'apply-bundle full pipeline':
      return 'Bundle aplicado';
    case 'semantic-write':
      return 'Edição semântica';
    case 'pre-semantic':
      return 'Edição semântica';
    case 'translation-complete':
      return 'Tradução concluída';
    default:
      return capitalize(reason);
  }
}

function labelForDeployment(status: string, hostname: string | null): string {
  if (status === 'published') {
    return hostname ? `Publicado em ${hostname}` : 'Publicado';
  }
  if (status === 'unpublished') {
    return 'Despublicado';
  }
  return `Deploy (${status})`;
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landingId = params.id;
  const db = getDb();

  const [snapshots, deployments] = await Promise.all([
    db
      .select({
        id: landingHtmlSnapshots.id,
        reason: landingHtmlSnapshots.reason,
        actor: landingHtmlSnapshots.actor,
        bytes: landingHtmlSnapshots.bytes,
        bytesAfter: landingHtmlSnapshots.bytesAfter,
        createdAt: landingHtmlSnapshots.createdAt,
      })
      .from(landingHtmlSnapshots)
      .where(eq(landingHtmlSnapshots.landingPageId, landingId))
      .orderBy(desc(landingHtmlSnapshots.createdAt))
      .limit(20),
    db
      .select({
        id: landingDeployments.id,
        hostname: landingDeployments.hostname,
        deploymentStatus: landingDeployments.deploymentStatus,
        publishedAt: landingDeployments.publishedAt,
        createdAt: landingDeployments.createdAt,
      })
      .from(landingDeployments)
      .where(eq(landingDeployments.landingPageId, landingId))
      .orderBy(desc(landingDeployments.createdAt))
      .limit(10),
  ]);

  const events: HistoryEvent[] = [];

  for (const s of snapshots) {
    const event: HistoryEvent = {
      id: s.id,
      type: 'snapshot',
      label: labelForSnapshot(s.reason),
      actor: s.actor,
      bytes: s.bytes,
      createdAt: s.createdAt.toISOString(),
    };
    if (s.bytesAfter != null) {
      event.changeSize = s.bytesAfter - s.bytes;
    }
    events.push(event);
  }

  for (const d of deployments) {
    // Deployment usa published_at quando disponível (marco real do evento),
    // com fallback pra created_at. Actor é sempre 'system' — deploys são
    // disparados pelo worker/backoffice, não têm user attribution granular.
    const eventDate = d.publishedAt ?? d.createdAt;
    events.push({
      id: d.id,
      type: 'deployment',
      label: labelForDeployment(d.deploymentStatus, d.hostname),
      actor: 'system',
      hostname: d.hostname,
      createdAt: eventDate.toISOString(),
    });
  }

  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return NextResponse.json({ ok: true, events });
}
