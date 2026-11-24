// Analytics G3 por etapa e período (Postgres real).
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { analyticsPeriod, projectAnalytics } from '../analytics.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

let db: VslTestDatabase;
beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

describe('analyticsPeriod', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  it('defaults to the last 30 days and accepts dates or ISO timestamps', () => {
    expect(analyticsPeriod({}, now)).toEqual({ from: new Date('2026-09-07T12:00:00Z'), to: now });
    expect(analyticsPeriod({ from: '2026-10-01', to: '2026-10-02T10:00:00Z' }, now).from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
  it('rejects inverted, invalid or too long periods', () => {
    for (const input of [{ from: 'x' }, { from: '2026-10-05', to: '2026-10-01' }, { from: '2024-01-01', to: '2026-01-01' }])
      expect(() => analyticsPeriod(input, now)).toThrow(expect.objectContaining({ code: 'invalid_period' }));
  });
});

describe('projectAnalytics', () => {
  it('computes per-step sessions, play rate, retention, CTA, checkout and watch time within the period', async () => {
    const { sql } = db;
    const [domain] = await sql`INSERT INTO blackshop_domains(hostname) VALUES('a.example.com') RETURNING id`;
    const [project] = await sql`INSERT INTO vsl_projects(name) VALUES('Funil') RETURNING id`;
    const [video] = await sql`INSERT INTO vsl_video_assets(name,status) VALUES('v','ready') RETURNING id`;
    const [vslStep] = await sql`INSERT INTO vsl_steps(project_id,position,name,pathname,video_asset_id) VALUES(${project!.id},0,'VSL','/',${video!.id}) RETURNING id`;
    const [upsell] = await sql`INSERT INTO vsl_steps(project_id,position,name,pathname) VALUES(${project!.id},1,'Upsell','/upsell') RETURNING id`;
    const [release] = await sql`INSERT INTO vsl_project_releases(project_id,version_number,domain_id) VALUES(${project!.id},1,${domain!.id}) RETURNING id`;
    await sql`INSERT INTO vsl_step_releases(project_release_id,step_id,position,name,type,pathname,render_mode,video_asset_id)
      VALUES(${release!.id},${vslStep!.id},0,'VSL','VSL','/','IMPORTED_PAGE',${video!.id}),(${release!.id},${upsell!.id},1,'Upsell','PAGE','/upsell','IMPORTED_PAGE',NULL)`;
    const inside = '2026-10-05T10:00:00Z', outside = '2026-08-01T10:00:00Z';
    const event = (session: string, step: string, name: string, at = inside, cta = '') =>
      sql`INSERT INTO vsl_events(event_id,project_id,step_id,release_id,session_id,event_name,cta_id,event_at,received_at)
        VALUES(${randomUUID()},${project!.id},${step},${release!.id},${session},${name},${cta},${at},${at})`;
    const s = Array.from({ length: 4 }, () => randomUUID());
    for (const session of s) await event(session, vslStep!.id, 'PageView');
    for (const session of s.slice(0, 2)) { await event(session, vslStep!.id, 'VSLStart'); await event(session, vslStep!.id, 'VSL25'); }
    await event(s[0]!, vslStep!.id, 'VSL50');
    await event(s[0]!, vslStep!.id, 'CTAVisible');
    await event(s[0]!, vslStep!.id, 'CTAClick', inside, 'buy');
    await event(s[0]!, vslStep!.id, 'WatchProgress');
    await event(s[0]!, upsell!.id, 'PageView');
    await event(s[0]!, upsell!.id, 'CheckoutClick', inside, 'pay');
    await event(randomUUID(), vslStep!.id, 'PageView', outside);
    await sql`INSERT INTO vsl_watch_sessions(release_id,project_id,step_id,session_id,watched_seconds,watched_percentage,updated_at)
      VALUES(${release!.id},${project!.id},${vslStep!.id},${s[0]!},120,0.5,${inside}),(${release!.id},${project!.id},${vslStep!.id},${s[1]!},60,0.25,${inside}),
            (${release!.id},${project!.id},${vslStep!.id},${randomUUID()},999,1,${outside})`;

    const report = await projectAnalytics(sql, String(project!.id), { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    const [first, second] = report.steps;
    expect(first).toMatchObject({ name: 'VSL', views: 4, videoViews: 4, plays: 2, playRate: 0.5, ctaReached: 1, ctaReachRate: 0.25, ctaClicks: 1,
      retention: { p25: 2, p50: 1, p75: 0, p100: 0, rate25: 1, rate50: 0.5 }, watchedSessions: 2, averageWatchedSeconds: 90, averageWatchedPercentage: 0.375 });
    expect(second).toMatchObject({ name: 'Upsell', views: 1, videoViews: 0, plays: 0, playRate: 0, checkoutClicks: 1, hasVideo: false });
    expect(report.totals).toMatchObject({ sessions: 4, plays: 2, playRate: 0.5, ctaReached: 1, ctaClicks: 1, checkoutClicks: 1, checkoutSessions: 1, averageWatchedSeconds: 90 });
    expect(report.period).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z' });

    await sql`UPDATE vsl_steps SET status='archived',position=1000000000,pathname='/__archived-x' WHERE id=${upsell!.id}`;
    const afterArchive = await projectAnalytics(sql, String(project!.id), { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    expect(afterArchive.steps.map((step) => [step.name, step.archived])).toEqual([['VSL', false], ['Upsell', true]]);
    await expect(projectAnalytics(sql, randomUUID(), { from: new Date(0), to: new Date() })).rejects.toMatchObject({ code: 'project_not_found' });
  });
});
