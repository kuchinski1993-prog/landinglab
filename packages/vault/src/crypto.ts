import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from 'node:crypto';
import { promisify } from 'node:util';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';
const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

const pbkdf2Async = promisify(pbkdf2);

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  salt: Buffer;
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Async(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

export async function encrypt(plaintext: string, secret: string): Promise<EncryptedBlob> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(secret, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return { ciphertext, iv, salt };
}

export async function decrypt(
  ciphertext: Buffer,
  iv: Buffer,
  salt: Buffer,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret, salt);
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function mask(value: string): string {
  if (value.length <= 4) return '••••';
  const visible = value.slice(-4);
  return `${'•'.repeat(8)}${visible}`;
}
