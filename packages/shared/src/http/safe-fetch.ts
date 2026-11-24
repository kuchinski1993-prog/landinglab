// GET HTTP(S) protegido contra SSRF (story 18.2: promovido do VSL — import inteligente e "Importar de um link" —
// para `@blackshop/shared/http/safe-fetch`, sem mudar o comportamento; o VSL reexporta).
// Regras: só http/https nas portas padrão, sem credenciais na URL, hostname público; o DNS é resolvido aqui e
// TODOS os endereços precisam ser públicos (isPrivateAddress); a conexão é feita
// no IP já validado (sem nova resolução → sem DNS rebinding); no máximo 3 redirects, cada salto revalidado;
// timeout por requisição e corpo limitado em bytes.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { isPrivateAddress } from './private-address.js';

export { isPrivateAddress };

export type SafeFetchFailure =
  | 'invalid_url' | 'private_address' | 'dns_failed' | 'timeout' | 'too_large' | 'too_many_redirects' | 'http_status' | 'network';

export class SafeFetchError extends Error {
  /** `contentType`: preenchido em `too_large` (a resposta foi 200, só passou do limite de leitura). */
  constructor(readonly reason: SafeFetchFailure, readonly status?: number, readonly contentType?: string) {
    super(reason);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchResult { url: URL; status: number; contentType: string; bytes: Buffer }

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: string;
  userAgent?: string;
  /** Injeção para testes: resolução DNS (padrão: dns.lookup com todos os endereços). */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Injeção para testes: endereço bloqueado (padrão: faixas privadas/reservadas). */
  isBlockedAddress?: (address: string) => boolean;
  /** Injeção para testes: portas aceitas além das padrão. */
  allowedPorts?: string[];
}

export type SafeFetcher = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;

/** Navegador moderno: o Google Fonts devolve woff2 e unicode-range só para UAs atuais. */
export const SAFE_FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const BLOCKED_HOST = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/i;

/** Valida a sintaxe de uma URL pública http(s) (sem DNS). Lança SafeFetchError('invalid_url'). */
export function parsePublicHttpUrl(raw: string, allowedPorts: string[] = []): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new SafeFetchError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SafeFetchError('invalid_url');
  if (url.port && !['80', '443', ...allowedPorts].includes(url.port)) throw new SafeFetchError('invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SafeFetchError('invalid_url');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SafeFetchError('private_address');
  } else if (!host.includes('.') || BLOCKED_HOST.test(host)) throw new SafeFetchError('invalid_url');
  url.hash = '';
  return url;
}

const defaultResolve = async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      reject(new SafeFetchError('too_large', res.statusCode, contentType));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        reject(new SafeFetchError('too_large', res.statusCode, contentType));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', (error) => reject(error instanceof SafeFetchError ? error : new SafeFetchError('network')));
  });
}

async function once(url: URL, address: { address: string; family: number }, options: SafeFetchOptions, signal: AbortSignal):
  Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }> {
  const lookup: LookupFunction = (_name, lookupOptions, callback) => {
    if ((lookupOptions as { all?: boolean }).all)
      (callback as unknown as (err: null, list: Array<{ address: string; family: number }>) => void)(null, [address]);
    else callback(null, address.address, address.family);
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol, host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: 'GET', lookup, agent: false, signal,
      ...(url.protocol === 'https:' && !isIP(url.hostname) ? { servername: url.hostname } : {}),
      headers: {
        host: url.host, accept: options.accept ?? '*/*', 'accept-encoding': 'identity',
        'user-agent': options.userAgent ?? SAFE_FETCH_USER_AGENT,
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, location: res.headers.location, contentType: '', bytes: Buffer.alloc(0) });
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new SafeFetchError('http_status', status));
        return;
      }
      readBody(res, options.maxBytes)
        .then((bytes) => resolve({ status, contentType: String(res.headers['content-type'] ?? '').toLowerCase(), bytes }))
        .catch(reject);
    });
    req.on('error', (error) => {
      if (error instanceof SafeFetchError) reject(error);
      else if (signal.aborted || (error as { name?: string }).name === 'AbortError') reject(new SafeFetchError('timeout'));
      else reject(new SafeFetchError('network'));
    });
    req.end();
  });
}

/** GET seguro (ver cabeçalho do arquivo). Só 200 é sucesso; 3xx segue até `maxRedirects` (padrão 3). */
export const safeFetch: SafeFetcher = async (raw, options) => {
  const allowedPorts = options.allowedPorts ?? [];
  const blocked = options.isBlockedAddress ?? isPrivateAddress;
  const resolveHost = options.resolve ?? defaultResolve;
  const maxRedirects = options.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url = parsePublicHttpUrl(raw, allowedPorts);
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: Array<{ address: string; family: number }>;
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      try { addresses = await resolveHost(host); } catch { throw new SafeFetchError('dns_failed'); }
    }
    if (!addresses.length) throw new SafeFetchError('dns_failed');
    if (addresses.some((item) => blocked(item.address))) throw new SafeFetchError('private_address');
    if (signal.aborted) throw new SafeFetchError('timeout');
    const response = await once(url, addresses[0]!, options, signal);
    if (response.status === 200) return { url, status: 200, contentType: response.contentType, bytes: response.bytes };
    if (!response.location) throw new SafeFetchError('http_status', response.status);
    if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects');
    let next: URL;
    try { next = new URL(response.location, url); } catch { throw new SafeFetchError('invalid_url'); }
    url = parsePublicHttpUrl(next.href, allowedPorts);
  }
};
