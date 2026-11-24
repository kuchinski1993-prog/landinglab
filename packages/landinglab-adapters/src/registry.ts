// ADR-001 §13 — Registry.
//
// Registry mantém a lista de adapters conhecidos. Imutável após freeze.
// Adapters concretos (Kaching etc.) serão adicionados em sub-fases futuras
// (10.3+). Nesta fase (10.2) o registry é foundation-only: existe pra permitir
// que 10.3 registre KachingAdapter sem tocar em consumidores.

import type { ThemeAdapter } from './theme-adapter.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ThemeAdapter>();
  private frozen = false;

  register(adapter: ThemeAdapter): void {
    if (this.frozen) {
      throw new Error(
        `AdapterRegistry: cannot register '${adapter.id}' after freeze()`,
      );
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`AdapterRegistry: duplicate adapter id '${adapter.id}'`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  freeze(): void {
    this.frozen = true;
  }

  get(id: string): ThemeAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly ThemeAdapter[] {
    return Array.from(this.adapters.values());
  }

  size(): number {
    return this.adapters.size;
  }

  isFrozen(): boolean {
    return this.frozen;
  }
}

/**
 * Cria uma registry vazia. Consumidores registram adapters e chamam freeze()
 * antes de passar pro resolver. Cada consumidor tem sua própria registry
 * (permite testes isolados sem singleton global — ADR-001 §13 nota).
 */
export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}
