// Testa a API key do Resend chamando o endpoint de listagem de domínios
// (GET /domains) com Bearer <apiKey>. 200 = ok, 401 = key inválida.
import type { ConnectionStatus } from './shopify-admin.tester.js';

const TIMEOUT_MS = 5_000;

export async function testResendKey(apiKey: string): Promise<ConnectionStatus> {
  if (!apiKey) {
    return { status: 'error', message: 'API key não configurada' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (response.ok) return { status: 'ok', message: 'Resend API key válida' };
    if (response.status === 401 || response.status === 403) {
      return { status: 'error', message: 'API key inválida — Resend recusou' };
    }
    return { status: 'error', message: `Resposta inesperada: HTTP ${response.status}` };
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
