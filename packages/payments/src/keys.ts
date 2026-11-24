// Validação de formato das chaves Stripe (Story 15.1, AC3).

export type StripeMode = 'test' | 'live';

export class StripeKeyError extends Error {
  constructor(
    public readonly field: 'publishableKey' | 'secretKey' | 'webhookSecret',
    message: string,
  ) {
    super(message);
    this.name = 'StripeKeyError';
  }
}

const PUBLISHABLE_RE = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;
// sk_ = chave secreta padrão; rk_ = chave restrita (recomendada).
const SECRET_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_RE = /^whsec_[A-Za-z0-9+/=]{10,}$/;

export function publishableKeyMode(key: string): StripeMode {
  const match = PUBLISHABLE_RE.exec(key.trim());
  if (!match) {
    throw new StripeKeyError(
      'publishableKey',
      'Publishable key inválida — deve começar com pk_test_ ou pk_live_.',
    );
  }
  return match[1] as StripeMode;
}

export function secretKeyMode(key: string): StripeMode {
  const match = SECRET_RE.exec(key.trim());
  if (!match) {
    throw new StripeKeyError(
      'secretKey',
      'Secret key inválida — deve começar com sk_test_, sk_live_, rk_test_ ou rk_live_.',
    );
  }
  return match[2] as StripeMode;
}

export function assertWebhookSecret(secret: string): void {
  if (!WEBHOOK_RE.test(secret.trim())) {
    throw new StripeKeyError('webhookSecret', 'Webhook secret inválido — deve começar com whsec_.');
  }
}

/** Garante pk e secret no mesmo modo; devolve o modo da conta. */
export function resolveAccountMode(publishableKey: string, secretKey: string): StripeMode {
  const pkMode = publishableKeyMode(publishableKey);
  const skMode = secretKeyMode(secretKey);
  if (pkMode !== skMode) {
    throw new StripeKeyError(
      'secretKey',
      `Chaves de modos diferentes: publishable é ${pkMode} e secret é ${skMode}.`,
    );
  }
  return pkMode;
}

export function keyTail(key: string, size = 4): string {
  return key.slice(-size);
}
