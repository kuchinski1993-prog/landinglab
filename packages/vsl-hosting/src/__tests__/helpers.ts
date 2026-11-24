import { deflateRawSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { crc32 } from '../archive.js';
import { SafeFetchError, type SafeFetcher } from '../safe-fetch.js';
export interface ZipEntry {
  name: string;
  bytes: Buffer;
  mode?: number;
  flags?: number;
  declaredSize?: number;
  compress?: boolean;
}
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name),
      data = e.compress ? deflateRawSync(e.bytes) : e.bytes,
      crc = crc32(e.bytes),
      local = Buffer.alloc(30),
      dir = Buffer.alloc(46),
      method = e.compress ? 8 : 0;
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 2048, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.declaredSize ?? e.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(0x0314, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(e.flags ?? 2048, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(e.declaredSize ?? e.bytes.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((e.mode ?? 0x81a4) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export async function fixtureEntries(root: string, prefix = ''): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await fixtureEntries(path.join(root, item.name), name)));
    else out.push({ name, bytes: await readFile(path.join(root, item.name)) });
  }
  return out;
}

// Import inteligente: binários mínimos válidos e fetcher falso (sem rede nos testes).
export function woff2(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write('wOF2', 0);
  bytes.writeUInt32BE(48, 8);
  bytes.writeUInt16BE(1, 12);
  return bytes;
}
export function webp(): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(16, 4);
  bytes.write('WEBP', 8);
  bytes.write('VP8 ', 12);
  return bytes;
}

export type Resource = { contentType: string; body: Buffer | string; status?: number; redirect?: string };
/** Fetcher falso: mapa URL → resposta; registra as URLs pedidas. */
export function fakeFetcher(resources: Record<string, Resource>): SafeFetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher = (async (raw: string) => {
    requested.push(raw);
    const url = new URL(raw);
    const hit = resources[raw] ?? resources[url.href];
    if (!hit) throw new SafeFetchError('http_status', 404);
    if (hit.status && hit.status !== 200) throw new SafeFetchError(hit.status === 403 ? 'private_address' : 'http_status', hit.status);
    return { url: new URL(hit.redirect ?? url.href), status: 200, contentType: hit.contentType, bytes: Buffer.from(hit.body) };
  }) as unknown as SafeFetcher & { requested: string[] };
  fetcher.requested = requested;
  return fetcher;
}

