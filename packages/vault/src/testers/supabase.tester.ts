// Supabase testers:
//   - URL: verifica formato + DNS lookup.
//   - Service Role Key: chama GET {url}/rest/v1/ com header apikey — se 200,
//     a key é aceita pelo PostgREST daquela URL.
import { lookup } from 'node:dns/promises';

import type { ConnectionStatus } from './shopify-admin.tester.js';

const TIMEOUT_MS = 5_000;

function extractHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export async function testSupabaseUrl(url: string): Promise<ConnectionStatus> {
  if (!url) return { status: 'error', message: 'URL não configurada' };
  const host = extractHost(url);
  if (!host) {
    return { status: 'error', message: 'URL inválida — use o formato https://<ref>.supabase.co' };
  }
  try {
    await lookup(host);
    return { status: 'ok', message: `URL Supabase resolvida (${host})` };
  } catch {
    return { status: 'error', message: `Não foi possível resolver o host: ${host}` };
  }
}

export async function testSupabaseServiceKey(
  serviceKey: string,
  url: string | null,
): Promise<ConnectionStatus> {
  if (!serviceKey) {
    return { status: 'error', message: 'Service role key não configurada' };
  }
  if (!url) {
    return {
      status: 'configured',
      message: 'Service role key presente. Sem URL do projeto configurada — configure supabase.url para testar.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const probeUrl = `${url.replace(/\/$/, '')}/rest/v1/`;
    const response = await fetch(probeUrl, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      signal: controller.signal,
    });

    if (response.ok || response.status === 404) {
      // 200 = PostgREST aceita a key; 404 = key aceita mas rota vazia (também válido).
      return { status: 'ok', message: 'Service role key aceita pelo Supabase' };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'error', message: 'Service role key rejeitada — verifique o valor' };
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
