// Shared types para os 7 agent modules do Squad 1.
//
// Cada agent worker retorna um TraceEntry (agregado em landing_generation_runs.agent_trace)
// além do payload específico. O orchestrator (Rex) coleta esses traces + payloads
// e passa pra Sage (synthesizer) montar o PIR.

export interface TraceEntry {
  agent: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  status: 'ok' | 'partial' | 'failed';
  error?: string;
}

/** Output genérico de qualquer worker: payload + trace. */
export interface WorkerOutput<T> {
  data: T | null;
  trace: TraceEntry;
}
