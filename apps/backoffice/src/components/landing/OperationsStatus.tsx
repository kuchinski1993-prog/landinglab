'use client';

// @ds-migrated — Story 20.10b (PR2): selos no design system (s-badge); mesma regra de quais aparecem.
//
// OperationsStatus — status pill compacto para o header do editor.
// Mostra em 1 linha: clone state | fidelity | translation | publish
// Reutiliza estados já calculados — não faz fetch, não tem side effects.
//
// Regra de ouro: badges "estados normais" ficam ocultos pra não poluir.
// Ex: clone ready + fidelity HEALTHY + translation done + published = 1 badge.

import { deriveCloneLifecycle } from '@/lib/clone-lifecycle';
import { parseFidelityFromCloneMetadata } from '@/lib/fidelity-badge';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
}

interface BadgeSpec {
  key: string;
  tone: 'success' | 'critical' | 'info' | 'warning' | undefined;
  label: string;
}

function buildBadges(landing: LandingPageRow): BadgeSpec[] {
  const badges: BadgeSpec[] = [];

  // 1) Clone lifecycle (só clones passam pelo cloner).
  if (landing.generationMode === 'cloned') {
    const lifecycle = deriveCloneLifecycle(
      landing.generationMode,
      landing.cloneMetadata,
      landing.clonedAt,
      landing.htmlBody
    );
    if (lifecycle.status === 'cloning') {
      badges.push({ key: 'clone', tone: 'warning', label: 'Clonando…' });
    } else if (lifecycle.status === 'failed') {
      badges.push({ key: 'clone', tone: 'critical', label: 'Clone falhou' });
    } else if (lifecycle.status === 'processing') {
      badges.push({ key: 'clone', tone: 'info', label: 'Processando…' });
    }

    // 2) Fidelity — só faz sentido se clone está ready. Landings pré-fidelity
    //    ficam em UNKNOWN — não polui header.
    if (lifecycle.status === 'ready') {
      const fidelity = parseFidelityFromCloneMetadata(landing.cloneMetadata);
      if (fidelity.verdict === 'HEALTHY') {
        badges.push({ key: 'fidelity', tone: 'success', label: 'Fidelidade OK' });
      } else if (fidelity.verdict === 'DEGRADED') {
        badges.push({ key: 'fidelity', tone: 'warning', label: 'Fidelidade: revisar' });
      } else if (fidelity.verdict === 'BLOCKED') {
        badges.push({ key: 'fidelity', tone: 'critical', label: 'Fidelidade: bloqueado' });
      }
    }
  }

  // 3) Translation — só mostra se está em transição ou falhou.
  const tStatus = landing.translationStatus;
  if (tStatus === 'text_running' || tStatus === 'images_running') {
    badges.push({ key: 'translation', tone: 'info', label: 'Traduzindo…' });
  } else if (tStatus === 'failed') {
    badges.push({ key: 'translation', tone: 'critical', label: 'Tradução falhou' });
  } else if (tStatus === 'done_with_warnings') {
    badges.push({ key: 'translation', tone: 'warning', label: 'Tradução: avisos' });
  }

  // 4) Publish — sempre mostra (é o estado mais interessante do header).
  if (landing.status === 'published') {
    badges.push({ key: 'publish', tone: 'success', label: 'Publicada' });
  } else if (landing.publishedAt) {
    // Era publicada, voltou pra draft (unpublish/archive → re-abriu como draft).
    badges.push({ key: 'publish', tone: 'warning', label: 'Rascunho (foi publicada)' });
  } else {
    // tone=undefined mapeia pro tom neutro/subdued do Polaris Badge.
    badges.push({ key: 'publish', tone: undefined, label: 'Rascunho' });
  }

  return badges;
}

export default function OperationsStatus({ landing }: Props): JSX.Element | null {
  const badges = buildBadges(landing);
  if (badges.length === 0) return null;

  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      {badges.map((b) => (
        // tone=undefined → selo neutro (o "subdued" do Polaris React).
        <s-badge key={b.key} tone={b.tone ?? 'neutral'}>
          {b.label}
        </s-badge>
      ))}
    </s-stack>
  );
}
