'use client';

// Story 26.1 — "Versões": as 10 últimas versões salvas pelo editor visual (HTML de antes de cada gravação).
// Restaurar troca o html_body e guarda o atual como versão — dá para desfazer.

import { useEffect, useState } from 'react';

import { DsButton, DsModal, DsNoticeBanner } from '@/components/ds';

interface Version {
  id: string;
  reason: string;
  bytes: number;
  createdAt: string;
}

interface Props {
  open: boolean;
  landingId: string;
  pendingEdits: number;
  onClose: () => void;
  onRestored: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function VersionsModal({ open, landingId, pendingEdits, onClose, onRestored }: Props): JSX.Element {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setVersions(null);
    setError(null);
    fetch(`/api/landing-pages/${landingId}/edit-inline/versions`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; versions?: Version[] };
        if (!alive) return;
        if (!res.ok || !json.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
        setVersions(json.versions ?? []);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Erro ao listar versões');
      });
    return () => {
      alive = false;
    };
  }, [open, landingId]);

  async function restore(v: Version): Promise<void> {
    const lost = pendingEdits > 0 ? ` As ${pendingEdits} edição(ões) não salvas serão descartadas.` : '';
    if (!confirm(`Voltar a página para a versão de ${formatDate(v.createdAt)}?${lost}`)) return;
    setRestoring(v.id);
    setError(null);
    try {
      const res = await fetch(`/api/landing-pages/${landingId}/edit-inline/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshotId: v.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !json.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao restaurar');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <DsModal open={open} onClose={onClose} heading="Versões salvas pelo editor" secondaryActions={[{ content: 'Fechar', onAction: onClose }]}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {error && <DsNoticeBanner tone="critical">{error}</DsNoticeBanner>}
        {!versions && !error && <s-spinner size="base" accessibilityLabel="Carregando versões" />}
        {versions && versions.length === 0 && <s-text color="subdued">Nenhuma versão salva ainda.</s-text>}
        {versions?.map((v) => (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <s-text>
              {formatDate(v.createdAt)} · {v.reason === 'inline-edit-restore' ? 'antes de uma restauração' : 'antes de salvar'} ·{' '}
              {Math.round(v.bytes / 1024)} KB
            </s-text>
            <DsButton variant="secondary" onClick={() => void restore(v)} loading={restoring === v.id} disabled={!!restoring}>
              Restaurar
            </DsButton>
          </div>
        ))}
      </div>
    </DsModal>
  );
}
