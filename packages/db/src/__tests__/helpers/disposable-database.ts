// Guarda para testes que fazem DROP SCHEMA public CASCADE: só aceita Postgres
// local descartável. Nunca relaxar — uma URL de produção apagaria o banco.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const FORBIDDEN_MARKERS = ['supabase.co', 'supabase.com', 'pooler'];

export function disposableDatabaseUrlProblem(url: string | undefined): string | null {
  if (!url) return 'URL ausente';
  const lowered = url.toLowerCase();
  const marker = FORBIDDEN_MARKERS.find((m) => lowered.includes(m));
  if (marker) return `URL contém "${marker}"`;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'URL inválida';
  }
  if (!LOCAL_HOSTS.has(host)) return `host "${host}" não é localhost/127.0.0.1`;
  return null;
}

export function assertDisposableDatabaseUrl(url: string | undefined): string {
  const problem = disposableDatabaseUrlProblem(url);
  if (problem) {
    throw new Error(
      `Recusado: teste destrutivo (DROP SCHEMA public CASCADE) exige Postgres local descartável — ${problem}.`
    );
  }
  return url as string;
}
