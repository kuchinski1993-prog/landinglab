// Shopify assina os webhooks com o *client secret* do app. Portanto o
// `shopify:webhook:secret` correto é o mesmo valor de `shopify.client_secret`.
// Sem endpoint remoto que valide isso isoladamente, o melhor teste é
// comparar os dois valores em tempo constante:
//   - iguais       → 'ok'      (HMAC dos webhooks vai bater)
//   - diferentes   → 'warning' (webhooks vão falhar no HMAC)
//   - sem cs       → 'configured' (secret está no vault mas não dá pra comparar)
import { timingSafeEqual } from 'node:crypto';

import type { ConnectionStatus } from './shopify-admin.tester.js';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function testShopifyWebhookSecret(
  webhookSecret: string,
  clientSecret: string | null,
): ConnectionStatus {
  if (!webhookSecret) {
    return { status: 'error', message: 'Webhook secret não configurado' };
  }
  if (!clientSecret) {
    return {
      status: 'configured',
      message:
        'Webhook secret configurado. Sem client_secret para comparar — configure o Client Secret também para validar.',
    };
  }
  if (safeEqual(webhookSecret, clientSecret)) {
    return {
      status: 'ok',
      message: 'Webhook secret bate com o Client Secret — HMAC vai validar',
    };
  }
  return {
    status: 'warning',
    message:
      'Webhook secret DIFERE do Client Secret. Shopify assina webhooks com o client secret — webhooks vão falhar no HMAC. Cole o mesmo valor.',
  };
}
