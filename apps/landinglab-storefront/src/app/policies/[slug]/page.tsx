// Políticas públicas da loja (Story 15.4, AC11).
// /policies/<slug> no host da landing → GET /landing-policies/:slug?host=.
// Draft, pendência, slug ou host desconhecido → 404 (nunca servida).
// `?lp=<uuid>` (links do rodapé do checkout) fixa a landing quando o host tem várias.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import styles from '../../post-sale.module.css';

import { fetchPolicyPage, requestContext, validLandingPageId } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

interface Props {
  params: { slug: string };
  searchParams: { lp?: string | string[] };
}

function load({ params, searchParams }: Props) {
  return fetchPolicyPage(params.slug, requestContext(headers()), validLandingPageId(searchParams.lp));
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const policy = await load(props);
  return { title: policy?.title ?? 'Not found' };
}

export default async function PolicyPage(props: Props): Promise<JSX.Element> {
  const policy = await load(props);
  if (!policy) notFound();
  return (
    <div className={styles.page} lang={policy.locale.slice(0, 2)}>
      <main className={styles.containerWide}>
        <h1 className={styles.title}>{policy.title}</h1>
        {/* HTML renderizado e sanitizado pela API (e de novo em fetchPolicyPage). */}
        <div className={styles.policy} dangerouslySetInnerHTML={{ __html: policy.html }} />
      </main>
    </div>
  );
}
