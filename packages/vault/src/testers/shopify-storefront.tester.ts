import type { ConnectionStatus } from './shopify-admin.tester.js';

const TIMEOUT_MS = 5_000;
const API_VERSION = '2024-01';

// Minimal query — only checks that the token is accepted by the Storefront API.
const PROBE_QUERY = JSON.stringify({ query: '{ shop { name } }' });

export async function testShopifyStorefrontToken(
  token: string,
  domain: string,
): Promise<ConnectionStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const url = `https://${domain}/api/${API_VERSION}/graphql.json`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
      body: PROBE_QUERY,
      signal: controller.signal,
    });

    if (response.ok) {
      const body = (await response.json()) as { errors?: unknown };
      if (body.errors) {
        return { status: 'error', message: 'Token aceito, mas a API retornou erros inesperados' };
      }
      return { status: 'ok', message: 'Storefront API token válido' };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'error', message: 'Token inválido ou sem permissão — verifique o Storefront access token' };
    }

    if (response.status === 404) {
      return { status: 'error', message: 'Domínio não encontrado — verifique shopify.store_domain' };
    }

    return { status: 'error', message: `Resposta inesperada da Shopify: HTTP ${response.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    if (msg.includes('aborted') || msg.includes('abort')) {
      return { status: 'error', message: 'Tempo limite de conexão excedido' };
    }
    if (msg.includes('fetch') || msg.includes('ENOTFOUND') || msg.includes('network')) {
      return { status: 'error', message: 'Não foi possível conectar — verifique o domínio da loja' };
    }
    return { status: 'error', message: msg };
  } finally {
    clearTimeout(timer);
  }
}
