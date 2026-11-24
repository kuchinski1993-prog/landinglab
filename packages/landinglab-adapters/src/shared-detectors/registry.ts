// ADR-002 §11.2 §9 — SharedDetectorRegistry.
//
// Deterministic registration. Sem singleton global escondido.
// Consumidor cria instância explícita, registra, freeze.

import type { SharedRegionDetector } from './types.js';

export class SharedDetectorRegistry {
  private readonly detectors = new Map<string, SharedRegionDetector>();
  private frozen = false;

  register(detector: SharedRegionDetector): void {
    if (this.frozen) {
      throw new Error(
        `SharedDetectorRegistry: cannot register '${detector.id}' after freeze()`,
      );
    }
    if (this.detectors.has(detector.id)) {
      throw new Error(
        `SharedDetectorRegistry: duplicate detector id '${detector.id}'`,
      );
    }
    this.detectors.set(detector.id, detector);
  }

  freeze(): void {
    this.frozen = true;
  }

  get(id: string): SharedRegionDetector | undefined {
    return this.detectors.get(id);
  }

  /**
   * Lista determinística: sort asc por detector.id.
   * Ordem de registro NÃO afeta output.
   */
  list(): readonly SharedRegionDetector[] {
    return Array.from(this.detectors.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  size(): number {
    return this.detectors.size;
  }

  isFrozen(): boolean {
    return this.frozen;
  }
}

export function createSharedDetectorRegistry(): SharedDetectorRegistry {
  return new SharedDetectorRegistry();
}
