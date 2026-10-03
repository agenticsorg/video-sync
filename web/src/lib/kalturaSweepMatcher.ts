/**
 * ADR-081 §2/§3 — which series, if any, a Kaltura entry belongs to.
 *
 * Isomorphic and pure: the Maintain dry-run and the scheduled sweep
 * both call this, so there is one rule and it is testable without
 * touching Kaltura.
 *
 * ── The problem this replaces ────────────────────────────────────────
 * Kaltura's Zoom connector rewrites entry names with AI-generated
 * titles. "Building Autonomous AI Systems: From MCPs…" is Friday
 * Hackerspace 18 Sep; "Dream Machines and Adaptive Harnesses…" is Live
 * Vibe 13 Aug. The registry's `^.*Hackerspace.*` / `^.*Vibe.*` patterns
 * match 11 of 127 entries, and the one Hackerspace hit kept the word by
 * accident. Title matching is not recoverable here.
 *
 * What is reliable is the connector's `referenceId`, which carries the
 * true recording start. Resolved to the series timezone the shows
 * cluster exactly — 8 Thursdays and 8 Fridays at 11:45–11:50 over four
 * months, both confirmed against catalog ground truth.
 *
 * ── The constraint that shapes it ────────────────────────────────────
 * Private internal meetings share the same Zoom and Kaltura account,
 * in the same time band:
 *
 *     Mon 11:58  Agentics Foundation Committee Meeting
 *     Wed 11:55  Migrating Discord to Talent Marketplace
 *     Thu 11:45  the public show
 *     Fri 11:45  the public show
 *
 * Weekday is the only discriminator. A time-only rule publishes the
 * Committee Meeting to the portal, so `scheduled_days` is mandatory
 * (§3) and there is no inference step anywhere in this module: a
 * series the operator has not explicitly configured is never matched.
 */

import type { SeriesRegistryEntry, DestinationSpec } from "./youtubeTitleAlign";
import { parseZoomReferenceId } from "./kalturaZoomOrigin";

/** Three-letter weekday as `Intl` renders it, e.g. "Thu". */
export type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * How far before the declared show start a recording may begin, and
 * how far after.
 *
 * The recording covers a pre-show: observed starts are 11:45–11:50
 * against a 12:00 declared start, and the operator reports the
 * pre-show is "usually 15 minutes, can be more or less". 30 minutes
 * is double the longest observed.
 *
 * The bound is not arbitrary — it is set by the nearest unrelated
 * recording. On Thursday that is "Website - Agentics" at −64 minutes,
 * so −30 leaves a 34-minute margin. Widening past about −45 would
 * start reaching it.
 */
export const SWEEP_WINDOW_BEFORE_MIN = 30;
export const SWEEP_WINDOW_AFTER_MIN = 15;

/** A Kaltura entry, in the shape /api/kaltura/list returns. */
export interface SweepEntry {
  id: string;
  name: string;
  reference_id: string | null;
  category_ids: string[];
  createdAt: string;
}

export type SkipReason =
  | "no_zoom_reference"
  | "no_eligible_series"
  | "outside_window";

export interface SweepMatch {
  entry: SweepEntry;
  series_name: string;
  /** True recording start, from the connector's referenceId. */
  recorded_at: string;
  /** Local time in the series timezone, for the dry-run report. */
  local: string;
  /** Minutes from the declared show start; negative is the pre-show. */
  offset_minutes: number;
  /** Declared category ids/names still to be applied. */
  missing: string[];
  /** Declared values the entry already has. */
  present: string[];
}

export interface SweepSkip {
  entry: SweepEntry;
  reason: SkipReason;
}

/**
 * Series the sweep may act on.
 *
 * §3 — all of weekday, window, timezone and Kaltura `category_ids`.
 * Anything short of that is skipped, because the cost of a false
 * positive here is a private meeting becoming portal-visible.
 */
export function eligibleSeries(registry: SeriesRegistryEntry[]): SeriesRegistryEntry[] {
  return registry.filter(e => {
    const days = e.scheduled_days ?? [];
    if (days.length === 0) return false;
    if (!days.every(d => WEEKDAYS.includes(d))) return false;
    if (!e.scheduled_start_local || !e.scheduled_timezone) return false;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(e.scheduled_start_local)) return false;
    return declaredCategories(e).length > 0;
  });
}

/** The Kaltura categories a series declares, if any. */
export function declaredCategories(entry: SeriesRegistryEntry): string[] {
  const dests = (entry as SeriesRegistryEntry & { destinations?: DestinationSpec[] }).destinations ?? [];
  const kal = dests.find(d => d.platform === "Kaltura");
  return kal && kal.platform === "Kaltura" ? (kal.category_ids ?? []) : [];
}

/**
 * Weekday and minutes-past-midnight for an instant in a named zone.
 *
 * Uses `Intl` rather than a fixed offset. Every surveyed entry is EDT
 * because the survey spans June–October, but a sweep crossing the
 * November boundary with a hardcoded −4 would be 60 minutes out —
 * which at a 10-minute public/private margin puts Friday's show in
 * Monday's slot.
 */
export function localParts(iso: string, timeZone: string): { weekday: string; minutes: number; label: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "short", hour: "2-digit", minute: "2-digit",
      hour12: false, day: "2-digit", month: "short",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return {
      weekday: String(parts.weekday),
      minutes: hour * 60 + minute,
      label: `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`,
    };
  } catch {
    return null;   // invalid IANA zone
  }
}

function hhmmToMinutes(hhmm: string): number | null {
  const m = hhmm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Match one entry against the eligible series.
 *
 * Returns the match, or the reason it was skipped. There is no
 * fallback to title matching: reintroducing it would reintroduce the
 * failure on an account carrying private meetings.
 */
export function matchEntry(
  entry: SweepEntry,
  eligible: SeriesRegistryEntry[],
): { match: SweepMatch } | { skip: SweepSkip } {
  const origin = parseZoomReferenceId(entry.reference_id);
  if (!origin) {
    // Includes entries this app published, whose referenceId is the
    // catalog uuid (ADR-044). Those are ADR-080's responsibility.
    return { skip: { entry, reason: "no_zoom_reference" } };
  }
  if (eligible.length === 0) return { skip: { entry, reason: "no_eligible_series" } };

  for (const series of eligible) {
    const parts = localParts(origin.recorded_at, series.scheduled_timezone!);
    if (!parts) continue;
    if (!(series.scheduled_days ?? []).includes(parts.weekday)) continue;

    const start = hhmmToMinutes(series.scheduled_start_local!);
    if (start === null) continue;
    const offset = parts.minutes - start;
    if (offset < -SWEEP_WINDOW_BEFORE_MIN || offset > SWEEP_WINDOW_AFTER_MIN) continue;

    const declared = declaredCategories(series);
    const have = new Set(entry.category_ids);
    return {
      match: {
        entry,
        series_name: series.series_name,
        recorded_at: origin.recorded_at,
        local: parts.label,
        offset_minutes: offset,
        missing: declared.filter(d => !have.has(d)),
        present: declared.filter(d => have.has(d)),
      },
    };
  }
  return { skip: { entry, reason: "outside_window" } };
}

export interface SweepPlan {
  matches: SweepMatch[];
  skips: SweepSkip[];
  /** Entries matched but already carrying every declared category. */
  alreadyComplete: number;
  /** categoryEntry.add calls the apply step would make. */
  operations: number;
}

/** The whole plan for a set of entries. Pure — nothing is written. */
export function planSweep(entries: SweepEntry[], registry: SeriesRegistryEntry[]): SweepPlan {
  const eligible = eligibleSeries(registry);
  const matches: SweepMatch[] = [];
  const skips: SweepSkip[] = [];
  for (const e of entries) {
    const r = matchEntry(e, eligible);
    if ("match" in r) matches.push(r.match);
    else skips.push(r.skip);
  }
  return {
    matches,
    skips,
    alreadyComplete: matches.filter(m => m.missing.length === 0).length,
    operations: matches.reduce((n, m) => n + m.missing.length, 0),
  };
}
