/**
 * YouTube upload quota accounting (ADR-016).
 *
 * Server-only: do not import from client components.
 *
 * Until 2026-09-24 the counter in data/backfill-state.json was
 * incremented in exactly one place — BackfillPanel's orchestrator loop —
 * so it counted *backfill* uploads rather than uploads. Every publish
 * from a card, every side-publish and every retry spent 1,600 units
 * without moving it. On 2026-09-23 four retries burned ~6,400 units and
 * the file still read:
 *
 *     {"uploads_today":0,"last_reset_date":"2026-09-23"}
 *
 * A counter that is silently wrong is worse than no counter, because it
 * invites exactly the decision it was meant to prevent. Counting now
 * happens in /api/youtube/upload — the one choke point every publish
 * path passes through since the downloader consolidation (f6fad14).
 */

import { promises as fs } from "fs";
import { join } from "path";
import { serverLog } from "./serverLogger";

const STATE_FILE = () => join(process.cwd(), "data", "backfill-state.json");

/** A resumable upload costs 1,600 units against a 10,000/day quota. */
export const YOUTUBE_UPLOAD_COST_UNITS = 1600;
export const YOUTUBE_DAILY_QUOTA_UNITS = 10_000;

/** Six. The hard ceiling, distinct from a profile's self-imposed pacing. */
export const YOUTUBE_MAX_UPLOADS_PER_DAY = Math.floor(
  YOUTUBE_DAILY_QUOTA_UNITS / YOUTUBE_UPLOAD_COST_UNITS,
);

export interface QuotaState {
  uploads_today: number;
  last_reset_date: string;
}

export interface QuotaSnapshot extends QuotaState {
  /** Hard API ceiling — NOT the profile's max_uploads_per_day. */
  limit: number;
  remaining: number;
  units_used: number;
}

/**
 * The quota day in Pacific Time.
 *
 * YouTube's Data API quota resets at midnight PT, not UTC. The previous
 * code used a UTC day, so the counter rolled over seven or eight hours
 * early — reporting headroom that the API would still refuse.
 */
export function quotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function read(): Promise<QuotaState> {
  try {
    const raw = await fs.readFile(STATE_FILE(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<QuotaState>;
    return {
      uploads_today: typeof parsed.uploads_today === "number" ? parsed.uploads_today : 0,
      last_reset_date: typeof parsed.last_reset_date === "string" ? parsed.last_reset_date : "",
    };
  } catch {
    // Unlike the catalog, a lost counter is cheap: it self-heals at the
    // next rollover and the worst case is over-reporting headroom for
    // part of one day. Not worth refusing writes over — but it IS worth
    // saying so, because a silent zero here is what hid the problem.
    serverLog("warn", "lib:uploadQuota", "quota-state-unreadable", { assumed: 0 });
    return { uploads_today: 0, last_reset_date: "" };
  }
}

async function write(s: QuotaState): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(STATE_FILE(), JSON.stringify(s), "utf-8");
}

/** Zero the counter when the Pacific day has rolled over. */
function rolled(s: QuotaState, day: string): QuotaState {
  return s.last_reset_date === day ? s : { uploads_today: 0, last_reset_date: day };
}

export function snapshot(s: QuotaState): QuotaSnapshot {
  return {
    ...s,
    limit: YOUTUBE_MAX_UPLOADS_PER_DAY,
    remaining: Math.max(0, YOUTUBE_MAX_UPLOADS_PER_DAY - s.uploads_today),
    units_used: s.uploads_today * YOUTUBE_UPLOAD_COST_UNITS,
  };
}

/** Current state, rolled over and persisted if the day changed. */
export async function readQuota(): Promise<QuotaSnapshot> {
  const s = rolled(await read(), quotaDay());
  await write(s);
  return snapshot(s);
}

/**
 * Count one upload. Called from /api/youtube/upload after YouTube
 * returns a video id, so every publish path is counted exactly once —
 * backfill, card publish, side-publish, and whatever ADR-079's bulk and
 * agent callers end up doing.
 */
export async function recordUpload(): Promise<QuotaSnapshot> {
  const day = quotaDay();
  const s = rolled(await read(), day);
  const next: QuotaState = { uploads_today: s.uploads_today + 1, last_reset_date: day };
  await write(next);
  const snap = snapshot(next);
  serverLog(
    snap.remaining === 0 ? "warn" : "info",
    "lib:uploadQuota",
    "upload-counted",
    { uploads_today: next.uploads_today, limit: snap.limit, remaining: snap.remaining },
  );
  return snap;
}

/** Overwrite the counter — operator correction only. */
export async function setQuota(partial: Partial<QuotaState>): Promise<QuotaSnapshot> {
  const s = rolled(await read(), quotaDay());
  if (typeof partial.uploads_today === "number") s.uploads_today = partial.uploads_today;
  if (partial.last_reset_date) s.last_reset_date = partial.last_reset_date;
  await write(s);
  return snapshot(s);
}
