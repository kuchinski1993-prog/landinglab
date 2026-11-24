// Analytics G3 por etapa com filtro de período. Fonte: vsl_events (marcos, 1 linha por sessão/evento)
// e vsl_watch_sessions (tempo assistido). WatchProgress em vsl_events é ignorado (legado do runtime).
import type { Sql } from 'postgres';

import { vslError } from './errors.js';

export const ANALYTICS_DEFAULT_DAYS = 30;
export const ANALYTICS_MAX_DAYS = 366;

export function analyticsPeriod(input: { from?: string; to?: string }, now = new Date()): { from: Date; to: Date } {
  const parse = (value: string | undefined) => {
    if (value === undefined || value === '') return undefined;
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(date.getTime())) throw vslError('invalid_period');
    return date;
  };
  const to = parse(input.to) ?? now;
  const from = parse(input.from) ?? new Date(to.getTime() - ANALYTICS_DEFAULT_DAYS * 86400000);
  if (from >= to || to.getTime() - from.getTime() > ANALYTICS_MAX_DAYS * 86400000) throw vslError('invalid_period');
  return { from, to };
}

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export async function projectAnalytics(sql: Sql, projectId: string, period: { from: Date; to: Date }) {
  const [project] = await sql`SELECT id,name FROM vsl_projects WHERE id=${projectId} AND store_id='l0i'`;
  if (!project) throw vslError('project_not_found');
  const counts = await sql`WITH video_steps AS (
      SELECT sr.project_release_id, sr.step_id FROM vsl_step_releases sr JOIN vsl_project_releases r ON r.id=sr.project_release_id
      WHERE r.project_id=${projectId} AND sr.video_asset_id IS NOT NULL)
    SELECT e.step_id,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='PageView') AS views,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='PageView' AND v.step_id IS NOT NULL) AS video_views,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='VSLStart') AS plays,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='VSL25') AS r25,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='VSL50') AS r50,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='VSL75') AS r75,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='VSLComplete') AS r100,
      COUNT(DISTINCT e.session_id) FILTER (WHERE e.event_name='CTAVisible') AS cta_reached,
      COUNT(*) FILTER (WHERE e.event_name='CTAClick') AS cta_clicks,
      COUNT(*) FILTER (WHERE e.event_name='CheckoutClick') AS checkout_clicks
    FROM vsl_events e LEFT JOIN video_steps v ON v.project_release_id=e.release_id AND v.step_id=e.step_id
    WHERE e.project_id=${projectId} AND e.received_at>=${period.from} AND e.received_at<${period.to} AND e.event_name<>'WatchProgress'
    GROUP BY e.step_id`;
  // Média de tempo assistido sobre as sessões que deram play (VSLStart) OU têm heartbeat: quem deu play e não
  // chegou ao 1º heartbeat entra com 0 s (antes ficava de fora e inflava a média).
  const watch = await sql`WITH heartbeat AS (
      SELECT step_id, session_id, MAX(watched_seconds) AS seconds, MAX(watched_percentage) AS percentage FROM vsl_watch_sessions
      WHERE project_id=${projectId} AND updated_at>=${period.from} AND updated_at<${period.to} GROUP BY step_id, session_id),
    played AS (
      SELECT DISTINCT step_id, session_id FROM vsl_events
      WHERE project_id=${projectId} AND event_name='VSLStart' AND received_at>=${period.from} AND received_at<${period.to}),
    merged AS (
      SELECT COALESCE(h.step_id,p.step_id) AS step_id, COALESCE(h.seconds,0) AS seconds, COALESCE(h.percentage,0) AS percentage
      FROM heartbeat h FULL JOIN played p ON p.step_id=h.step_id AND p.session_id=h.session_id)
    SELECT step_id, COUNT(*) AS sessions, COALESCE(AVG(seconds),0) AS avg_seconds, COALESCE(AVG(percentage),0) AS avg_percentage
    FROM merged GROUP BY step_id`;
  const [totals] = await sql`SELECT COUNT(DISTINCT session_id) FILTER (WHERE event_name='PageView') AS sessions,
      COUNT(DISTINCT session_id) FILTER (WHERE event_name='CTAVisible') AS cta_reached,
      COUNT(DISTINCT session_id) FILTER (WHERE event_name='CheckoutClick') AS checkout_sessions
    FROM vsl_events WHERE project_id=${projectId} AND received_at>=${period.from} AND received_at<${period.to} AND event_name<>'WatchProgress'`;
  const withData = new Set([...counts, ...watch].map((row) => String(row.step_id)));
  const steps = (await sql`SELECT id,name,type,pathname,status,video_asset_id FROM vsl_steps WHERE project_id=${projectId} ORDER BY status='archived', position`)
    .filter((step) => step.status !== 'archived' || withData.has(String(step.id)));
  const metrics = steps.map((step) => {
    const count = counts.find((row) => row.step_id === step.id);
    const time = watch.find((row) => row.step_id === step.id);
    const n = (key: string) => Number(count?.[key] ?? 0);
    const views = n('views'), plays = n('plays'), videoViews = n('video_views');
    return {
      stepId: String(step.id), name: String(step.name), type: String(step.type), pathname: String(step.pathname),
      archived: step.status === 'archived', hasVideo: Boolean(step.video_asset_id) || videoViews > 0,
      views, videoViews, plays, playRate: rate(plays, videoViews),
      retention: {
        p25: n('r25'), p50: n('r50'), p75: n('r75'), p100: n('r100'),
        rate25: rate(n('r25'), plays), rate50: rate(n('r50'), plays), rate75: rate(n('r75'), plays), rate100: rate(n('r100'), plays),
      },
      ctaReached: n('cta_reached'), ctaReachRate: rate(n('cta_reached'), views),
      ctaClicks: n('cta_clicks'), checkoutClicks: n('checkout_clicks'),
      watchedSessions: Number(time?.sessions ?? 0),
      averageWatchedSeconds: Number(time?.avg_seconds ?? 0),
      averageWatchedPercentage: Number(time?.avg_percentage ?? 0),
    };
  });
  const sum = (pick: (step: (typeof metrics)[number]) => number) => metrics.reduce((total, step) => total + pick(step), 0);
  const watchedSessions = sum((step) => step.watchedSessions);
  return {
    projectId, projectName: String(project.name),
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    totals: {
      sessions: Number(totals?.sessions ?? 0), plays: sum((step) => step.plays), videoViews: sum((step) => step.videoViews),
      playRate: rate(sum((step) => step.plays), sum((step) => step.videoViews)),
      ctaReached: Number(totals?.cta_reached ?? 0), ctaClicks: sum((step) => step.ctaClicks), checkoutClicks: sum((step) => step.checkoutClicks),
      checkoutSessions: Number(totals?.checkout_sessions ?? 0),
      averageWatchedSeconds: watchedSessions ? sum((step) => step.averageWatchedSeconds * step.watchedSessions) / watchedSessions : 0,
    },
    steps: metrics,
  };
}
export type VslProjectAnalytics = Awaited<ReturnType<typeof projectAnalytics>>;
