// Story 20.13a (PR B) — textos do indicador de salvamento automático (SM-4.7), movidos sem mudança de
// `components/SaveIndicator.tsx` (Polaris React, apagado) para o `DsSaveIndicator` continuar usando as
// mesmas regras.

/**
 * Formata "Salvo há Xs" / "Salvo há Xm" / "Salvo há Xh".
 *
 * Regra UX §13.2:
 * - 0-59s → "Salvo há Xs"
 * - >=60s → "Salvo há Xm" (transição de tone success → subdued)
 * - >=3600s → "Salvo há Xh"
 */
export function formatRelativeSaved(lastSavedAt: number, now: number): string {
  const diffMs = Math.max(0, now - lastSavedAt);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `Salvo há ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Salvo há ${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  return `Salvo há ${diffHour}h`;
}

/** True se `lastSavedAt` está a mais de 60s de `now` (muda tone p/ subdued). */
export function isLongSaved(lastSavedAt: number, now: number): boolean {
  return now - lastSavedAt >= 60_000;
}
