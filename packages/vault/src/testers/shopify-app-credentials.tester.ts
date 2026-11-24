// Testa a tríade { client_id, client_secret, store_domain } tentando um
// Client Credentials Grant contra o endpoint OAuth da loja. Se a Shopify
// devolver um access_token → status: 'ok'. Se recusar → status: 'error'
// com a mensagem (recortada) da Shopify. Nunca loga nem devolve o token
// gerado — apenas o resultado.
import type { ConnectionStatus } from './shopify-admin.tester.js';

const TIMEOUT_MS = 5_000;

export interface ShopifyAppCredentialsInput {
  clientId: string;
  clientSecret: string;
  storeDomain: string;
}

export async function testShopifyAppCredentials(
  input: ShopifyAppCredentialsInput,
): Promise<ConnectionStatus> {
  const { clientId, clientSecret, storeDomain } = input;
  if (!clientId || !clientSecret || !storeDomain) {
    return {
      status: 'error',
      message:
        'Necessário configurar client_id, client_secret e store_domain para testar a conexão Shopify Admin',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `https://${storeDomain}/admin/oauth/access_token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as { access_token?: string };
      if (data.access_token) {
        return {
          status: 'ok',
          message: 'Credenciais do app Shopify válidas — Admin token gerado com sucesso',
        };
      }
      return {
        status: 'error',
        message: 'Shopify aceitou a chamada mas não retornou access_token',
      };
    }

    if (response.status === 401 || response.status === 400) {
      return {
        status: 'error',
        message: 'client_id/client_secret inválidos — Shopify recusou',
      };
    }
    if (response.status === 404) {
      return {
        status: 'error',
        message: 'store_domain não encontrado — verifique o domínio da loja',
      };
    }
    const body = await response.text();
    return {
      status: 'error',
      message: `Resposta inesperada da Shopify (HTTP ${response.status}): ${body.slice(0, 200)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    if (msg.includes('aborted') || msg.includes('abort')) {
      return { status: 'error', message: 'Tempo limite de conexão excedido' };
    }
    return { status: 'error', message: msg };
  } finally {
    clearTimeout(timer);
  }
}
