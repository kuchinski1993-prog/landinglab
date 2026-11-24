// Story 22.1a-1 · D7 (A1) — helpers para respostas públicas que não revelam se a conta existe.
//
// - Corpos únicos e congelados: toda falha de login é o MESMO 401; cadastro e "esqueci" são
//   SEMPRE o mesmo 202; link inválido é o MESMO 400 (qualquer motivo).
// - Piso de tempo (≈ 300 ms): a resposta só sai depois de `floorMs` desde o início, nos dois
//   ramos — inclusive quando o trabalho lança erro (o erro sai depois do piso).
// As rotas (22.1a-2) usam estes helpers; aqui não há rota.

export const PUBLIC_RESPONSE_FLOOR_MS = 300;

export interface PublicResponse<B> {
  readonly statusCode: number;
  readonly body: Readonly<B>;
}

export const INVALID_CREDENTIALS: PublicResponse<{ code: 'invalid_credentials' }> = Object.freeze({
  statusCode: 401,
  body: Object.freeze({ code: 'invalid_credentials' as const }),
});

export const REQUEST_RECEIVED: PublicResponse<{ status: 'received' }> = Object.freeze({
  statusCode: 202,
  body: Object.freeze({ status: 'received' as const }),
});

export const INVALID_OR_EXPIRED_LINK: PublicResponse<{ code: 'invalid_or_expired_link' }> = Object.freeze({
  statusCode: 400,
  body: Object.freeze({ code: 'invalid_or_expired_link' as const }),
});

export interface FloorClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: FloorClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Roda `work` e só devolve (ou lança) depois de `floorMs` desde o início. */
export async function withTimeFloor<T>(work: () => Promise<T>, floorMs = PUBLIC_RESPONSE_FLOOR_MS, clock: FloorClock = realClock): Promise<T> {
  const started = clock.now();
  const wait = async (): Promise<void> => {
    const remaining = Math.max(0, floorMs - (clock.now() - started));
    if (remaining > 0) await clock.sleep(remaining);
  };
  try {
    const result = await work();
    await wait();
    return result;
  } catch (err) {
    await wait();
    throw err;
  }
}
