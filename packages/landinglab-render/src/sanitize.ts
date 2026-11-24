/**
 * Sanitiza HTML de landing pages L0i.
 *
 * Contrato final (Story 13.6):
 *   - Roda `isomorphic-dompurify` server-side.
 *   - Aplica scoping de CSS: envolve `customCss` com `.landing-scope { ... }`.
 *   - Retorna `{ sanitized, diff }` — diff logado no backoffice pra auditoria.
 *
 * Stub v1 (Story 13.1): retorna input inalterado. NÃO usar em produção
 * antes da implementação real em 13.6.
 */
export function sanitizeHtml(htmlBody: string): string {
  return htmlBody;
}
