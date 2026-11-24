import { createHttpClient, timeoutFromEnv } from '@blackshop/shared/http';
import { eq } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import { credentials } from '@blackshop/db';

import { decrypt, encrypt, mask } from './crypto.js';
import type { ConnectionStatus } from './testers/shopify-admin.tester.js';

/** Story 0.8: prazo da renovação do token Admin (client_credentials). */
export const SHOPIFY_TOKEN_TIMEOUT_MS = 10_000;

export interface CredentialSlot {
  key: string;
  label: string;
  group: CredentialGroup;
  masked_display: string | null;
  last_tested_at: Date | null;
  test_status: string | null;
  guide: string;
  readOnly: boolean;
}

export type CredentialGroup = 'shopify' | 'email' | 'storage' | 'ai';

interface KnownSlot {
  key: string;
  label: string;
  group: CredentialGroup;
  guide: string;
  // readOnly = valor gerenciado pelo sistema (ex.: admin token renovado
  // automaticamente via Client Credentials). A UI oculta os botões
  // Editar/Salvar/Limpar para não induzir edição manual.
  readOnly?: boolean;
}

const KNOWN_SLOTS: ReadonlyArray<KnownSlot> = [
  // ─── Shopify ──────────────────────────────────────────────────────────
  {
    key: 'shopify.store_domain',
    label: 'Shopify — Domínio da loja',
    group: 'shopify',
    guide:
      'Domínio da loja no formato: minhaloja.myshopify.com (sem https:// e sem barra final).',
  },
  {
    key: 'shopify.client_id',
    label: 'Shopify — Client ID do app',
    group: 'shopify',
    guide:
      '1. Shopify Dev Dashboard → seu app → Settings → API credentials. 2. Copie o Client ID. É usado com o Client Secret para gerar o Admin token automaticamente (Client Credentials Grant).',
  },
  {
    key: 'shopify.client_secret',
    label: 'Shopify — Client Secret do app',
    group: 'shopify',
    guide:
      '1. Shopify Dev Dashboard → seu app → Settings → API credentials → "Reveal client secret". 2. Copie o valor. Usado (a) para gerar o Admin token via Client Credentials e (b) para validar o HMAC dos webhooks — Shopify assina webhooks com o client secret.',
  },
  {
    key: 'shopify:webhook:secret',
    label: 'Shopify — Webhook Secret (HMAC)',
    group: 'shopify',
    guide:
      'Deve ser o MESMO valor do Client Secret do app. Shopify assina os webhooks com o client secret; se este campo divergir, os webhooks vão falhar na verificação HMAC (401). Cole aqui o mesmo valor que colou em "Client Secret".',
  },
  {
    key: 'shopify.admin_api_token',
    label: 'Shopify — Admin API Token (gerado automaticamente)',
    group: 'shopify',
    readOnly: true,
    guide:
      'Este token é GERADO E RENOVADO automaticamente pelo sistema via Client Credentials Grant. Não é necessário editar manualmente — mantenha Client ID, Client Secret e Store Domain configurados que o sistema cuida do resto.',
  },
  {
    key: 'shopify.storefront_api_token',
    label: 'Shopify — Storefront API Token (opcional)',
    group: 'shopify',
    guide:
      '1. Shopify Admin → Sales channels → Storefront API → Create token. 2. Habilite: read_products, unauthenticated_read_product_listings, unauthenticated_write_checkouts. 3. Copie o token gerado (NÃO confundir com o Admin token).',
  },

  // ─── E-mail ───────────────────────────────────────────────────────────
  {
    key: 'resend:api_key',
    label: 'Resend — API Key (envio de e-mail)',
    group: 'email',
    guide:
      '1. resend.com → API Keys → Create API Key. 2. Permissão: "Sending access" basta para ENVIAR; para o Suporte LandingLab ler os e-mails recebidos (Inbound) use "Full access". 3. Copie a chave (começa com re_...). Usada para enviar e-mails transacionais e buscar o conteúdo dos e-mails recebidos.',
  },
  {
    key: 'resend:inbound_webhook_secret',
    label: 'Resend — Signing secret do webhook de recebimento (LandingLab → Suporte)',
    group: 'email',
    guide:
      '1. resend.com → Webhooks → Add Webhook. 2. Endpoint URL: https://<host da API>/webhooks/resend/inbound. 3. Evento: email.received. 4. Salve, abra o webhook e copie o "Signing secret" (começa com whsec_). 5. Cole aqui. Sem este valor a API recusa todo e-mail recebido (fail closed). A chave resend:api_key precisa de acesso total (Full access) para a API ler o conteúdo dos e-mails recebidos.',
  },
  {
    key: 'inbound:email:secret',
    label: 'Inbound E-mail — Secret (Cloudflare Email Worker)',
    group: 'email',
    guide:
      'Segredo compartilhado com o Cloudflare Email Worker que encaminha e-mails para a API. O worker inclui este valor no header X-Inbound-Secret; a API rejeita requisições sem match. Configure o mesmo valor aqui e no Worker.',
  },

  // ─── Storage ──────────────────────────────────────────────────────────
  {
    key: 'supabase.url',
    label: 'Supabase — URL do projeto',
    group: 'storage',
    guide:
      'URL do projeto no formato: https://<ref>.supabase.co (Project Settings → API → Project URL).',
  },
  {
    key: 'supabase.service_role_key',
    label: 'Supabase — Service Role Key (bucket de anexos)',
    group: 'storage',
    guide:
      'Project Settings → API → Service role key (secret). Usada pelo servidor para operações no Storage (bucket de anexos). NUNCA exponha no frontend.',
  },

  // ─── IA ───────────────────────────────────────────────────────────────
  {
    key: 'anthropic.api_key',
    label: 'Anthropic — API Key (IA do TrustShield) (opcional)',
    group: 'ai',
    guide:
      '1. console.anthropic.com → API Keys → Create Key. 2. Copie a chave (começa com sk-ant-...). Em produção a chave normalmente vem da variável de ambiente ANTHROPIC_API_KEY; este slot é um override opcional pela UI.',
  },
  {
    // Story 12.1 · usada pelo gerador de prompts de imagem (backoffice).
    // Sem esta chave, o endpoint /api/editor/ai/generate-image-prompts opera
    // em modo mock (retorna 3 prompts estáticos por sectionType).
    key: 'openai:api_key',
    label: 'OpenAI — API Key (Gerador de prompts de imagem)',
    group: 'ai',
    guide:
      '1. platform.openai.com → API keys → Create secret key. 2. Copie a chave (começa com sk-...). 3. Sem esta chave, o gerador de prompts opera em modo mock (retorna 3 prompts estáticos). Habilite modo real preenchendo aqui.',
  },
  {
    // Story 12.1 v1.4 · Anthropic Claude Haiku para o gerador de prompts
    // de imagem (backoffice). Preferido pelo dono sobre OpenAI. Chave
    // com dois-pontos (padrão story) — distinta de anthropic.api_key
    // (usada pelo TrustShield, separada por escopo).
    // Sem esta chave, o modo `auto` cai em OpenAI (se openai:api_key
    // presente) ou em template (sempre disponível). Falha da API →
    // fallback silencioso pra template.
    key: 'anthropic:api_key',
    label: 'Anthropic — API Key (Claude Haiku · gerador de prompts de imagem)',
    group: 'ai',
    guide:
      '1. console.anthropic.com → API Keys → Create Key. 2. Copie a chave (começa com sk-ant-...). 3. Chave usada pelo modo `anthropic` do gerador de prompts de imagem. Claude Haiku é o modelo padrão — barato e rápido. Sem esta chave, o gerador cai em OpenAI (se configurado) ou em template. Distinta de anthropic.api_key (TrustShield).',
  },
];

export class VaultService {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
  ) {}

  async set(key: string, value: string): Promise<void> {
    const blob = await encrypt(value, this.secret);

    await this.db
      .insert(credentials)
      .values({
        key,
        encryptedValue: blob.ciphertext,
        iv: blob.iv,
        salt: blob.salt,
      })
      .onConflictDoUpdate({
        target: credentials.key,
        set: {
          encryptedValue: blob.ciphertext,
          iv: blob.iv,
          salt: blob.salt,
          updatedAt: new Date(),
        },
      });
  }

  async get(key: string): Promise<string | null> {
    const raw = await this.getRaw(key);
    if (raw === null) return null;
    return mask(raw);
  }

  async getRaw(key: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.key, key))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return await decrypt(
      row.encryptedValue as Buffer,
      row.iv as Buffer,
      row.salt as Buffer,
      this.secret,
    );
  }

  async test(key: string): Promise<ConnectionStatus> {
    const value = await this.getRaw(key);
    if (!value) {
      return { status: 'error', message: 'Credential not configured' };
    }

    const result = await this.runTester(key, value);

    await this.db
      .update(credentials)
      .set({ lastTestedAt: new Date(), testStatus: result.status })
      .where(eq(credentials.key, key));

    return result;
  }

  // Dispatcher separado do `test()` para facilitar testes unitários.
  // Cada chave decide como aferir sua saúde de forma HONESTA — se não
  // há como testar remotamente, o retorno é 'configured' (nunca 'error').
  private async runTester(key: string, value: string): Promise<ConnectionStatus> {
    // ─── Shopify — tríade de app: cliente id/secret/domain testam juntos
    // via Client Credentials Grant. Testar qualquer um roda o mesmo fluxo.
    if (
      key === 'shopify.client_id' ||
      key === 'shopify.client_secret' ||
      key === 'shopify.store_domain'
    ) {
      const [clientId, clientSecret, storeDomain] = await Promise.all([
        this.getRaw('shopify.client_id'),
        this.getRaw('shopify.client_secret'),
        this.getRaw('shopify.store_domain'),
      ]);
      if (!clientId || !clientSecret || !storeDomain) {
        // Se só o domínio está preenchido, ainda faz sentido o teste DNS
        // legado (comportamento anterior).
        if (key === 'shopify.store_domain') {
          const { testShopifyDomain } = await import('./testers/shopify-domain.tester.js');
          return await testShopifyDomain(value);
        }
        return {
          status: 'configured',
          message:
            'Preencha client_id, client_secret e store_domain para testar a conexão Shopify Admin.',
        };
      }
      const { testShopifyAppCredentials } = await import(
        './testers/shopify-app-credentials.tester.js'
      );
      return await testShopifyAppCredentials({ clientId, clientSecret, storeDomain });
    }

    // ─── Shopify Admin API Token — gerado automaticamente; teste informativo.
    if (key === 'shopify.admin_api_token') {
      const domain = await this.getRaw('shopify.store_domain');
      if (!domain) {
        return {
          status: 'configured',
          message:
            'Admin token presente. Sem store_domain configurado para validar remotamente.',
        };
      }
      const { testShopifyAdminToken } = await import('./testers/shopify-admin.tester.js');
      return await testShopifyAdminToken(value, domain);
    }

    // ─── Shopify Webhook Secret — compara com client secret (safeEqual).
    if (key === 'shopify:webhook:secret') {
      const clientSecret = await this.getRaw('shopify.client_secret');
      const { testShopifyWebhookSecret } = await import(
        './testers/shopify-webhook-secret.tester.js'
      );
      return testShopifyWebhookSecret(value, clientSecret);
    }

    // ─── Shopify Storefront Token — tester próprio.
    if (key === 'shopify.storefront_api_token') {
      const domain = await this.getRaw('shopify.store_domain');
      if (!domain) {
        return {
          status: 'configured',
          message: 'Storefront token presente. Configure store_domain para testar.',
        };
      }
      const { testShopifyStorefrontToken } = await import(
        './testers/shopify-storefront.tester.js'
      );
      return await testShopifyStorefrontToken(value, domain);
    }

    // ─── Resend
    if (key === 'resend:api_key') {
      const { testResendKey } = await import('./testers/resend.tester.js');
      return await testResendKey(value);
    }

    // ─── Webhook de recebimento do Resend (Story 15.5) — validado na chegada.
    if (key === 'resend:inbound_webhook_secret') {
      return value.startsWith('whsec_')
        ? {
            status: 'configured',
            message:
              'Secret presente. A validação acontece quando o Resend enviar o próximo e-mail recebido (assinatura Svix).',
          }
        : { status: 'error', message: 'O signing secret do Resend começa com whsec_. Copie o valor completo do webhook.' };
    }

    // ─── Inbound e-mail secret — sem endpoint remoto para validar.
    if (key === 'inbound:email:secret') {
      return {
        status: 'configured',
        message:
          'Secret presente. Não há teste de rede — a validação acontece quando o Cloudflare Email Worker envia o próximo e-mail.',
      };
    }

    // ─── Supabase
    if (key === 'supabase.url') {
      const { testSupabaseUrl } = await import('./testers/supabase.tester.js');
      return await testSupabaseUrl(value);
    }
    if (key === 'supabase.service_role_key') {
      const url = await this.getRaw('supabase.url');
      const { testSupabaseServiceKey } = await import('./testers/supabase.tester.js');
      return await testSupabaseServiceKey(value, url);
    }

    // ─── Anthropic
    if (key === 'anthropic.api_key') {
      const { testAnthropicKey } = await import('./testers/anthropic.tester.js');
      return await testAnthropicKey(value);
    }

    // Fallback honesto: se chegou aqui, o valor está salvo mas não temos
    // teste de rede — reportamos 'configured', nunca 'error'.
    return {
      status: 'configured',
      message: 'Credencial configurada. Sem teste de rede definido para esta chave.',
    };
  }

  /**
   * Returns a valid Shopify Admin API token, renewing it via Client Credentials Grant if
   * the cached token is absent or expires within 5 minutes.
   * Requires shopify.client_id, shopify.client_secret, and shopify.store_domain in the vault.
   */
  async getAdminToken(): Promise<string> {
    const RENEWAL_MARGIN_MS = 5 * 60 * 1000; // renew if less than 5 min remaining

    // Check cached token validity
    const [currentToken, expiresAtStr] = await Promise.all([
      this.getRaw('shopify.admin_api_token'),
      this.getRaw('shopify.admin_api_token_expires_at'),
    ]);

    if (currentToken && expiresAtStr) {
      const expiresAt = Number(expiresAtStr);
      if (!Number.isNaN(expiresAt) && Date.now() + RENEWAL_MARGIN_MS < expiresAt) {
        console.debug('[Vault] token Admin em cache válido, reutilizando');
        return currentToken;
      }
    }

    // Token absent or expiring — renew via Client Credentials Grant
    console.info('[Vault] token Admin expirado/ausente, gerando novo via client_credentials');

    const [clientId, clientSecret, storeDomain] = await Promise.all([
      this.getRaw('shopify.client_id'),
      this.getRaw('shopify.client_secret'),
      this.getRaw('shopify.store_domain'),
    ]);

    if (!clientId || !clientSecret) {
      throw new Error(
        'Credenciais do app Shopify (client_id/client_secret) não configuradas — configure na tela de Credenciais',
      );
    }
    if (!storeDomain) {
      throw new Error('shopify.store_domain não configurado no Vault');
    }

    // Story 0.8: prazo de 10 s (SHOPIFY_TOKEN_TIMEOUT_MS) — toda chamada Admin depende
    // daqui. Timeout → UpstreamTimeoutError (uncertain: false, pode ser retentado). Em
    // falha o token antigo NÃO é apagado, e a mensagem nunca leva client_secret nem corpo.
    // Story 18.2: cliente compartilhado, uma tentativa (como na 0.8). Renovar o token é idempotente
    // (um token novo a mais não causa efeito), então timeout aqui NÃO é incerto. 429/5xx/4xx voltam
    // como resposta e mantêm a mensagem de sempre abaixo.
    const url = `https://${storeDomain}/admin/oauth/access_token`;
    const http = createHttpClient({
      label: 'shopify-oauth-token',
      timeoutMs: timeoutFromEnv('SHOPIFY_TOKEN_TIMEOUT_MS', SHOPIFY_TOKEN_TIMEOUT_MS),
      httpErrors: 'return',
      retry: { attempts: 1 },
    });
    const { response } = await http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
        }),
      },
      { idempotent: true },
    );

    if (!response.ok) {
      // QA F4: só o campo `error` do JSON da Shopify (enum curto, ex.: invalid_client) —
      // nunca o corpo bruto.
      const shopifyError = await response
        .json()
        .then((b: unknown) => (b as { error?: unknown } | null)?.error)
        .catch(() => undefined);
      const reason =
        typeof shopifyError === 'string' && /^[a-z_]{1,64}$/.test(shopifyError) ? `: ${shopifyError}` : '';
      throw new Error(`Falha ao renovar token Admin Shopify (HTTP ${response.status}${reason})`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error('Resposta do endpoint de token não contém access_token');
    }

    const expiresAt = Date.now() + data.expires_in * 1000;
    await Promise.all([
      this.set('shopify.admin_api_token', data.access_token),
      this.set('shopify.admin_api_token_expires_at', String(expiresAt)),
    ]);

    console.info(
      `[Vault] token Admin renovado, validade ${Math.round(data.expires_in / 3600)}h (expira em ${new Date(expiresAt).toISOString()})`,
    );

    return data.access_token;
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(credentials).where(eq(credentials.key, key));
  }

  async list(): Promise<CredentialSlot[]> {
    const rows = await this.db.select().from(credentials);
    const storedByKey = new Map(rows.map((r) => [r.key, r]));

    return await Promise.all(
      KNOWN_SLOTS.map(async (slot) => {
        const stored = storedByKey.get(slot.key);
        let masked: string | null = null;

        if (stored) {
          try {
            const raw = await decrypt(
              stored.encryptedValue as Buffer,
              stored.iv as Buffer,
              stored.salt as Buffer,
              this.secret,
            );
            masked = mask(raw);
          } catch {
            masked = '••••••••????';
          }
        }

        return {
          key: slot.key,
          label: slot.label,
          group: slot.group,
          masked_display: masked,
          last_tested_at: stored?.lastTestedAt ?? null,
          test_status: stored?.testStatus ?? null,
          guide: slot.guide,
          readOnly: slot.readOnly === true,
        };
      }),
    );
  }
}
