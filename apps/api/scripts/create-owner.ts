// Cria (ou reativa) o usuário dono do painel — primeiro acesso num banco novo. A senha vem do
// ambiente para não ficar no histórico do shell. Uso (na raiz):
//   OWNER_PASSWORD='senha forte de 12+' pnpm create-owner voce@exemplo.com "Seu Nome"
import postgres from 'postgres';

import { hashPassword, validatePasswordPolicy } from '../src/lib/auth/passwords.js';

async function main(): Promise<void> {
  const [rawEmail, name] = process.argv.slice(2);
  const email = (rawEmail ?? '').trim().toLowerCase();
  const password = process.env['OWNER_PASSWORD'] ?? '';
  if (!email.includes('@')) throw new Error('uso: create-owner <email> [nome] (senha em OWNER_PASSWORD)');
  const policy = validatePasswordPolicy(password, email);
  if (!policy.ok) throw new Error(`senha recusada: ${policy.violations.join(', ')} (mínimo 12 caracteres)`);
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL não definido');

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const passwordHash = await hashPassword(password);
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, name, role, status, password_hash, password_changed_at)
      values (${email}, ${name ?? null}, 'owner', 'active', ${passwordHash}, now())
      on conflict ((lower(email))) do update
        set role = 'owner', status = 'active', password_hash = excluded.password_hash,
            password_changed_at = now(), failed_login_count = 0, locked_until = null
      returning id`;
    console.log(`owner pronto: ${email} (id ${user!.id}) — use este id em ADMIN_USER_IDS`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
