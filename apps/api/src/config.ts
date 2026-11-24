// Environment configuration with validation at startup.
// Throws on invalid SESSION_SECRET or missing APP_PASSWORD_HASH to surface misconfiguration before the server binds.

const MIN_SECRET_LENGTH = 32;

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  sessionSecret: string;
  appPasswordHash: string;
  corsOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  vaultSecret: string;
  cookieSecure: boolean;
  rateLimitMax: number;
  rateLimitWindow: string;
  nodeEnv: 'development' | 'test' | 'production';
  // Base URL do backoffice (sem barra final) — usada para montar links
  // absolutos em e-mails (ex.: alertas de dispute). Se vazio, o e-mail
  // omite o hyperlink em vez de gerar um href quebrado (host inexistente).
  backofficeUrl: string;
  // URL pública desta API (sem barra final), ex.: https://api.exemplo.com.
  // Monta a URL de webhook exibida na aba Stripe (Story 15.1). Se vazia, a
  // aba deriva do host da requisição e mostra um alerta.
  publicApiUrl: string;
  /**
   * Proxies confiáveis à frente da API (Fastify `trustProxy`). Produção: 1
   * (Railway) por padrão, TRUST_PROXY_HOPS para ajustar; nunca `true` (o IP
   * mais à esquerda do X-Forwarded-For é controlado pelo cliente — QA 15.4 SEC-001).
   */
  trustProxy: number | false;
  /** Segredo compartilhado com o storefront para assinar o IP do cliente (>= 32 chars). */
  landinglabProxySecret: string | null;
  /**
   * VSL-13: segredo DEDICADO (>= 32 chars) do endpoint interno vsl-storefront → API da Meta CAPI
   * (HMAC-SHA256). Não reaproveita LANDINGLAB_PROXY_SECRET. null = endpoint desligado (404).
   */
  vslCapiInternalSecret: string | null;
  /**
   * VSL Hosting legacy (G1/G2: /vsl/pages, imports, videos, variants, translation,
   * domain-bindings, /vsl/public/resolve). Default false — só G3 é registrado.
   */
  vslLegacyEnabled: boolean;
  /** Redis dedicado das filas VSL legacy (produtor = consumidor). null = filas VSL não são criadas. */
  vslRedisUrl: string | null;
  /**
   * Story 22.1a-2 · remetente dos e-mails de acesso (convite, redefinição, aviso de solicitação),
   * domínio verificado no Resend — ex.: `BlackShop <acesso@authenlondon.com>`. null = nenhum e-mail
   * de acesso sai (resultado `not_configured`, erro no log) — nunca mock silencioso.
   */
  authEmailFrom: string | null;
  /** Story 22.1a-2 · D10 — `LEGACY_LOGIN_ENABLED=false` desliga o acesso de emergência (senha antiga). */
  legacyLoginEnabled: boolean;
  /**
   * Story 22.1a-2 · D10/C-3 — fim do acesso de emergência (ISO 8601). Passou da data ou ausente em
   * produção ⇒ emergência desligada (fail-closed). Inválida ⇒ tratada como ausente.
   */
  legacyLoginUntil: Date | null;
  /** TTL do convite em horas (padrão 48; preso entre 15 min e 7 dias em `tokens.ts`). */
  authInviteTtlHours: number | null;
  /** TTL da redefinição em minutos (padrão 60; preso entre 5 min e 24 h em `tokens.ts`). */
  authResetTtlMinutes: number | null;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseOptionalDate(raw: string | undefined): Date | null {
  if (raw === undefined || raw.trim() === '') return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTrustProxy(nodeEnv: AppConfig['nodeEnv']): number | false {
  const raw = process.env['TRUST_PROXY_HOPS'];
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    const hops = Number.parseInt(raw.trim(), 10);
    return hops > 0 ? hops : false;
  }
  return nodeEnv === 'production' ? 1 : false;
}

export function loadConfig(): AppConfig {
  const nodeEnv = (process.env['NODE_ENV'] ?? 'development') as AppConfig['nodeEnv'];
  const sessionSecret = process.env['SESSION_SECRET'] ?? '';

  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${sessionSecret.length}). ` +
        'Refusing to start with weak session secret.'
    );
  }

  const appPasswordHash = process.env['APP_PASSWORD_HASH'] ?? '';
  if (!appPasswordHash.startsWith('$2') && nodeEnv !== 'test') {
    throw new Error(
      'APP_PASSWORD_HASH is missing or not a valid bcrypt hash. ' +
        'Run: node -e "require(\'bcrypt\').hash(\'YOUR_PASSWORD\',10).then(console.log)" to generate one.'
    );
  }

  const vaultSecret = process.env['VAULT_SECRET'] ?? '';
  if (vaultSecret.length < MIN_SECRET_LENGTH && nodeEnv !== 'test') {
    throw new Error(
      `VAULT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${vaultSecret.length}). ` +
        'Required for credential encryption.'
    );
  }

  return {
    port: Number.parseInt(process.env['PORT'] ?? process.env['PORT_API'] ?? '3001', 10),
    host: process.env['HOST'] ?? '0.0.0.0',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    sessionSecret,
    appPasswordHash,
    corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:3000',
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://blackshop:changeme@localhost:5432/blackshop',
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    vaultSecret,
    cookieSecure: nodeEnv === 'production',
    rateLimitMax: Number.parseInt(process.env['RATE_LIMIT_MAX'] ?? '100', 10),
    rateLimitWindow: process.env['RATE_LIMIT_WINDOW'] ?? '1 minute',
    nodeEnv,
    // Normaliza: remove barra final para evitar `//` no href montado.
    backofficeUrl: (process.env['BACKOFFICE_URL'] ?? '').replace(/\/+$/, ''),
    publicApiUrl: (process.env['PUBLIC_API_URL'] ?? '').replace(/\/+$/, ''),
    trustProxy: parseTrustProxy(nodeEnv),
    landinglabProxySecret:
      (process.env['LANDINGLAB_PROXY_SECRET'] ?? '').length >= MIN_SECRET_LENGTH ? process.env['LANDINGLAB_PROXY_SECRET']! : null,
    vslCapiInternalSecret:
      (process.env['VSL_CAPI_INTERNAL_SECRET'] ?? '').length >= MIN_SECRET_LENGTH ? process.env['VSL_CAPI_INTERNAL_SECRET']! : null,
    vslLegacyEnabled: process.env['VSL_LEGACY_ENABLED'] === 'true',
    vslRedisUrl: process.env['VSL_REDIS_URL'] || null,
    authEmailFrom: (process.env['AUTH_EMAIL_FROM'] ?? '').trim() || null,
    legacyLoginEnabled: (process.env['LEGACY_LOGIN_ENABLED'] ?? '').trim().toLowerCase() !== 'false',
    legacyLoginUntil: parseOptionalDate(process.env['LEGACY_LOGIN_UNTIL']),
    authInviteTtlHours: parseOptionalNumber(process.env['AUTH_INVITE_TTL_HOURS']),
    authResetTtlMinutes: parseOptionalNumber(process.env['AUTH_RESET_TTL_MINUTES']),
  };
}
