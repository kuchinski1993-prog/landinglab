// Asset Downloader — baixa imagens/stylesheets/fonts referenciados pela landing
// clonada e reescreve o HTML pra apontar pros nossos assets locais.
//
// Storage layout: {storageRoot}/{landingId}/{sha256(url).ext}
// URL pública: {publicPathPrefix}/{landingId}/{sha256(url).ext}
//
// Estratégia de reescrita HTML:
// - Substitui matches de string exata da URL (não usa parser DOM pra evitar
//   perda de fidelidade em atributos custom / data-*).
// - Rewriter também deve rodar no CSS inline (background-image, @import).

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface DownloadInput {
  landingId: string;
  urls: string[];
  /** Absolute filesystem path onde salvar. Ex: apps/worker/storage/cloned-landings */
  storageRoot: string;
  /** Prefix público servido pelo Next. Ex: /static/cloned */
  publicPathPrefix: string;
  /** Timeout per-request em ms. Default 15000. */
  timeoutMs?: number;
  /** Max concurrent downloads. Default 6. */
  concurrency?: number;
  /** Referer opcional pra passar em cada fetch (alguns CDNs exigem). */
  referer?: string;
}

export interface DownloadedAsset {
  originalUrl: string;
  publicUrl: string;
  localPath: string;
  bytes: number;
  contentType: string;
}

export interface DownloadResult {
  assets: DownloadedAsset[];
  failed: Array<{ url: string; error: string }>;
  /** Map original URL → public URL — usado pelo rewriter. */
  urlMap: Map<string, string>;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Deriva nome de arquivo determinístico via hash do CONTEÚDO binário. Isso
 * dedupa automaticamente assets iguais servidos por URLs diferentes (mesma
 * imagem, hosts/query-strings diferentes) — sem essa dedup, o grid de
 * seleção de imagens no wizard fica cheio de duplicatas (mesma imagem
 * aparece 2-3x, uma vez por URL variant).
 *
 * Mantém a extensão detectável via Content-Type ou URL.
 */
function fileNameForContent(buf: Buffer, url: string, contentType: string): string {
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const ext = deriveExtension(url, contentType);
  return `${hash}${ext}`;
}

function deriveExtension(url: string, contentType: string): string {
  const ctMain = contentType.split(';')[0]?.trim().toLowerCase();
  if (ctMain) {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'image/avif': '.avif',
      'text/css': '.css',
      'font/woff': '.woff',
      'font/woff2': '.woff2',
      'application/font-woff': '.woff',
      'application/font-woff2': '.woff2',
      'font/ttf': '.ttf',
      'font/otf': '.otf',
      'application/vnd.ms-fontobject': '.eot',
      'application/javascript': '.js',
      'application/x-javascript': '.js',
      'text/javascript': '.js',
      'module': '.js',
      'application/json': '.json',
    };
    if (map[ctMain]) return map[ctMain];
  }
  const pathname = safeUrlPath(url);
  const urlExt = extname(pathname);
  if (urlExt && urlExt.length <= 6) return urlExt;
  return '.bin';
}

function safeUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function downloadOne(
  url: string,
  timeoutMs: number,
  referer: string | undefined,
): Promise<{ buf: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'image/*, text/css, font/*, application/javascript, text/javascript, */*',
        ...(referer ? { referer } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const arrayBuf = await res.arrayBuffer();
    return { buf: Buffer.from(arrayBuf), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Baixa em paralelo com limite de concorrência.
 * Falhas individuais NÃO abortam o batch — vira entrada em `failed`.
 */
export async function downloadAssets(input: DownloadInput): Promise<DownloadResult> {
  const {
    landingId,
    urls,
    storageRoot,
    publicPathPrefix,
    timeoutMs = 15_000,
    concurrency = 6,
    referer,
  } = input;

  const targetDir = join(storageRoot, landingId);
  await mkdir(targetDir, { recursive: true });

  // Dedup URLs (mesma imagem referenciada várias vezes = uma única download).
  const uniqUrls = Array.from(new Set(urls.filter((u) => u && !u.startsWith('data:'))));

  const assets: DownloadedAsset[] = [];
  const failed: Array<{ url: string; error: string }> = [];
  const urlMap = new Map<string, string>();

  // Semáforo simples: array de "slots" que a gente aguarda.
  const queue = [...uniqUrls];
  const workers: Promise<void>[] = [];

  // Dedup por conteúdo: se duas URLs retornam o mesmo binário, aponta ambas
  // pro MESMO publicUrl e escreve o arquivo só 1 vez.
  const contentHashToPublicUrl = new Map<string, { publicUrl: string; localPath: string; bytes: number; contentType: string }>();

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      // Retry até 3x com backoff exponencial (250ms → 500ms → 1000ms).
      // Muitos assets falhavam por transient timeout/rate limit do CDN.
      let lastErr: Error | null = null;
      let result: { buf: Buffer; contentType: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await downloadOne(url, timeoutMs, referer);
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) await sleep(250 * Math.pow(2, attempt));
        }
      }
      if (result) {
        const { buf, contentType } = result;
        const name = fileNameForContent(buf, url, contentType);
        const contentKey = name; // filename já é hash do conteúdo
        const existing = contentHashToPublicUrl.get(contentKey);
        let publicUrl: string;
        let localPath: string;
        if (existing) {
          // Mesmo conteúdo baixado por outra URL — reusa o arquivo já escrito
          publicUrl = existing.publicUrl;
          localPath = existing.localPath;
        } else {
          localPath = join(targetDir, name);
          await writeFile(localPath, buf);
          publicUrl = `${publicPathPrefix.replace(/\/$/, '')}/${landingId}/${name}`;
          contentHashToPublicUrl.set(contentKey, { publicUrl, localPath, bytes: buf.length, contentType });
          assets.push({
            originalUrl: url,
            publicUrl,
            localPath,
            bytes: buf.length,
            contentType,
          });
        }
        // urlMap: TODAS as URLs (originais) → o mesmo publicUrl deduped
        urlMap.set(url, publicUrl);
      } else {
        failed.push({ url, error: lastErr?.message ?? 'unknown error' });
      }
      // Micro pausa pra não abusar do CDN.
      await sleep(50);
    }
  }

  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return { assets, failed, urlMap };
}

/**
 * Reescreve TODAS as ocorrências das URLs originais no HTML/CSS pelas URLs
 * públicas locais. Estratégia dupla:
 *
 * PASSE 1 (URLs exatas com boundary):
 *   URLs completas do urlMap são substituídas quando aparecem literais no HTML,
 *   respeitando boundaries (quote/whitespace/vírgula) pra não substituir prefixos.
 *
 * PASSE 2 (path-based rewrite pra srcset variantes):
 *   Shopify CDN (e outros) servem MESMA imagem em N tamanhos via query string
 *   (`?v=X&width=550`, `?v=X&width=1100`, etc). O renderer coleta TODAS as
 *   variantes do srcset, mas o download pode falhar em muitas (concorrência,
 *   timeout) resultando em urlMap contendo só algumas. Este passe pega TODAS
 *   as URLs no HTML que compartilham o mesmo path base (sem query) de uma URL
 *   baixada com sucesso, e substitui pela versão Supabase. Assim UMA baixa
 *   resolve N refs no HTML.
 *
 * Sem este passe, srcset variantes que não foram baixadas ficam apontando
 * pro CDN origem → browser carrega direto, mas o arquivo NÃO está no bucket,
 * então o classifier IA / grid de tradução nunca vê essas imagens.
 */
export function rewriteUrls(html: string, urlMap: Map<string, string>): string {
  let out = html;

  // PASSE 1: URLs exatas com boundary. Ordena por comprimento desc pra tentar
  // URL longa antes de curta (evita match parcial).
  const entries = Array.from(urlMap.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [orig, local] of entries) {
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRegex = new RegExp(`${escaped}(?=["'\\s,)\\]}]|$)`, 'g');
    out = out.replace(boundaryRegex, local);
  }

  // PASSE 2: path-based rewrite. Cada URL baixada tem um path base
  // (sem query). Substituímos TODAS refs no HTML com aquele path (independente
  // de query string) pela publicUrl. Isso resolve srcset variantes que o
  // download não pegou individualmente.
  //
  // Só aplica pra assets image (path termina em .jpg/.png/.webp/.gif/.svg/.avif)
  // pra evitar quebrar CSS/JS/font URLs que podem ter query strings semânticas.
  const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
  const pathToPublicUrl = new Map<string, string>();
  for (const [orig, local] of entries) {
    try {
      const parsed = new URL(orig);
      const pathname = parsed.pathname;
      if (!IMG_EXT_RE.test(pathname)) continue;
      // Chave: host + path (sem protocolo, sem query). Ex: "bepurex.com/cdn/shop/files/1_X.webp"
      const key = `${parsed.host}${pathname}`;
      // Se já temos URL nesse path com prefix diferente, mantém a primeira
      // (equivalente por dedup de conteúdo, que roda antes).
      if (!pathToPublicUrl.has(key)) pathToPublicUrl.set(key, local);
    } catch {
      /* URL malformada, ignora */
    }
  }
  for (const [pathKey, local] of pathToPublicUrl) {
    // Match variações: com https?://, com //, com escaping em JSON \/\/
    // e com ou sem query string. Boundary: pare em quote/whitespace/vírgula/
    // parênteses. NÃO consome & = ? / pra não estourar em URLs vizinhas.
    const escapedKey = pathKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Regex genérico: (https?:)?// OU escaped \/\/
    const patterns = [
      new RegExp(`https?://${escapedKey}(?:\\?[^"'\\s,)\\]}]*)?`, 'g'),
      new RegExp(`(?<![:a-z])//${escapedKey}(?:\\?[^"'\\s,)\\]}]*)?`, 'g'),
      new RegExp(`\\\\/\\\\/${escapedKey.replace(/\\\//g, '\\\\/')}(?:\\\\?[^"'\\s,)\\]}]*)?`, 'g'),
    ];
    for (const p of patterns) {
      out = out.replace(p, local);
    }
  }

  return out;
}
