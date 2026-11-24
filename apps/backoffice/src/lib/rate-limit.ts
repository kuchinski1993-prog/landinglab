// In-memory sliding token bucket rate limiter for public LandingLab endpoints.
//
// Design notes:
//   - MVP: single-instance Map<key, bucket>. Não vale a complexidade do Upstash
//     agora que rodamos 1 processo Next. Migrar quando escalar horizontalmente.
//   - Reset por janela fixa (não sliding window). Simples, previsível, aceitável
//     pra abuso-baseline. Um sliding window preciso exigiria Redis ordered sets.
//   - Restart do servidor ZERA os buckets — comportamento documentado. Em
//     produção com PM2/Docker o restart é raro; convivemos com isso.
//   - Cleanup a cada 60s remove buckets expirados pra não vazar memória em
//     tráfego com muitas keys distintas (IP-based).

type Key = string;
interface Bucket {
  count: number;
  /** epoch ms em que o contador é resetado */
  resetAt: number;
}

const store = new Map<Key, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  /** Requisições restantes na janela atual (0 quando `ok` é false) */
  remaining: number;
  /** Epoch ms em que a janela é resetada (útil pra header Retry-After) */
  resetAt: number;
}

/**
 * Verifica e incrementa o contador da `key` dentro de uma janela `windowMs`.
 * Retorna `{ ok: false }` quando o limite `max` é excedido.
 *
 * @param key       identificador único da bucket (ex: `clone:userId=42`)
 * @param max       requisições permitidas na janela
 * @param windowMs  duração da janela em ms
 */
export async function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const bucket = store.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs };
    store.set(key, fresh);
    return { ok: true, remaining: max - 1, resetAt: fresh.resetAt };
  }

  if (bucket.count >= max) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { ok: true, remaining: max - bucket.count, resetAt: bucket.resetAt };
}

/**
 * Extrai identidade estável do request pra usar como sufixo da key.
 * Prioridade: cookie de sessão > x-forwarded-for > remoteAddress fallback.
 *
 * NOTA: `blackshop.sid` é opaco (session id), não user id. Usamos ele como
 * proxy — dois usuários logados terão sids diferentes; usuários anônimos
 * caem no IP.
 */
export function getClientIdentity(req: Request): string {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const sidMatch = /(?:^|;\s*)blackshop\.sid=([^;]+)/.exec(cookieHeader);
  if (sidMatch?.[1]) {
    return `sid:${sidMatch[1]}`;
  }

  // x-forwarded-for pode ser lista "client, proxy1, proxy2" — pega o primeiro.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return `ip:${realIp.trim()}`;

  return 'ip:unknown';
}

/**
 * Helper — monta resposta JSON 429 no formato padronizado dos endpoints.
 * Retorna o objeto pronto pra `return` no handler.
 */
export function buildRateLimitResponse(resetAt: number): Response {
  const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return new Response(
    JSON.stringify({
      ok: false,
      message: 'Muitas requisições. Tente novamente em breve.',
      retryAfter: resetAt,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSec),
      },
    },
  );
}

// Cleanup periódico — remove buckets expirados. Roda uma única vez por processo
// (module singleton). `unref()` pra não segurar o event loop no shutdown do Next.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.__rateLimitCleanupStarted) {
  g.__rateLimitCleanupStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of store) {
      if (b.resetAt <= now) store.delete(k);
    }
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
}
