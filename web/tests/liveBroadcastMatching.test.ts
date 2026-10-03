/**
 * ADR-048 §Addendum — a livestream's recorded_at was the wrong instant.
 *
 * Every gate in siblingMatcher is date-proximity, so a YouTube record
 * carrying `publishedAt` (when the VOD appeared, after the broadcast
 * ENDED) is never considered against the Zoom recording it came from.
 *
 * Measured on the live catalog, 2026-10-03:
 *   - 30 of 78 YouTube records have no upstream link, 12 on Fridays
 *   - deltas to a same-day Zoom record: 614, 433 and 784 minutes,
 *     all far outside BROADCAST_MAX_DELTA_MIN (60)
 *   - actual_start_time was captured on 0 of 78
 *
 * Operator notes that shape the expected delta: the Zoom recording
 * starts at the top of the pre-show (~11:45) while the livestream
 * starts near the scheduled time (~12:00), and the pre-show length
 * varies. Some sessions relay Zoom -> Restream -> YouTube, adding
 * more delay. The offset is therefore one-directional — the
 * broadcast starts AFTER the recording — and tens of minutes wide.
 */

import { describe, it, expect } from "vitest";
import { effectiveRecordedAt, rankSiblingCandidates } from "../src/lib/siblingMatcher";
import type { VideoRecordJSON } from "../src/lib/wasm";

function rec(o: Record<string, unknown>): VideoRecordJSON {
  return {
    id: "r", title: "T", source_platform: "Zoom", source_id: "s",
    status: "Published", participants: [], locations: [], upstream_links: [],
    indexed_at: "2026-06-05T00:00:00Z",
    ...o,
  } as unknown as VideoRecordJSON;
}

describe("effectiveRecordedAt", () => {
  it("prefers a livestream's actual start over publishedAt", () => {
    // Record 4b4828dd, verbatim: titled "4 June 2026", publishedAt a
    // day later. The title resolver already handles this; the matcher
    // did not, so the two disagreed about when the event happened.
    const r = rec({
      source_platform: "YouTube",
      recorded_at: "2026-06-05T22:58:30Z",
      metadata_extra: { actual_start_time: "2026-06-05T15:58:00Z" },
    });
    expect(effectiveRecordedAt(r)).toBe("2026-06-05T15:58:00Z");
  });

  it("falls back to the scheduled start when the actual one is absent", () => {
    const r = rec({
      source_platform: "YouTube", recorded_at: "2026-06-05T22:58:30Z",
      metadata_extra: { scheduled_start_time: "2026-06-05T16:00:00Z" },
    });
    expect(effectiveRecordedAt(r)).toBe("2026-06-05T16:00:00Z");
  });

  it("leaves non-livestream records completely alone", () => {
    // Zoom, Fireflies and Kaltura never carry these keys, so their
    // behaviour must be byte-identical to before.
    const r = rec({ recorded_at: "2026-06-05T15:45:13Z" });
    expect(effectiveRecordedAt(r)).toBe("2026-06-05T15:45:13Z");
  });

  it("falls back to indexed_at, then null", () => {
    expect(effectiveRecordedAt(rec({ recorded_at: null }))).toBe("2026-06-05T00:00:00Z");
    expect(effectiveRecordedAt(rec({ recorded_at: null, indexed_at: null }))).toBeNull();
  });
});

describe("the pairing the fix enables", () => {
  const zoom = rec({
    id: "z", source_platform: "Zoom", source_id: "zoom-abc",
    title: "Friday Hackerspace Live Events - 5 Jun 2026",
    // Recording starts at the top of the pre-show.
    recorded_at: "2026-06-05T15:45:13Z",
  });
  const ytBroken = rec({
    id: "y", source_platform: "YouTube", source_id: "youtube-xyz",
    title: "Friday Hackerspace Live Events - 5 Jun 2026",
    tags: ["youtube-live"],
    recorded_at: "2026-06-05T22:58:30Z",   // publishedAt — after the broadcast ended
  });
  const ytFixed = rec({
    ...ytBroken,
    metadata_extra: { actual_start_time: "2026-06-05T16:00:00Z" }, // ~15 min pre-show
  });

  it("the old timestamp put the pair 433 minutes apart", () => {
    const delta = (Date.parse(ytBroken.recorded_at!) - Date.parse(zoom.recorded_at!)) / 60000;
    expect(Math.round(delta)).toBe(433);
    expect(delta).toBeGreaterThan(60);   // outside BROADCAST_MAX_DELTA_MIN
  });

  it("the broadcast start puts it ~15 minutes apart, inside the gate", () => {
    const delta = (Date.parse("2026-06-05T16:00:00Z") - Date.parse(zoom.recorded_at!)) / 60000;
    expect(delta).toBeCloseTo(14.8, 1);
    expect(delta).toBeLessThan(60);
    // One-directional: the broadcast starts AFTER the recording,
    // because the recording covers the pre-show.
    expect(delta).toBeGreaterThan(0);
  });

  it("the broadcast start yields the RIGHT relation", () => {
    const [top] = rankSiblingCandidates(ytFixed, [zoom]);
    expect(top).toBeDefined();
    expect(top.reasons.time_delta_minutes).toBeCloseTo(14.8, 1);
    expect(top.recommendedRelation).toBe("BroadcastedFrom");
  });

  it("same-day publishedAt was surfaced, but with the WRONG relation", () => {
    // Correction to the first reading of this: the pair is NOT
    // invisible when publishedAt lands on the same calendar day.
    // isSameEventDay passes it, so it is offered — but at 433
    // minutes it is outside BROADCAST_MAX_DELTA_MIN, so it
    // degrades to SameEvent and the broadcast provenance is lost.
    const [top] = rankSiblingCandidates(ytBroken, [zoom]);
    expect(top).toBeDefined();
    expect(top.recommendedRelation).toBe("SameEvent");
  });

  it("next-day publishedAt makes the pair invisible entirely", () => {
    // This is the case that genuinely disappears, and the one the
    // live catalog shows: record bd235ea8 is a Thursday show whose
    // VOD published Friday 05:25 UTC. isSameEventDay rejects it
    // before any scoring happens.
    const ytNextDay = rec({ ...(ytBroken as unknown as Record<string, unknown>), recorded_at: "2026-06-06T05:25:11Z" });
    expect(rankSiblingCandidates(ytNextDay, [zoom])).toEqual([]);
  });
});
