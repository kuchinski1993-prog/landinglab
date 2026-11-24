// Rex (@landinglab-research-lead) — glue module.
//
// A lógica do orchestrator vive em src/orchestrator.ts (chamada externa). Este
// arquivo re-exporta helpers e types compartilhados dos workers pra facilitar
// consumers (testes, CLI de debug, worker processor).

export type { WorkerOutput, TraceEntry } from './types.js';
export { runSpecHunter, type SpecHunterInput, type ProductExtraction } from './spec-hunter.js';
export { runReviewMiner, type ReviewMinerInput } from './review-miner.js';
export { runMarketAnalyst, type MarketAnalystInput, type MarketIntel } from './market-analyst.js';
export { runLensScout, type LensScoutInput, type LensScoutData } from './lens-scout.js';
export { runVisionVerifier, type VisionVerifierInput, type VisionVerifierData } from './vision-verifier.js';
export {
  runPirSynthesizer,
  type PirSynthesizerInput,
  type PirSynthesizerData,
  type PirSynthesizerResult,
} from './pir-synthesizer.js';
