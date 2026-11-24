// Health check contract (referenced from Dev Notes H2 — to be implemented in Story 1.3).
// The worker has no HTTP port; this contract is consumed by both api and worker as a
// shared shape for liveness/readiness reporting.

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheck {
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
  service: 'api' | 'worker' | 'backoffice';
  version?: string;
  dependencies?: HealthDependency[];
}

export interface HealthDependency {
  name: string;
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
}
