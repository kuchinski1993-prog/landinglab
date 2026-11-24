// /.well-known/apple-developer-merchantid-domain-association (rewrite no
// middleware) — arquivo de verificação do Apple Pay servido em qualquer
// domínio de landing (Story 15.3). Conteúdo oficial publicado pela Stripe.
export const revalidate = 86400;

const STRIPE_FILE = 'https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association';

export async function GET(): Promise<Response> {
  const res = await fetch(STRIPE_FILE, { next: { revalidate } });
  if (!res.ok) return new Response('not available', { status: 502 });
  return new Response(await res.text(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
  });
}
