// Fase 10.5 — Shared adapter runtime loader.
//
// Extraído do adapter-shadow.ts pra ser reusado pelo adapter-bundle-authority.ts
// da 10.5 (strangler cut). Ambos precisam:
//   1. Dynamic import do package @blackshop/landinglab-adapters (hotfix 10.4)
//   2. Cache do resultado do load (sucesso ou falha)
//   3. Registry pré-populada com Kaching adapter
//
// Contrato:
//   - Nunca lança pra fora.
//   - Se load falha, retorna null. Callers degradam gracefully.
//   - Import é dinâmico → se package não estiver em node_modules em runtime,
//     worker NÃO crasha (só a funcionalidade dependente do adapter degrada).

import type {
  DetectionResult,
  PageFamily,
  ThemeAdapter,
} from '@blackshop/landinglab-adapters';

export interface AdaptersModule {
  createAdapterRegistry: () => {
    register: (adapter: ThemeAdapter) => void;
    freeze: () => void;
    get: (id: string) => ThemeAdapter | undefined;
    list: () => readonly ThemeAdapter[];
  };
  kachingAdapter: ThemeAdapter;
  resolve: (
    input: {
      html: string;
      hintedFamily?: PageFamily;
      hintedAdapterId?: string;
      landingPageId?: string;
    },
    adapters: readonly ThemeAdapter[],
  ) => DetectionResult;
}

export interface AdapterRuntimeBundle {
  mod: AdaptersModule;
  registry: ReturnType<AdaptersModule['createAdapterRegistry']>;
}

let cachedBundle: AdapterRuntimeBundle | null = null;
let cachedLoadError: string | null = null;

/**
 * Carrega o package @blackshop/landinglab-adapters SOB DEMANDA e cacheia
 * a registry (sucesso ou falha). Callers concorrentes recebem o mesmo
 * resultado sem re-import.
 *
 * Retorna null se package indisponível. Última mensagem de erro fica em
 * `getLastLoadError()` pra logging.
 */
export async function loadAdapterRuntime(): Promise<AdapterRuntimeBundle | null> {
  if (cachedBundle) return cachedBundle;
  if (cachedLoadError) return null;

  try {
    const mod = (await import('@blackshop/landinglab-adapters')) as unknown as AdaptersModule;
    const registry = mod.createAdapterRegistry();
    registry.register(mod.kachingAdapter);
    registry.freeze();
    cachedBundle = { mod, registry };
    return cachedBundle;
  } catch (err) {
    cachedLoadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export function getLastLoadError(): string | null {
  return cachedLoadError;
}

/** Test-only: reset cache pra testar múltiplos cenários (load success/failure). */
export function __resetAdapterRuntimeCache(): void {
  cachedBundle = null;
  cachedLoadError = null;
}
