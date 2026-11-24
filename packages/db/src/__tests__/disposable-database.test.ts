import { describe, expect, it } from 'vitest';

import {
  assertDisposableDatabaseUrl,
  disposableDatabaseUrlProblem,
} from './helpers/disposable-database.js';

describe('disposable database guard', () => {
  it('accepts local disposable URLs', () => {
    expect(disposableDatabaseUrlProblem('postgresql://will@127.0.0.1:55436/postgres')).toBeNull();
    expect(disposableDatabaseUrlProblem('postgres://u:p@localhost:5432/test')).toBeNull();
  });

  it('rejects remote, Supabase and pooler URLs', () => {
    expect(disposableDatabaseUrlProblem(undefined)).toMatch(/ausente/);
    expect(disposableDatabaseUrlProblem('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toMatch(/supabase\.co/);
    expect(
      disposableDatabaseUrlProblem('postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres')
    ).toMatch(/supabase|pooler/);
    expect(disposableDatabaseUrlProblem('postgresql://u:p@127.0.0.1:6543/pooler')).toMatch(/pooler/);
    expect(disposableDatabaseUrlProblem('postgresql://u:p@10.0.0.5:5432/db')).toMatch(/não é localhost/);
    expect(disposableDatabaseUrlProblem('not a url')).toMatch(/inválida/);
    expect(() => assertDisposableDatabaseUrl('postgresql://u:p@db.example.com/db')).toThrow(/Recusado/);
  });
});
