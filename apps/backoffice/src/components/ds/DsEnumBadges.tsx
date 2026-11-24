'use client';

// Story 20.15b (PR C) — selos do Atendimento resolvidos pelo dicionário PT-BR central (`lib/labels/pt-BR`),
// no lugar de `trustshield/components/design/StatusBadge.tsx` (Polaris React). Mesma regra: texto e tom
// vêm do dicionário; com `hideEmpty` (padrão), valor vazio não mostra selo. Só apresentação.

import { DsToneBadge } from './DsToneBadge';

import { categoryLabel, refundStatusLabel, statusLabel, verificationLabel } from '@/lib/labels/pt-BR';

interface EnumBadgeProps {
  value: string | null | undefined;
  /** Se true, esconde o selo quando o valor é vazio. Padrão: true. */
  hideEmpty?: boolean;
}

/** Status de e-mail recebido (unread/opened/pending_human/…). */
export function DsStatusBadge({ value, hideEmpty = true }: EnumBadgeProps): JSX.Element | null {
  if (hideEmpty && !value) return null;
  const { label, tone } = statusLabel(value);
  return <DsToneBadge tone={tone}>{label}</DsToneBadge>;
}

/** Categoria da classificação (refund_request, chargeback_threat, …). */
export function DsCategoryBadge({ value, hideEmpty = true }: EnumBadgeProps): JSX.Element | null {
  if (hideEmpty && !value) return null;
  const { label, tone } = categoryLabel(value);
  return <DsToneBadge tone={tone}>{label}</DsToneBadge>;
}

/** Verificação do remetente (verified_match, suspicious_claim, …). */
export function DsVerificationBadge({ value, hideEmpty = true }: EnumBadgeProps): JSX.Element | null {
  if (hideEmpty && !value) return null;
  const { label, tone } = verificationLabel(value);
  return <DsToneBadge tone={tone}>{label}</DsToneBadge>;
}

/** Status do ticket de reembolso (open, in_review, approved, denied, escalated). */
export function DsRefundStatusBadge({ value, hideEmpty = true }: EnumBadgeProps): JSX.Element | null {
  if (hideEmpty && !value) return null;
  const { label, tone } = refundStatusLabel(value);
  return <DsToneBadge tone={tone ?? 'info'}>{label}</DsToneBadge>;
}
