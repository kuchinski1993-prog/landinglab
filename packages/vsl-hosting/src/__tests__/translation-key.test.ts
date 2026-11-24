import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicCopyTranslator, anthropicKeyWithEnvFallback, translatorFromKey } from '../page-translations.js';

describe('chave da Anthropic para a tradução VSL (cofre → env)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('usa a chave do cofre quando existe', async () => {
    const key = anthropicKeyWithEnvFallback(async () => 'sk-vault', { ANTHROPIC_API_KEY: 'sk-env' });
    await expect(key()).resolves.toBe('sk-vault');
  });

  it('sem chave no cofre, usa ANTHROPIC_API_KEY', async () => {
    await expect(anthropicKeyWithEnvFallback(async () => null, { ANTHROPIC_API_KEY: 'sk-env' })()).resolves.toBe('sk-env');
    await expect(anthropicKeyWithEnvFallback(async () => '  ', { ANTHROPIC_API_KEY: ' sk-env ' })()).resolves.toBe('sk-env');
  });

  it('sem cofre e sem env → null', async () => {
    await expect(anthropicKeyWithEnvFallback(async () => null, {})()).resolves.toBeNull();
    await expect(anthropicKeyWithEnvFallback(async () => null, { ANTHROPIC_API_KEY: '' })()).resolves.toBeNull();
  });

  it('cofre com erro: cai na env; sem env, propaga o erro', async () => {
    const failing = async (): Promise<string | null> => { throw new Error('vault down'); };
    await expect(anthropicKeyWithEnvFallback(failing, { ANTHROPIC_API_KEY: 'sk-env' })()).resolves.toBe('sk-env');
    await expect(anthropicKeyWithEnvFallback(failing, {})()).rejects.toThrow('vault down');
  });

  it('o provider Claude chama a API com a chave da env quando o cofre está vazio', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const items = (JSON.parse(body.messages[0]!.content) as { items: Array<{ key: string; text: string }> }).items;
      const t = Object.fromEntries(items.map((item) => [item.key, `IT ${item.text}`]));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ t }) }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { ANTHROPIC_API_KEY: 'sk-env' } as NodeJS.ProcessEnv;
    const translator = await translatorFromKey(anthropicKeyWithEnvFallback(async () => null, env), env)();
    expect(translator).toBeInstanceOf(AnthropicCopyTranslator);
    const out = await translator!.translate({ sourceLocale: 'pt', targetLocale: 'it', pageTitle: 'x', items: [{ key: 'a', text: 'Olá', kind: 'text', label: 'Título', context: '' }] });
    expect(out).toEqual({ a: 'IT Olá' });
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>)['x-api-key']).toBe('sk-env');
  });

  it('sem chave nenhuma, não há provider', async () => {
    await expect(translatorFromKey(anthropicKeyWithEnvFallback(async () => null, {}), {})()).resolves.toBeNull();
  });
});
