/**
 * In-process scheduler. Checks every 10 minutes which jobs are due, based on the last
 * successful run recorded in job_runs, so a restart never skips or doubles a job.
 *
 *   nightly  (dealsHourUtc):  deals sync per city → advert↔deal matching per city
 *   daily    (backupHourUtc): database backup
 *   weekly   (gtfsDay):       GTFS stops and peak frequencies
 *   weekly   (renewalDay):    renewal complexes and plans per city
 *   monthly  (cbsDayOfMonth): CBS district price index
 *
 * A failing source is recorded and retried at the next tick after 6 hours, without blocking
 * the other jobs.
 */
import type { Database } from "bun:sqlite";
import type { SourcesConfig } from "./config";
import { lastRun } from "./db";
import { backup, rematch, runJob, syncCbs, syncDeals, syncGtfs, syncRenewal } from "./jobs";

const H = 3_600_000;

export function isDue(
  last: string | null,
  now: Date,
  rule: { everyHours: number; atHourUtc?: number; weekday?: number; dayOfMonth?: number },
): boolean {
  if (rule.weekday !== undefined && now.getUTCDay() !== rule.weekday) return false;
  if (rule.dayOfMonth !== undefined && now.getUTCDate() < rule.dayOfMonth) return false;
  if (rule.atHourUtc !== undefined && now.getUTCHours() < rule.atHourUtc) return false;
  if (!last) return true;
  return now.getTime() - Date.parse(last) >= rule.everyHours * H - 30 * 60_000;
}

function recentlyFailed(db: Database, job: string, scope: string, now: Date): boolean {
  const any = lastRun(db, job, scope, false);
  return !!any && !any.ok && now.getTime() - Date.parse(any.started_at) < 6 * H;
}

export async function tick(db: Database, cfg: SourcesConfig, now = new Date(), log = console.log) {
  const s = cfg.schedule;
  const due = (job: string, scope: string, rule: Parameters<typeof isDue>[2]) =>
    isDue(lastRun(db, job, scope)?.started_at ?? null, now, rule) && !recentlyFailed(db, job, scope, now);
  const attempt = async (job: string, scope: string, fn: () => Promise<unknown> | unknown) => {
    try {
      const r = await runJob(db, job, scope, fn as () => Promise<unknown>);
      log(`[jobs] ${job}:${scope} ok`, r);
    } catch (e) {
      log(`[jobs] ${job}:${scope} FAILED`, (e as Error).message);
    }
  };

  for (const c of cfg.cities) {
    if (due("deals", c.name, { everyHours: 24, atHourUtc: s.dealsHourUtc })) {
      await attempt("deals", c.name, () => syncDeals(db, c));
      const since = new Date(now.getTime() - 730 * 24 * H).toISOString().slice(0, 10);
      await attempt("match", c.name, () => rematch(db, c, since));
    }
    if (due("renewal", c.name, { everyHours: 24 * 7, weekday: s.renewalDay })) {
      await attempt("renewal", c.name, () => syncRenewal(db, c, cfg.layers));
    }
  }
  if (due("gtfs", "*", { everyHours: 24 * 7, weekday: s.gtfsDay })) await attempt("gtfs", "*", () => syncGtfs(db, cfg.gtfsUrl));
  if (cfg.cities.length && due("cbs", "*", { everyHours: 24 * 27, dayOfMonth: s.cbsDayOfMonth })) {
    await attempt("cbs", "*", () => syncCbs(db, cfg.cities.map((c) => c.district), cfg.cbs.codes));
  }
  if (due("backup", "*", { everyHours: 24, atHourUtc: s.backupHourUtc })) await attempt("backup", "*", () => backup(db));
}

export function startScheduler(db: Database, cfg: SourcesConfig, everyMs = 10 * 60_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(db, cfg); } finally { running = false; }
  };
  setTimeout(run, 5_000);
  return setInterval(run, everyMs);
}
