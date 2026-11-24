'use client';

// "Baixar pacote" — export da landing em 2 formatos, dentro da seção Publicação.
//   · HTML portátil: index.html + assets/ + offers.json (sobe em qualquer hospedagem).
//   · Tema Shopify: layout + seção + snippets + template de produto ligados às variantes.
// O worker monta os zips (pode levar alguns minutos: baixa todos os assets) e o
// GET /api/landing-pages/:id/exports devolve os links assinados (válidos por 1 h).

import { useCallback, useEffect, useRef, useState } from 'react';

import { DsButton } from '@/components/ds';

interface ExportFile {
  name: string;
  format: 'html' | 'shopify' | null;
  bytes: number | null;
  createdAt: string | null;
  url: string | null;
}

interface ExportsPayload {
  ok: boolean;
  message?: string;
  jobId?: string;
  job?: { state: string; progress: unknown; failedReason: string | null } | null;
  files?: ExportFile[];
}

const POLL_MS = 3000;
const POLL_MAX = 300; // 15 min

const FORMAT_LABEL: Record<'html' | 'shopify', string> = {
  html: 'HTML portátil (.zip)',
  shopify: 'Tema Shopify (.zip)',
};

function formatBytes(n: number | null): string {
  if (n == null) return '';
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function stepLabel(progress: unknown): string {
  const step = (progress as { step?: string } | null)?.step;
  if (step === 'assets') return 'Baixando imagens, CSS e fontes…';
  if (step === 'upload') return 'Enviando os pacotes…';
  return 'Na fila…';
}

export default function ExportPackages({ landingId }: { landingId: string }): JSX.Element {
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base = `/api/landing-pages/${landingId}/exports`;

  const load = useCallback(
    async (jobId?: string): Promise<ExportsPayload> => {
      const res = await fetch(jobId ? `${base}?jobId=${encodeURIComponent(jobId)}` : base, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as ExportsPayload;
      if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
      setFiles(body.files ?? []);
      return body;
    },
    [base],
  );

  useEffect(() => {
    load().catch(() => undefined);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const poll = useCallback(
    (jobId: string, attempt: number) => {
      timer.current = setTimeout(async () => {
        try {
          const body = await load(jobId);
          const state = body.job?.state;
          if (state === 'completed') {
            setRunning(false);
            setStatus('Pacotes prontos.');
            return;
          }
          if (state === 'failed') {
            setRunning(false);
            setStatus(null);
            setError(body.job?.failedReason || 'O export falhou.');
            return;
          }
          if (state === 'missing') {
            setRunning(false);
            setStatus(null);
            setError('O job sumiu da fila. Tente gerar de novo.');
            return;
          }
          if (attempt >= POLL_MAX) {
            setRunning(false);
            setStatus('Ainda processando. Volte em alguns minutos e recarregue a página.');
            return;
          }
          setStatus(stepLabel(body.job?.progress));
          poll(jobId, attempt + 1);
        } catch (err) {
          setRunning(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      }, POLL_MS);
    },
    [load],
  );

  const generate = async () => {
    setError(null);
    setRunning(true);
    setStatus('Na fila…');
    try {
      const res = await fetch(base, { method: 'POST' });
      const body = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as ExportsPayload;
      if (!res.ok || !body.ok || !body.jobId) throw new Error(body.message ?? `HTTP ${res.status}`);
      poll(body.jobId, 0);
    } catch (err) {
      setRunning(false);
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Só o par mais recente de cada formato.
  const latest = (['html', 'shopify'] as const)
    .map((format) => files.find((f) => f.format === format))
    .filter((f): f is ExportFile => Boolean(f));

  return (
    <s-stack gap="small-300">
      <s-heading>Baixar pacote</s-heading>
      <s-paragraph color="subdued">
        Gera dois zips: HTML portátil (sobe em qualquer hospedagem) e tema Shopify (ligado às variantes do produto).
        Cada um traz um CLAUDE.md com as instruções. Pode levar alguns minutos.
      </s-paragraph>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <DsButton onClick={generate} disabled={running} loading={running}>
          {latest.length ? 'Gerar de novo' : 'Baixar pacote'}
        </DsButton>
        {status && <s-text color="subdued">{status}</s-text>}
      </s-stack>
      {error && <s-text tone="critical">{error}</s-text>}
      {latest.length > 0 && (
        <s-stack gap="small-100">
          {latest.map((f) => (
            <s-stack key={f.name} direction="inline" gap="small-200" alignItems="center">
              {f.url ? (
                <s-link href={f.url}>{FORMAT_LABEL[f.format!]}</s-link>
              ) : (
                <s-text>{FORMAT_LABEL[f.format!]}</s-text>
              )}
              <s-text color="subdued">
                {[formatBytes(f.bytes), f.createdAt ? new Date(f.createdAt).toLocaleString('pt-BR') : '']
                  .filter(Boolean)
                  .join(' · ')}
              </s-text>
            </s-stack>
          ))}
        </s-stack>
      )}
    </s-stack>
  );
}
