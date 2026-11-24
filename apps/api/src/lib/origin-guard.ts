// Story 19.3a — guarda de origem para mutações (C14), genérica.
//
// Mesma regra de `vslOriginAllowed` (modules/vsl/lib/vsl-http.ts): origem permitida =
// CORS_ORIGIN; localhost só fora de produção; sem Origin (chamada servidor →
// servidor, script, inject) passa — a sessão continua obrigatória.
// `vsl-http.ts` não é editado aqui (a 18.1 também mexe nele); delegar o VSL a
// esta função é follow-up após a 18.1.
import type { FastifyInstance } from 'fastify';

import '../types.js';

const LOCALHOST_ORIGIN = /^https?:\/\/localhost:\d+$/;

export function originAllowed(
  config: Pick<FastifyInstance['config'], 'corsOrigin' | 'nodeEnv'>,
  origin: string | undefined,
): boolean {
  if (!origin) return true;
  if (config.corsOrigin.split(',').map((value) => value.trim()).includes(origin)) return true;
  return config.nodeEnv !== 'production' && LOCALHOST_ORIGIN.test(origin);
}
