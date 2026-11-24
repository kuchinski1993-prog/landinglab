// SM-6.3 — Feature flags globais do backoffice.
//
// Padrão: env var por flag. Booleana quando `=== 'true'` (string).
// Default: **desabilitado** (segurança) — só liga quando explicitamente `=true`.
//
// Skeleton Mode (G9 do ADDENDUM v1.1):
//   - Server-side: `SKELETON_MODE_ENABLED=true|false`
//   - Client-side: `NEXT_PUBLIC_SKELETON_MODE_ENABLED=true|false`
//
// **IMPORTANTE — dois env vars para o mesmo flag:**
// Next.js só expõe `NEXT_PUBLIC_*` no bundle client. Como `AppShell.tsx` é
// Client Component (`'use client'`), ele precisa da versão pública. Rotas de
// API e Server Components leem a versão server-only. Deploy tem que setar as
// duas em conjunto — ver `.env.example`.
//
// **GUARDRAIL DE ROLLOUT (@po):** `SKELETON_MODE_ENABLED=true` em **produção**
// somente após SM-3.6 (kill switch reviews IA) e SM-3.7 (kill switch logos)
// estarem `Done` + smoke test em prod dos kill switches. Ver PRD §Risks R1/R2,
// FR-24/FR-25/NFR-2.
//
// **Kill switches são SEMPRE ativos**, independente desta flag —
// `/api/admin/kill-switch/*` continua respondendo mesmo com Skeleton Mode
// desabilitado (mitigação legal permanente).

/**
 * True quando `SKELETON_MODE_ENABLED=true` no ambiente server-side.
 *
 * Use em: rotas API (`/api/skeleton/*`), Server Components (`/skeleton-mode/page.tsx`),
 * middlewares, tasks de background.
 *
 * NÃO usar em Client Components — use `isSkeletonModeEnabledClient()` em vez.
 */
export function isSkeletonModeEnabled(): boolean {
  return process.env.SKELETON_MODE_ENABLED === 'true';
}

/**
 * True quando `NEXT_PUBLIC_SKELETON_MODE_ENABLED=true` no bundle client.
 *
 * Use em: Client Components (AppShell, formulários, componentes UI).
 *
 * O valor é embutido no bundle no build time — mudança requer redeploy.
 */
export function isSkeletonModeEnabledClient(): boolean {
  return process.env.NEXT_PUBLIC_SKELETON_MODE_ENABLED === 'true';
}

/**
 * Response padrão 503 para rotas Skeleton Mode quando a flag está off.
 *
 * Formato definido em SM-6.3 AC5: `{ error: 'feature_disabled' }` com HTTP 503.
 * 503 (não 404) sinaliza indisponibilidade temporária — cliente pode retentar
 * após deploy que ligar a flag.
 */
export const SKELETON_MODE_DISABLED_RESPONSE = {
  status: 503 as const,
  body: { error: 'feature_disabled' as const },
};
