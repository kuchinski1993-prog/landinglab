// Cliente Stripe por conta + teste de conexão (Story 15.1, AC5).
import Stripe from 'stripe';

export type StripeClient = Stripe;

export function createStripeClient(secretKey: string): StripeClient {
  return new Stripe(secretKey, {
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: 'blackshop-landinglab' },
  });
}

export interface StripeConnectionResult {
  ok: boolean;
  message: string;
  accountRef: string | null;
  defaultCurrency: string | null;
  chargesEnabled: boolean | null;
  livemode: boolean | null;
  /**
   * Story 15.6: a chave consegue operar assinaturas? null = não verificado
   * (erro não relacionado a permissão). Não afeta `ok` (chave só-avulso segue válida).
   */
  subscriptionReady?: boolean | null;
}

/** Permissões extras da chave restrita para assinatura (AC17), além das da 15.3. */
export const SUBSCRIPTION_KEY_PERMISSIONS = [
  'Customers: Write',
  'Subscriptions: Write',
  'Products: Write',
  'Prices: Write',
  'Invoices: Read',
  'Customer portal: Write',
] as const;

export const SUBSCRIPTION_PERMISSION_WARNING =
  'Aviso: a chave não tem as permissões de assinatura (' +
  SUBSCRIPTION_KEY_PERMISSIONS.join(', ') +
  ') — necessárias só para vender assinaturas.';

/** Sonda leituras usadas por assinaturas; só PermissionError conta como "falta permissão". */
export async function probeSubscriptionPermissions(client: StripeClient): Promise<boolean | null> {
  try {
    await client.subscriptions.list({ limit: 1 });
    await client.customers.list({ limit: 1 });
    await client.prices.list({ limit: 1 });
    await client.billingPortal.configurations.list({ limit: 1 });
    return true;
  } catch (error) {
    return stripeErrorType(error) === 'StripePermissionError' ? false : null;
  }
}

async function withSubscriptionProbe(
  client: StripeClient,
  result: StripeConnectionResult,
): Promise<StripeConnectionResult> {
  if (!result.ok) return result;
  const ready = await probeSubscriptionPermissions(client);
  return {
    ...result,
    subscriptionReady: ready,
    ...(ready === false ? { message: `${result.message} ${SUBSCRIPTION_PERMISSION_WARNING}` } : {}),
  };
}

function fail(message: string): StripeConnectionResult {
  return {
    ok: false,
    message,
    accountRef: null,
    defaultCurrency: null,
    chargesEnabled: null,
    livemode: null,
  };
}

/**
 * Valida a chave consultando a própria conta. Chaves restritas (rk_) sem
 * permissão de leitura de conta caem para `balance.retrieve`, que só confirma
 * que a chave é válida. Nunca inclui a chave na mensagem.
 */
export async function testStripeConnection(client: StripeClient): Promise<StripeConnectionResult> {
  return withSubscriptionProbe(client, await testBaseConnection(client));
}

async function testBaseConnection(client: StripeClient): Promise<StripeConnectionResult> {
  try {
    const account = await client.accounts.retrieveCurrent();
    const chargesEnabled = account.charges_enabled;
    return {
      ok: true,
      message: chargesEnabled
        ? 'Conexão OK — conta pronta para receber pagamentos.'
        : 'Chave válida, mas a conta ainda não pode receber pagamentos (verifique a ativação no painel Stripe).',
      accountRef: account.id,
      defaultCurrency: account.default_currency?.toUpperCase() ?? null,
      chargesEnabled,
      livemode: null,
    };
  } catch (error) {
    if (stripeErrorType(error) === 'StripePermissionError') {
      return testWithBalance(client);
    }
    return fail(describeStripeError(error));
  }
}

async function testWithBalance(client: StripeClient): Promise<StripeConnectionResult> {
  try {
    const balance = await client.balance.retrieve();
    const currency = balance.available[0]?.currency ?? balance.pending[0]?.currency ?? null;
    return {
      ok: true,
      message:
        'Chave válida. A chave restrita não tem permissão de leitura da conta — conceda "Account: Read" para ver os detalhes.',
      accountRef: null,
      defaultCurrency: currency ? currency.toUpperCase() : null,
      chargesEnabled: null,
      livemode: balance.livemode,
    };
  } catch (error) {
    return fail(describeStripeError(error));
  }
}

// Compara pelo `type` (nome da classe) em vez de instanceof: sobrevive a
// duas cópias do SDK no grafo de módulos (ESM/CJS).
export function stripeErrorType(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const type: unknown = (error as Error & { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('Stripe') ? type : null;
}

export function describeStripeError(error: unknown): string {
  switch (stripeErrorType(error)) {
    case 'StripeAuthenticationError':
      return 'Chave secreta recusada pela Stripe (inválida ou revogada).';
    case 'StripePermissionError':
      return 'A chave não tem permissão para esta operação.';
    case 'StripeConnectionError':
      return 'Não foi possível conectar à Stripe. Tente novamente.';
    case null:
      return 'Erro inesperado ao consultar a Stripe.';
    default: {
      const code = (error as Error & { code?: string }).code;
      return `Erro da Stripe: ${code ?? stripeErrorType(error)}`;
    }
  }
}
