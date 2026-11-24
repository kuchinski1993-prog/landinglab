// Configuração do worker LandingLab. Centraliza o acesso às envs para testes e runtime.

export interface WorkerConfig {
  redisUrl: string;
  databaseUrl: string;
  logLevel: string;
  nodeEnv: 'development' | 'test' | 'production';
}

export const HEARTBEAT_KEY = 'worker:heartbeat';
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TTL_SECONDS = 30;
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export const QUEUE_CONCURRENCY = {
  // Clone (Playwright ~500 MB de RAM, 30-90 s por job): 1 por vez.
  'landinglab.squad0.clone': 1,
  // Troca o bloco de ofertas da origem pelo bundle LandingLab sem re-clonar.
  'landinglab.apply-bundle': 1,
  // OCR + Vision das imagens, em segundo plano depois do clone.
  'landinglab.image-metadata': 1,
  // Gerar do zero: pesquisa → copy → visual → build → deploy.
  'landinglab.squad1.research': 1,
  'landinglab.squad2.copy': 1,
  'landinglab.squad3.design': 1,
  'landinglab.squad4.build': 1,
  'landinglab.squad5.deploy': 1,
  // Tradução de texto (Anthropic Haiku) e de texto dentro das imagens (OCR + Gemini + Seedream).
  'landinglab.translate-text': 1,
  'landinglab.translate-images': 1,
  // Export da landing (zip HTML + zip de tema Shopify).
  'landinglab.export': 1,
} as const;

export type QueueName = keyof typeof QUEUE_CONCURRENCY;

export const QUEUE_NAMES: readonly QueueName[] = Object.keys(QUEUE_CONCURRENCY) as QueueName[];

// Lock por fila (ms). Padrão do BullMQ = 30 s.
export const QUEUE_LOCK_DURATION: Partial<Record<QueueName, number>> = {
  // apply-bundle processa ~1 MB de HTML com cheerio.
  'landinglab.apply-bundle': 120_000,
  // Export: centenas de downloads + zip + upload.
  'landinglab.export': 600_000,
};

// Rate limit por fila (protege a cota/fatura das APIs pagas se vários jobs forem disparados juntos).
export const QUEUE_LIMITER: Partial<Record<QueueName, { max: number; duration: number }>> = {
  'landinglab.squad1.research': { max: 1, duration: 30_000 },
  'landinglab.squad2.copy': { max: 1, duration: 60_000 },
  'landinglab.squad3.design': { max: 1, duration: 30_000 },
  'landinglab.squad4.build': { max: 1, duration: 60_000 },
  'landinglab.squad5.deploy': { max: 1, duration: 60_000 },
};

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export function jobOptionsFor(_queue: string): typeof DEFAULT_JOB_OPTIONS {
  return DEFAULT_JOB_OPTIONS;
}

export function loadConfig(): WorkerConfig {
  const nodeEnv = (process.env['NODE_ENV'] ?? 'development') as WorkerConfig['nodeEnv'];

  return {
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://landinglab:changeme@localhost:5432/landinglab',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv,
  };
}
