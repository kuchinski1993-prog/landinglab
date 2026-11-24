import type { ConnectionStatus } from './shopify-admin.tester.js';

const TIMEOUT_MS = 5_000;

export async function testAnthropicKey(apiKey: string): Promise<ConnectionStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    if (response.ok) return { status: 'ok', message: 'Anthropic API key is valid' };
    if (response.status === 401) return { status: 'error', message: 'Invalid API key — unauthorized' };
    return { status: 'error', message: `Unexpected status: ${response.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('aborted') || msg.includes('abort')) {
      return { status: 'error', message: 'Connection timed out' };
    }
    return { status: 'error', message: msg };
  } finally {
    clearTimeout(timer);
  }
}
