import { describe, expect, it } from 'vitest';

import { getDomainForHost, swapActiveDomain } from './index.js';

// ─────────────────────────────────────────────────────────────────────────
// QA note (Task #45):
//
// A task original solicitou cobertura de:
//   - Slug uniqueness
//   - Root vs subpath conflict
//   - M:N binding queries
//   - Slug generator (kebab-case, ASCII, sem colisão)
//
// NADA disso existe em landinglab-domains. A superfície pública real é:
//   - `SpaceshipAdapter` (interface pura, sem impl)
//   - `VercelDomainsAdapter` (fetch client — testado em vercel.test.ts)
//   - `getDomainForHost` (STUB — throw 'Not implemented — Story 13.4')
//   - `swapActiveDomain` (STUB — throw 'Not implemented — Story 13.4')
//
// Não há drizzle-orm nem query builder neste pacote. Nada bate no Postgres.
// A lógica de slug/binding/routing pertence a outra camada (provavelmente
// apps/storefront-l0i middleware ou packages/landinglab-build) — Story 13.4
// ainda não implementou nada.
//
// Os testes abaixo são CANARY: quando 13.4 implementar, eles vão quebrar
// intencionalmente e forçar atualização das expectativas.
// ─────────────────────────────────────────────────────────────────────────

describe('landinglab-domains — public API surface (Story 13.1 stubs)', () => {
  describe('getDomainForHost — stub canary', () => {
    it('throws "Not implemented" until Story 13.4 lands', async () => {
      await expect(getDomainForHost('example.com')).rejects.toThrow(
        /Not implemented — Story 13\.4/,
      );
    });

    it('throws for empty host too (stub is unconditional)', async () => {
      await expect(getDomainForHost('')).rejects.toThrow(/Not implemented/);
    });
  });

  describe('swapActiveDomain — stub canary', () => {
    it('throws "Not implemented" until Story 13.4 lands', async () => {
      await expect(swapActiveDomain('lp_abc123')).rejects.toThrow(
        /Not implemented — Story 13\.4/,
      );
    });
  });
});
