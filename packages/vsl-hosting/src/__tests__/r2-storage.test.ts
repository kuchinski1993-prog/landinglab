import { randomUUID } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { digest, R2VslStorage, vslStorageFromEnv, type Manifest } from '../storage.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('dedicated VSL R2 storage', () => {
  it('requires dedicated credentials in production', () => {
    expect(() => vslStorageFromEnv({ NODE_ENV: 'production', VSL_PREVIEW_STORAGE_ROOT: '/tmp/local' })).toThrow();
    expect(vslStorageFromEnv({ NODE_ENV: 'production', VSL_STORAGE_ADAPTER: 'r2',
      VSL_R2_ACCOUNT_ID: 'a'.repeat(32), VSL_R2_BUCKET: 'vsl-qa',
      VSL_R2_ACCESS_KEY_ID: 'access', VSL_R2_SECRET_ACCESS_KEY: 'secret',
    })).toBeInstanceOf(R2VslStorage);
  });

  it('writes immutable release objects and verifies the seal', async () => {
    const objects = new Map<string, Buffer>();
    const calls: PutObjectCommand[] = [];
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        const data = objects.get(command.input.Key!);
        if (!data) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(data) } } as never;
      }
      if (command instanceof PutObjectCommand) {
        calls.push(command);
        if (objects.has(command.input.Key!)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        return {} as never;
      }
      throw new Error('Unexpected S3 command');
    });
    const storage = new R2VslStorage({ accountId: 'a'.repeat(32), bucket: 'vsl-qa', accessKeyId: 'access', secretAccessKey: 'secret' });
    const prefix = `vsl/releases/${randomUUID()}/${randomUUID()}`;
    const html = Buffer.from('<html><body>Quiz</body></html>');
    const manifest: Manifest = { version: 1, entryPath: 'index.html', files: {
      'index.html': { storageKey: 'index.html', mimeType: 'text/html', bytes: html.length, sha256: digest(html) },
    } };
    await storage.putExclusive(`${prefix}/index.html`, html);
    await storage.seal(prefix, manifest);
    expect(await storage.isSealed(prefix, manifest)).toBe(true);
    expect(calls.every((command) => command.input.IfNoneMatch === '*')).toBe(true);
    await expect(storage.putExclusive(`${prefix}/extra.js`, Buffer.from('x'))).rejects.toThrow('sealed');
  });
});
