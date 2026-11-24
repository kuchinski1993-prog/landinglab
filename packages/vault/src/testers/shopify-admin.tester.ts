// Status honesto de uma credencial:
//   - ok:         teste real passou (rede/API confirmou)
//   - error:      teste real falhou (rede/API rejeitou)
//   - configured: valor presente, mas sem teste de rede possível/aplicável
//   - warning:    valor presente, mas semanticamente suspeito (ex.: webhook
//                 secret difere do client secret)
export interface ConnectionStatus {
  status: 'ok' | 'error' | 'configured' | 'warning';
  message: string;
}

const TIMEOUT_MS = 5_000;

export async function testShopifyAdminToken(
  token: string,
  domain: string,
): Promise<ConnectionStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Usa versão estável mais recente pra validar. Se a API retornar 401, o
    // tester confirma que o token é inválido independente da versão.
    const url = `https://${domain}/admin/api/2026-07/shop.json`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
      signal: controller.signal,
    });

    const actualVersion = response.headers.get('X-Shopify-API-Version') ?? 'unknown';
    if (response.ok) return { status: 'ok', message: `Shopify Admin token válido (API ${actualVersion})` };
    if (response.status === 401) return { status: 'error', message: `Token inválido — não autorizado (API ${actualVersion})` };
    return { status: 'error', message: `Resposta inesperada: HTTP ${response.status} (API ${actualVersion})` };
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
