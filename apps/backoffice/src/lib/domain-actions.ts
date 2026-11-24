'use server';

// Server actions pra gerenciar landing_domains + landing_domain_bindings.
// Fase 5.D — gerenciador de domínios do LandingLab.

import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  landingDomainBindings,
  landingDomains,
  landingPages,
} from '@blackshop/db/schema-landinglab-core';

import { getDb } from './landing-db';

// ─── Types ──────────────────────────────────────────────────────────────

export type DomainRole =
  | 'active'
  | 'reserve'
  | 'blocked'
  | 'pending_dns'
  | 'disabled';
export type DomainRegistrar = 'spaceship' | 'manual' | 'vercel';

export type DomainActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: 'validation' | 'duplicate' | 'not_found' | 'unknown';
      message: string;
    };

/** Domínio com contagem de landings bindadas — usado no grid. */
export interface DomainSummary {
  id: string;
  domain: string;
  nickname: string | null;
  role: DomainRole;
  registrar: DomainRegistrar | null;
  registrarDomainId: string | null;
  tags: string[];
  notes: string | null;
  expiresAt: string | null;
  dnsVerifiedAt: string | null;
  vercelDomainStatus: string | null;
  createdAt: string;
  /** Quantas landings usam este domínio (via bindings). */
  landingsCount: number;
}

/** Binding com dados agregados da landing. */
export interface DomainBindingRow {
  id: string;
  domainId: string;
  landingPageId: string;
  slug: string;
  isDefaultRoot: boolean;
  landingTitle: string;
  landingStatus: string;
  createdAt: string;
}

// ─── List domains ──────────────────────────────────────────────────────

export interface ListDomainsFilters {
  role?: DomainRole | 'all';
  q?: string;
  tag?: string;
}

export async function listDomains(
  filters: ListDomainsFilters = {},
): Promise<DomainSummary[]> {
  const db = getDb();
  const { role, q, tag } = filters;

  const conditions = [];
  if (role && role !== 'all') conditions.push(eq(landingDomains.role, role));
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    const search = or(
      ilike(landingDomains.domain, term),
      ilike(landingDomains.nickname, term),
    );
    if (search) conditions.push(search);
  }
  if (tag && tag.trim()) {
    // Postgres array contains: tags @> ARRAY[tag]
    conditions.push(sql`${landingDomains.tags} @> ARRAY[${tag}]::text[]`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      nickname: landingDomains.nickname,
      role: landingDomains.role,
      registrar: landingDomains.registrar,
      registrarDomainId: landingDomains.registrarDomainId,
      tags: landingDomains.tags,
      notes: landingDomains.notes,
      expiresAt: landingDomains.expiresAt,
      dnsVerifiedAt: landingDomains.dnsVerifiedAt,
      vercelDomainStatus: landingDomains.vercelDomainStatus,
      createdAt: landingDomains.createdAt,
    })
    .from(landingDomains)
    .where(where)
    .orderBy(desc(landingDomains.createdAt));

  // Story 20.10e — contagem em consulta própria. A subconsulta correlacionada
  // antiga saía sem nome de tabela num select de tabela única ("domain_id" = "id",
  // os dois resolvidos em landing_domain_bindings) e devolvia sempre 0.
  const countByDomain = new Map<string, number>();
  if (rows.length > 0) {
    const counts = await db
      .select({ domainId: landingDomainBindings.domainId, n: count() })
      .from(landingDomainBindings)
      .where(inArray(landingDomainBindings.domainId, rows.map((r) => r.id)))
      .groupBy(landingDomainBindings.domainId);
    for (const c of counts) countByDomain.set(c.domainId, Number(c.n));
  }

  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    nickname: r.nickname,
    role: (r.role as DomainRole) ?? 'reserve',
    registrar: (r.registrar as DomainRegistrar) ?? null,
    registrarDomainId: r.registrarDomainId,
    tags: r.tags ?? [],
    notes: r.notes,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    dnsVerifiedAt: r.dnsVerifiedAt ? r.dnsVerifiedAt.toISOString() : null,
    vercelDomainStatus: r.vercelDomainStatus,
    createdAt: r.createdAt.toISOString(),
    landingsCount: countByDomain.get(r.id) ?? 0,
  }));
}

// ─── Get single domain (com bindings expandidos) ────────────────────────

export async function getDomain(id: string): Promise<{
  domain: DomainSummary;
  bindings: DomainBindingRow[];
} | null> {
  const db = getDb();

  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      nickname: landingDomains.nickname,
      role: landingDomains.role,
      registrar: landingDomains.registrar,
      registrarDomainId: landingDomains.registrarDomainId,
      tags: landingDomains.tags,
      notes: landingDomains.notes,
      expiresAt: landingDomains.expiresAt,
      dnsVerifiedAt: landingDomains.dnsVerifiedAt,
      vercelDomainStatus: landingDomains.vercelDomainStatus,
      createdAt: landingDomains.createdAt,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const bindingRows = await db
    .select({
      id: landingDomainBindings.id,
      domainId: landingDomainBindings.domainId,
      landingPageId: landingDomainBindings.landingPageId,
      slug: landingDomainBindings.slug,
      isDefaultRoot: landingDomainBindings.isDefaultRoot,
      landingTitle: landingPages.title,
      landingStatus: landingPages.status,
      createdAt: landingDomainBindings.createdAt,
    })
    .from(landingDomainBindings)
    .innerJoin(
      landingPages,
      eq(landingDomainBindings.landingPageId, landingPages.id),
    )
    .where(eq(landingDomainBindings.domainId, id))
    .orderBy(desc(landingDomainBindings.isDefaultRoot), landingDomainBindings.slug);

  return {
    domain: {
      id: row.id,
      domain: row.domain,
      nickname: row.nickname,
      role: (row.role as DomainRole) ?? 'reserve',
      registrar: (row.registrar as DomainRegistrar) ?? null,
      registrarDomainId: row.registrarDomainId,
      tags: row.tags ?? [],
      notes: row.notes,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      dnsVerifiedAt: row.dnsVerifiedAt ? row.dnsVerifiedAt.toISOString() : null,
      vercelDomainStatus: row.vercelDomainStatus,
      createdAt: row.createdAt.toISOString(),
      landingsCount: bindingRows.length,
    },
    bindings: bindingRows.map((b) => ({
      id: b.id,
      domainId: b.domainId,
      landingPageId: b.landingPageId,
      slug: b.slug,
      isDefaultRoot: b.isDefaultRoot,
      landingTitle: b.landingTitle,
      landingStatus: b.landingStatus,
      createdAt: b.createdAt.toISOString(),
    })),
  };
}

// ─── Add domain manually ────────────────────────────────────────────────
// Usuário compra fora e cadastra o nome aqui.

export interface AddDomainInput {
  domain: string;
  nickname?: string;
  registrar?: DomainRegistrar;
  tags?: string[];
  notes?: string;
  expiresAt?: string; // ISO date
}

const DOMAIN_REGEX =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export async function addDomain(
  input: AddDomainInput,
): Promise<DomainActionResult<{ id: string }>> {
  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain || !DOMAIN_REGEX.test(domain)) {
    return {
      ok: false,
      code: 'validation',
      message:
        'Domínio inválido. Use formato: exemplo.com (sem http://, sem barra final).',
    };
  }

  const db = getDb();

  // Verificar duplicidade explícita pra dar erro amigável (senão bate na
  // unique constraint do banco e vira erro cru).
  const existing = await db
    .select({ id: landingDomains.id })
    .from(landingDomains)
    .where(eq(landingDomains.domain, domain))
    .limit(1);
  if (existing.length > 0) {
    return {
      ok: false,
      code: 'duplicate',
      message: `Domínio "${domain}" já cadastrado.`,
    };
  }

  try {
    const [row] = await db
      .insert(landingDomains)
      .values({
        domain,
        nickname: input.nickname?.trim() || null,
        role: 'reserve', // Reserve = comprado mas sem landing bindada ainda.
        registrar: input.registrar ?? 'manual',
        tags: input.tags ?? [],
        notes: input.notes?.trim() || null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning({ id: landingDomains.id });

    revalidatePath('/landing-pages/domains');
    return { ok: true, data: { id: row!.id } };
  } catch (err) {
    console.error('[domain-actions] addDomain failed', err);
    return {
      ok: false,
      code: 'unknown',
      message: 'Erro ao cadastrar domínio.',
    };
  }
}

// ─── Update domain (nickname, tags, notes, expires) ────────────────────

export interface UpdateDomainInput {
  nickname?: string | null;
  tags?: string[];
  notes?: string | null;
  role?: DomainRole;
}

export async function updateDomain(
  id: string,
  input: UpdateDomainInput,
): Promise<DomainActionResult> {
  const db = getDb();
  try {
    const update: Record<string, unknown> = {};
    if (input.nickname !== undefined)
      update['nickname'] = input.nickname?.trim() || null;
    if (input.tags !== undefined) update['tags'] = input.tags;
    if (input.notes !== undefined)
      update['notes'] = input.notes?.trim() || null;
    if (input.role !== undefined) update['role'] = input.role;

    if (Object.keys(update).length === 0) {
      return { ok: true, data: undefined };
    }

    await db
      .update(landingDomains)
      .set(update)
      .where(eq(landingDomains.id, id));

    revalidatePath('/landing-pages/domains');
    revalidatePath(`/landing-pages/domains/${id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    console.error('[domain-actions] updateDomain failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao atualizar domínio.' };
  }
}

// ─── Delete domain ──────────────────────────────────────────────────────

export async function deleteDomain(id: string): Promise<DomainActionResult> {
  const db = getDb();
  try {
    // Verifica se tem bindings — bloqueia delete se sim (senão landings
    // publicadas ficam órfãs).
    const [{ n }] = await db
      .select({ n: count() })
      .from(landingDomainBindings)
      .where(eq(landingDomainBindings.domainId, id));

    if (n > 0) {
      return {
        ok: false,
        code: 'validation',
        message: `Domínio tem ${n} landing${n > 1 ? 's' : ''} publicada${n > 1 ? 's' : ''}. Remova os vínculos primeiro.`,
      };
    }

    await db.delete(landingDomains).where(eq(landingDomains.id, id));
    revalidatePath('/landing-pages/domains');
    return { ok: true, data: undefined };
  } catch (err) {
    console.error('[domain-actions] deleteDomain failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao remover domínio.' };
  }
}

// ─── Bind landing to domain ─────────────────────────────────────────────

export interface CreateBindingInput {
  domainId: string;
  landingPageId: string;
  slug?: string;
  isDefaultRoot?: boolean;
}

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Gera slug a partir do título da landing, garante unicidade dentro do domínio
 * adicionando sufixo -N em caso de colisão.
 */
async function generateUniqueSlug(
  domainId: string,
  baseTitle: string,
): Promise<string> {
  const db = getDb();
  const base =
    baseTitle
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'landing';

  const existing = await db
    .select({ slug: landingDomainBindings.slug })
    .from(landingDomainBindings)
    .where(eq(landingDomainBindings.domainId, domainId));

  const taken = new Set(existing.map((e) => e.slug));
  if (!taken.has(base)) return base;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createBinding(
  input: CreateBindingInput,
): Promise<DomainActionResult<{ id: string; slug: string }>> {
  const db = getDb();

  let slug = (input.slug ?? '').trim();

  // Se slug vazio E is_default_root, mantém vazio (root binding).
  // Se slug vazio E não é root, auto-gera.
  if (!slug && !input.isDefaultRoot) {
    // Busca título da landing pra gerar slug.
    const [landing] = await db
      .select({ title: landingPages.title })
      .from(landingPages)
      .where(eq(landingPages.id, input.landingPageId))
      .limit(1);
    if (!landing) {
      return { ok: false, code: 'not_found', message: 'Landing não encontrada.' };
    }
    slug = await generateUniqueSlug(input.domainId, landing.title);
  }

  if (slug && !SLUG_REGEX.test(slug)) {
    return {
      ok: false,
      code: 'validation',
      message: 'Slug deve conter apenas letras minúsculas, números e hífens.',
    };
  }

  try {
    const [row] = await db
      .insert(landingDomainBindings)
      .values({
        domainId: input.domainId,
        landingPageId: input.landingPageId,
        slug,
        isDefaultRoot: input.isDefaultRoot ?? false,
      })
      .returning({ id: landingDomainBindings.id, slug: landingDomainBindings.slug });

    revalidatePath('/landing-pages/domains');
    revalidatePath(`/landing-pages/domains/${input.domainId}`);
    revalidatePath(`/landing-pages/${input.landingPageId}`);
    return { ok: true, data: { id: row!.id, slug: row!.slug } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('idx_landing_domain_bindings_default_root')) {
      return {
        ok: false,
        code: 'duplicate',
        message:
          'Este domínio já tem uma landing marcada como página inicial. Remova o vínculo anterior primeiro.',
      };
    }
    if (message.includes('idx_landing_domain_bindings_domain_slug')) {
      return {
        ok: false,
        code: 'duplicate',
        message: `Slug "${slug}" já usado neste domínio. Escolha outro.`,
      };
    }
    console.error('[domain-actions] createBinding failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao criar vínculo.' };
  }
}

export async function deleteBinding(id: string): Promise<DomainActionResult> {
  const db = getDb();
  try {
    // Buscar antes pra saber quais paths revalidar.
    const [row] = await db
      .select({
        domainId: landingDomainBindings.domainId,
        landingPageId: landingDomainBindings.landingPageId,
      })
      .from(landingDomainBindings)
      .where(eq(landingDomainBindings.id, id))
      .limit(1);
    if (!row) {
      return { ok: false, code: 'not_found', message: 'Vínculo não encontrado.' };
    }

    await db.delete(landingDomainBindings).where(eq(landingDomainBindings.id, id));

    revalidatePath('/landing-pages/domains');
    revalidatePath(`/landing-pages/domains/${row.domainId}`);
    revalidatePath(`/landing-pages/${row.landingPageId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    console.error('[domain-actions] deleteBinding failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao remover vínculo.' };
  }
}

// ─── List available landings (pra dropdown do binding) ─────────────────
// Retorna landings elegíveis pra ser bindadas a um domínio (todas exceto
// as que já usam esse domínio — evita bindings duplicados).

export async function listBindableLandings(
  domainId: string,
): Promise<Array<{ id: string; title: string; slug: string; status: string }>> {
  const db = getDb();
  // Landings que JÁ têm binding neste domínio.
  const bound = await db
    .select({ id: landingDomainBindings.landingPageId })
    .from(landingDomainBindings)
    .where(eq(landingDomainBindings.domainId, domainId));
  const boundIds = new Set(bound.map((b) => b.id));

  const all = await db
    .select({
      id: landingPages.id,
      title: landingPages.title,
      slug: landingPages.slug,
      status: landingPages.status,
    })
    .from(landingPages)
    .orderBy(desc(landingPages.createdAt))
    .limit(100);

  return all.filter((l) => !boundIds.has(l.id));
}

// ─── Get all tags in use (pra facetted filter) ─────────────────────────

export async function listUsedTags(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ tags: landingDomains.tags })
    .from(landingDomains)
    .where(sql`array_length(${landingDomains.tags}, 1) > 0`);
  const set = new Set<string>();
  for (const r of rows) for (const t of r.tags ?? []) set.add(t);
  return Array.from(set).sort();
}
