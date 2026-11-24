import type { Credential as DbCredential } from '@blackshop/db';

export type CredentialTestStatus = 'ok' | 'error' | null;

export type Credential = DbCredential;
