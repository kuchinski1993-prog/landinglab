// Story 0.4 · AC1/AC6/AC9 — tabela do resolver de modo das integrações.
import { describe, expect, it } from 'vitest';

import {
  IntegrationModeError,
  buildModeAlertLines,
  describeIntegrationModes,
  isProductionLike,
  resolveIntegrationMode,
  type RuntimeEnv,
} from '../runtime-mode.js';

const NODE_ENVS: Array<string | undefined> = ['production', 'development', 'test', undefined];
const VALUES: Array<string | undefined> = ['real', 'mock', undefined, '', 'Real', 'live'];
const PLATFORM: Array<RuntimeEnv> = [{}, { RAILWAY_ENVIRONMENT_NAME: 'production' }, { VERCEL_ENV: 'production' }];

function env(base: RuntimeEnv): RuntimeEnv {
  const out: RuntimeEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

describe('isProductionLike', () => {
  it('NODE_ENV=production', () => expect(isProductionLike({ NODE_ENV: 'production' })).toBe(true));
  it('Railway production sem NODE_ENV', () =>
    expect(isProductionLike({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true));
  it('Vercel production sem NODE_ENV', () => expect(isProductionLike({ VERCEL_ENV: 'production' })).toBe(true));
  it('Railway staging/preview não é produção', () => {
    expect(isProductionLike({ RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(false);
    expect(isProductionLike({ VERCEL_ENV: 'preview' })).toBe(false);
  });
  it('nada definido → não é produção', () => expect(isProductionLike({})).toBe(false));
});

describe('resolveIntegrationMode — tabela NODE_ENV × valor × plataforma (shopify)', () => {
  for (const nodeEnv of NODE_ENVS) {
    for (const value of VALUES) {
      for (const platform of PLATFORM) {
        const e = env({ NODE_ENV: nodeEnv, SHOPIFY_MODE: value, ...platform });
        const prod = nodeEnv === 'production' || Object.keys(platform).length > 0;
        const label = `NODE_ENV=${String(nodeEnv)} SHOPIFY_MODE=${JSON.stringify(value)} plataforma=${JSON.stringify(platform)}`;
        it(label, () => {
          if (value === 'real' || value === 'mock') {
            const r = resolveIntegrationMode('shopify', e);
            expect(r).toMatchObject({ mode: value, source: 'explicit', productionLike: prod, variable: 'SHOPIFY_MODE' });
            return;
          }
          if (value === 'Real' || value === 'live') {
            expect(() => resolveIntegrationMode('shopify', e)).toThrow(IntegrationModeError);
            try {
              resolveIntegrationMode('shopify', e);
            } catch (err) {
              expect((err as IntegrationModeError).code).toBe('INTEGRATION_MODE_INVALID');
            }
            return;
          }
          // ausente ou vazio
          if (prod) {
            try {
              resolveIntegrationMode('shopify', e);
              throw new Error('deveria ter lançado');
            } catch (err) {
              expect(err).toBeInstanceOf(IntegrationModeError);
              expect((err as IntegrationModeError).code).toBe('INTEGRATION_MODE_UNSET');
            }
          } else {
            expect(resolveIntegrationMode('shopify', e)).toMatchObject({ mode: 'mock', source: 'dev-default' });
          }
        });
      }
    }
  }

  it('nunca resolve mock implícito em produção (varredura)', () => {
    for (const value of VALUES) {
      for (const platform of PLATFORM) {
        const e = env({ NODE_ENV: 'production', SHOPIFY_MODE: value, ...platform });
        let resolved: string | null = null;
        let source: string | null = null;
        try {
          const r = resolveIntegrationMode('shopify', e);
          resolved = r.mode;
          source = r.source;
        } catch {
          resolved = null;
        }
        if (resolved === 'mock') expect(source).toBe('explicit');
      }
    }
  });

  it('mensagem em português diz qual variável definir e quais valores aceita', () => {
    try {
      resolveIntegrationMode('shopify', { NODE_ENV: 'production' });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('SHOPIFY_MODE');
      expect(msg).toContain('"real" ou "mock"');
      expect(msg).toMatch(/não está definida/);
    }
  });
});

describe('resolveIntegrationMode — metaCapi (AC6)', () => {
  it('META_CAPI_MODE=real com SHOPIFY_MODE=mock → real', () => {
    expect(
      resolveIntegrationMode('metaCapi', { NODE_ENV: 'production', META_CAPI_MODE: 'real', SHOPIFY_MODE: 'mock' }),
    ).toMatchObject({ mode: 'real', source: 'explicit' });
  });
  it('META_CAPI_MODE=mock com SHOPIFY_MODE=real → mock', () => {
    expect(
      resolveIntegrationMode('metaCapi', { NODE_ENV: 'production', META_CAPI_MODE: 'mock', SHOPIFY_MODE: 'real' }),
    ).toMatchObject({ mode: 'mock', source: 'explicit' });
  });
  it('ambos ausentes em produção → INTEGRATION_MODE_UNSET', () => {
    expect(() => resolveIntegrationMode('metaCapi', { NODE_ENV: 'production' })).toThrow(
      expect.objectContaining({ code: 'INTEGRATION_MODE_UNSET', variable: 'META_CAPI_MODE' }),
    );
  });
  it('compatibilidade: META_CAPI_MODE ausente + SHOPIFY_MODE=real → real (legacy-fallback)', () => {
    expect(resolveIntegrationMode('metaCapi', { NODE_ENV: 'production', SHOPIFY_MODE: 'real' })).toMatchObject({
      mode: 'real',
      source: 'legacy-fallback',
    });
  });
  it('META_CAPI_MODE ausente + SHOPIFY_MODE=mock em produção → UNSET (sem mock implícito)', () => {
    expect(() => resolveIntegrationMode('metaCapi', { NODE_ENV: 'production', SHOPIFY_MODE: 'mock' })).toThrow(
      expect.objectContaining({ code: 'INTEGRATION_MODE_UNSET' }),
    );
  });
  it('META_CAPI_MODE inválido → INVALID mesmo com SHOPIFY_MODE=real', () => {
    expect(() =>
      resolveIntegrationMode('metaCapi', { NODE_ENV: 'production', META_CAPI_MODE: 'on', SHOPIFY_MODE: 'real' }),
    ).toThrow(expect.objectContaining({ code: 'INTEGRATION_MODE_INVALID' }));
  });
  it('dev sem nada → mock dev-default', () => {
    expect(resolveIntegrationMode('metaCapi', { NODE_ENV: 'development' })).toMatchObject({
      mode: 'mock',
      source: 'dev-default',
    });
  });
});

describe('describeIntegrationModes / buildModeAlertLines (AC8/AC9)', () => {
  it('produção com tudo real → sem productionMock nem erro', () => {
    const s = describeIntegrationModes({ NODE_ENV: 'production', SHOPIFY_MODE: 'real', META_CAPI_MODE: 'real' });
    expect(s).toMatchObject({ productionMock: false, productionModeError: false });
  });
  it('produção com mock declarado → productionMock', () => {
    const s = describeIntegrationModes({ NODE_ENV: 'production', SHOPIFY_MODE: 'mock', META_CAPI_MODE: 'mock' });
    expect(s.productionMock).toBe(true);
    expect(s.shopify).toEqual({ mode: 'mock', source: 'explicit' });
  });
  it('produção sem variáveis → productionModeError, status com code', () => {
    const s = describeIntegrationModes({ NODE_ENV: 'production' });
    expect(s.productionModeError).toBe(true);
    expect(s.shopify).toMatchObject({ mode: 'error', code: 'INTEGRATION_MODE_UNSET', variable: 'SHOPIFY_MODE' });
  });
  it('dev sem variáveis → nada de produção', () => {
    const s = describeIntegrationModes({});
    expect(s).toMatchObject({ productionMock: false, productionModeError: false, productionLike: false });
  });

  it('boot em produção com mock/erro → uma linha error MOCK_MODE_IN_PRODUCTION por subsistema', () => {
    const lines = buildModeAlertLines('api', { NODE_ENV: 'production', SHOPIFY_MODE: 'mock' });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.level === 'error' && l.event === 'MOCK_MODE_IN_PRODUCTION')).toBe(true);
    expect(lines.map((l) => l.subsystem)).toEqual(['shopify', 'metaCapi']);
  });
  it('boot em dev → nível info', () => {
    const lines = buildModeAlertLines('worker', {});
    expect(lines.every((l) => l.level === 'info')).toBe(true);
  });
  it('legacy-fallback → warn META_CAPI_MODE_LEGACY_FALLBACK', () => {
    const lines = buildModeAlertLines('api', { NODE_ENV: 'production', SHOPIFY_MODE: 'real' });
    expect(lines.find((l) => l.subsystem === 'metaCapi')).toMatchObject({
      level: 'warn',
      event: 'META_CAPI_MODE_LEGACY_FALLBACK',
    });
    expect(lines.find((l) => l.subsystem === 'shopify')).toMatchObject({ level: 'info' });
  });
});
