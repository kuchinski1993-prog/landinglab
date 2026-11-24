export { VaultService } from './vault.js';
export type { CredentialSlot, CredentialGroup } from './vault.js';
export { encrypt, decrypt, mask } from './crypto.js';
export type { EncryptedBlob } from './crypto.js';
export type { ConnectionStatus } from './testers/shopify-admin.tester.js';

export const VAULT_PACKAGE_VERSION = '0.2.0';
