import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';

interface R2Client {
  send<Output>(command: unknown): Promise<Output>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export function safePath(input: string): string {
  if (
    !input ||
    input.includes('\\') ||
    input.includes('\0') ||
    [...input].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Invalid VSL path');
  let decoded = input;
  for (let n = 0; n < 4; n++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) throw new Error('Excessively encoded VSL path');
  if (
    decoded.startsWith('/') ||
    /^[a-z]:/i.test(decoded) ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((p) => p === '..' || p === '.' || p === '')
  )
    throw new Error('Unsafe VSL path');
  if (
    decoded.normalize('NFC') !== decoded ||
    decoded
      .split('/')
      .some(
        (p) =>
          p.includes(':') ||
          [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          /[. ]$/.test(p)
      )
  )
    throw new Error('Ambiguous VSL path');
  return decoded;
}
export interface VslStorage {
  putExclusive(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  seal(prefix: string, manifest: Manifest): Promise<void>;
  isSealed(prefix: string, manifest: Manifest): Promise<boolean>;
  removeAttempt(importId: string, attemptId: string): Promise<void>;
}
/** Operações extras usadas pelo import G3 assíncrono (upload em stream + limpeza). */
export interface VslObjectStore extends VslStorage {
  /** Grava `source` em `key` (exclusivo) sem carregar tudo em memória; falha acima de `maxBytes`. */
  putStream(key: string, source: Readable, options: { maxBytes: number; contentLength?: number }): Promise<{ bytes: number; sha256: string }>;
  delete(key: string): Promise<void>;
  /** Remove todos os objetos sob um prefixo de import/release (limpeza de órfãos). */
  deletePrefix(prefix: string): Promise<void>;
  /** Lista objetos sob um prefixo `vsl/...` (GC). Opcional: sem ele o GC só usa o banco. */
  list?(prefix: string, limit?: number): Promise<StoredObject[]>;
}
export interface StoredObject { key: string; lastModified: Date }
export class VslUploadTooLarge extends Error {
  readonly code = 'VSL_UPLOAD_TOO_LARGE';
}
/** Prefixos apagáveis: só fontes de import e releases (nunca a raiz do namespace). */
export function assertDeletablePrefix(prefix: string): string {
  const clean = safePath(prefix.replace(/\/+$/, ''));
  if (!/^vsl\/(?:releases|sources)\/[0-9a-z-]+\/[0-9a-z-]+(?:\/[0-9a-z-]+)?$/.test(clean)) throw new Error('Invalid VSL cleanup prefix');
  return clean;
}
function meter(maxBytes: number) {
  const hash = createHash('sha256');
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new VslUploadTooLarge('Upload exceeds size limit'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { transform, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}
export interface Asset {
  storageKey: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}
export interface Manifest {
  version: 1;
  entryPath: string;
  files: Record<string, Asset>;
}
export function validateManifest(manifest: Manifest): void {
  if (
    manifest.version !== 1 ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    !Object.hasOwn(manifest.files, manifest.entryPath) ||
    manifest.files[manifest.entryPath]?.mimeType !== 'text/html'
  )
    throw new Error('Invalid VSL manifest entry');
  const files = Object.entries(manifest.files);
  if (!files.length || files.length > 2000) throw new Error('Invalid VSL manifest count');
  let bytes = 0;
  for (const [name, asset] of files) {
    if (
      safePath(name) !== name ||
      asset.storageKey !== name ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !/^[a-z]+\/[a-z0-9.+-]+$/.test(asset.mimeType)
    )
      throw new Error('Invalid VSL manifest object');
    bytes += asset.bytes;
  }
  if (bytes > 300 * 1024 ** 2) throw new Error('Invalid VSL manifest size');
}
export class LocalVslStorage implements VslObjectStore {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('VSL storage root must be absolute');
  }
  private async resolve(key: string, create = false): Promise<string> {
    key = safePath(key);
    if (!key.startsWith('vsl/')) throw new Error('VSL namespace required');
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Symlink storage root');
    const root = await realpath(this.root);
    const parts = key.split('/');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (create)
        await mkdir(current).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory');
    }
    return path.join(current, parts[parts.length - 1]!);
  }
  async putExclusive(key: string, bytes: Buffer): Promise<void> {
    const release = key.match(/^(vsl\/releases\/[0-9a-f-]+\/[0-9a-f-]+)\//)?.[1];
    if (
      release &&
      (await this.read(`${release}/.sealed`).then(
        () => true,
        (e) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        }
      ))
    )
      throw new Error('Release is sealed');
    const file = await open(
      await this.resolve(key, true),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async putStream(key: string, source: Readable, options: { maxBytes: number; contentLength?: number }) {
    const target = await this.resolve(key, true);
    const counter = meter(options.maxBytes);
    try {
      await pipeline(source, counter.transform,
        // Node aceita flags numéricas (O_NOFOLLOW/O_EXCL); a tipagem só declara string.
        createWriteStream(target, { flags: (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW) as unknown as string, mode: 0o600 }));
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') await rm(target, { force: true });
      throw error;
    }
    const result = counter.result();
    if (options.contentLength !== undefined && result.bytes !== options.contentLength) {
      await rm(target, { force: true });
      throw new Error('Upload size does not match Content-Length');
    }
    return result;
  }
  async delete(key: string): Promise<void> {
    await rm(await this.resolve(key).catch(() => ''), { force: true }).catch(() => undefined);
  }
  async deletePrefix(prefix: string): Promise<void> {
    const clean = assertDeletablePrefix(prefix);
    const root = await realpath(this.root).catch(() => '');
    if (!root) return;
    const target = path.join(root, clean);
    if (!target.startsWith(`${root}/vsl/`)) throw new Error('Invalid VSL cleanup prefix');
    await rm(target, { recursive: true, force: true });
  }
  async list(prefix: string, limit = 100_000): Promise<StoredObject[]> {
    const clean = safePath(prefix.replace(/\/+$/, ''));
    if (!clean.startsWith('vsl/')) throw new Error('VSL namespace required');
    const root = await realpath(this.root).catch(() => '');
    if (!root) return [];
    const out: StoredObject[] = [];
    const walk = async (dir: string, key: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(full, `${key}/${entry.name}`);
        else if (entry.isFile()) out.push({ key: `${key}/${entry.name}`, lastModified: (await lstat(full)).mtime });
      }
    };
    await walk(path.join(root, clean), clean);
    return out;
  }
  async read(key: string): Promise<Buffer> {
    const file = await open(await this.resolve(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Not an asset');
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async seal(prefix: string, manifest: Manifest): Promise<void> {
    validateManifest(manifest);
    safePath(prefix);
    if (!/^vsl\/releases\/[0-9a-f-]+\/[0-9a-f-]+$/.test(prefix))
      throw new Error('Invalid release prefix');
    for (const asset of Object.values(manifest.files)) {
      const bytes = await this.read(`${prefix}/${asset.storageKey}`);
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
        throw new Error('Release verification failed');
    }
    const bytes = Buffer.from(stableJson(manifest));
    await this.putExclusive(`${prefix}/manifest.json`, bytes);
    await this.putExclusive(`${prefix}/.sealed`, Buffer.from(digest(bytes)));
  }
  async removeAttempt(importId: string, attemptId: string): Promise<void> {
    if (![importId, attemptId].every((id) => /^[0-9a-f-]{36}$/.test(id)))
      throw new Error('Invalid attempt identity');
    const key = `vsl/quarantine/${importId}/attempts/${attemptId}/marker`;
    const target = path.dirname(
      await this.resolve(key).catch((e) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      })
    );
    if (target !== '.' && target.startsWith(`${await realpath(this.root)}/vsl/quarantine/`))
      await rm(target, { recursive: true, force: true });
  }
  async isSealed(prefix: string, manifest: Manifest): Promise<boolean> {
    try {
      validateManifest(manifest);
      return (await this.read(`${prefix}/.sealed`)).toString() === digest(stableJson(manifest));
    } catch {
      return false;
    }
  }
}

export class R2VslStorage implements VslObjectStore {
  private readonly client: R2Client;
  constructor(readonly config: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
    if (!/^[0-9a-f]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKeyId || !config.secretAccessKey) throw new Error('Invalid dedicated VSL R2 configuration');
    this.client = new S3Client({ region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }) as unknown as R2Client;
  }
  private key(value: string): string {
    const key = safePath(value);
    if (!key.startsWith('vsl/')) throw new Error('VSL namespace required');
    return key;
  }
  async putExclusive(key: string, bytes: Buffer): Promise<void> {
    key = this.key(key);
    const release = key.match(/^(vsl\/releases\/[0-9a-f-]+\/[0-9a-f-]+)\//)?.[1];
    if (release && await this.read(`${release}/.sealed`).then(() => true, (error: { code?: string }) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error('Release is sealed');
    await this.client.send<unknown>(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, IfNoneMatch: '*' }));
  }
  async putStream(key: string, source: Readable, options: { maxBytes: number; contentLength?: number }) {
    key = this.key(key);
    // R2/S3 exige tamanho conhecido para corpo em stream: sem Content-Length, não há upload em stream.
    if (options.contentLength === undefined || !Number.isSafeInteger(options.contentLength) || options.contentLength <= 0)
      throw new Error('Content-Length required for streamed VSL upload');
    if (options.contentLength > options.maxBytes) throw new VslUploadTooLarge('Upload exceeds size limit');
    const counter = meter(options.maxBytes);
    const body = source.pipe(counter.transform);
    source.once('error', (error) => body.destroy(error));
    await this.client.send<unknown>(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body,
      ContentLength: options.contentLength, IfNoneMatch: '*' }));
    const result = counter.result();
    if (result.bytes !== options.contentLength) {
      await this.delete(key);
      throw new Error('Upload size does not match Content-Length');
    }
    return result;
  }
  async delete(key: string): Promise<void> {
    await this.client.send<unknown>(new DeleteObjectsCommand({ Bucket: this.config.bucket,
      Delete: { Objects: [{ Key: this.key(key) }], Quiet: true } }));
  }
  async deletePrefix(prefix: string): Promise<void> {
    const clean = `${assertDeletablePrefix(prefix)}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send<ListObjectsV2CommandOutput>(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: clean, ContinuationToken: continuationToken }));
      const keys = (listed.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key?.startsWith(clean)));
      if (keys.length) await this.client.send<unknown>(new DeleteObjectsCommand({ Bucket: this.config.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  async list(prefix: string, limit = 100_000): Promise<StoredObject[]> {
    const clean = `${this.key(prefix.replace(/\/+$/, ''))}/`;
    const out: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send<ListObjectsV2CommandOutput>(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: clean, ContinuationToken: continuationToken }));
      for (const item of listed.Contents ?? [])
        if (item.Key?.startsWith(clean) && out.length < limit) out.push({ key: item.Key, lastModified: item.LastModified ?? new Date() });
      continuationToken = listed.IsTruncated && out.length < limit ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
  async read(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send<GetObjectCommandOutput>(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }));
      if (!response.Body) throw new Error('Empty R2 object');
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') throw Object.assign(new Error('VSL object not found'), { code: 'ENOENT' });
      throw error;
    }
  }
  async seal(prefix: string, manifest: Manifest): Promise<void> {
    validateManifest(manifest);
    if (!/^vsl\/releases\/[0-9a-f-]+\/[0-9a-f-]+$/.test(prefix)) throw new Error('Invalid release prefix');
    for (const asset of Object.values(manifest.files)) {
      const bytes = await this.read(`${prefix}/${asset.storageKey}`);
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error('Release verification failed');
    }
    const bytes = Buffer.from(stableJson(manifest));
    await this.putExclusive(`${prefix}/manifest.json`, bytes);
    await this.putExclusive(`${prefix}/.sealed`, Buffer.from(digest(bytes)));
  }
  async isSealed(prefix: string, manifest: Manifest): Promise<boolean> {
    try { validateManifest(manifest); return (await this.read(`${prefix}/.sealed`)).toString() === digest(stableJson(manifest)); }
    catch { return false; }
  }
  async removeAttempt(importId: string, attemptId: string): Promise<void> {
    if (![importId, attemptId].every((id) => /^[0-9a-f-]{36}$/.test(id))) throw new Error('Invalid attempt identity');
    const prefix = `vsl/quarantine/${importId}/attempts/${attemptId}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send<ListObjectsV2CommandOutput>(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      const keys = (listed.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key?.startsWith(prefix)));
      if (keys.length) await this.client.send<unknown>(new DeleteObjectsCommand({ Bucket: this.config.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

/** Private local disk is for development/test; production requires dedicated R2 credentials. */
export function vslStorageFromEnv(env: NodeJS.ProcessEnv = process.env): VslObjectStore {
  if (env['VSL_STORAGE_ADAPTER'] === 'r2')
    return new R2VslStorage({ accountId: env['VSL_R2_ACCOUNT_ID'] ?? '', bucket: env['VSL_R2_BUCKET'] ?? '',
      accessKeyId: env['VSL_R2_ACCESS_KEY_ID'] ?? '', secretAccessKey: env['VSL_R2_SECRET_ACCESS_KEY'] ?? '' });
  if (env['NODE_ENV'] === 'production') throw new Error('VSL dedicated R2 storage adapter is required in production');
  if (env['VSL_STORAGE_ADAPTER'] && env['VSL_STORAGE_ADAPTER'] !== 'local')
    throw new Error('Unsupported VSL storage adapter');
  const root = env['VSL_PREVIEW_STORAGE_ROOT'];
  if (!root) throw new Error('VSL private storage root required');
  return new LocalVslStorage(root);
}
