/**
 * Sibling-matcher date gating.
 *
 * The rule under test: a linking recommendation is never offered for
 * two recordings from different dates, however strongly their
 * participants and titles agree — with one deliberate exception, a
 * single call whose start and end timestamps straddle midnight UTC.
 */

import { describe, it, expect } from "vitest";
import {
  rankSiblingCandidates,
  isSameEventDay,
  MIDNIGHT_STRADDLE_MAX_DELTA_MIN,
} from "../src/lib/siblingMatcher";
import type { VideoRecordJSON } from "../src/lib/wasm";

/** Two records with identical participants and titles, so the date gate
 *  is the only thing that can separate them. */
const PARTICIPANTS = ["alice@agentics.org", "bob@agentics.org", "carol@agentics.org"];
const TITLE = "Friday Hackerspace — Live Coding Edition";

function makeRecord(overrides: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: "rec-" + Math.random().toString(36).slice(2, 10),
    source_id: "stub-source",
    source_platform: "Zoom",
    title: TITLE,
    description: null,
    duration_seconds: 3600,
    participants: PARTICIPANTS,
    transcript_text: null,
    download_url: "stub://",
    thumbnail_url: null,
    tags: [],
    recorded_at: "2026-06-08T14:00:00Z",
    indexed_at: "2026-06-08T14:00:00Z",
    status: "Discovered",
    locations: [],
    upstream_links: [],
    rejected_links: [],
    metadata_extra: null,
    destination_id: null,
    destination_url: null,
    notes: [],
    ...overrides,
  } as unknown as VideoRecordJSON;
}

/** The target is always Zoom; candidates are Fireflies so the
 *  same-platform exclusion doesn't fire. */
function zoomAt(recordedAt: string | null): VideoRecordJSON {
  return makeRecord({ source_platform: "Zoom", recorded_at: recordedAt });
}
function firefliesAt(recordedAt: string | null): VideoRecordJSON {
  return makeRecord({ source_platform: "Fireflies", recorded_at: recordedAt });
}

function offers(target: VideoRecordJSON, candidate: VideoRecordJSON): boolean {
  return rankSiblingCandidates(target, [target, candidate], 5)
    .some(c => c.video.id === candidate.id);
}

describe("rankSiblingCandidates — never offers a link across dates", () => {
  it("offers a same-day pair recorded hours apart", () => {
    const target = zoomAt("2026-06-08T09:00:00Z");
    const candidate = firefliesAt("2026-06-08T20:00:00Z");
    expect(offers(target, candidate)).toBe(true);
  });

  it("does NOT offer a pair one day apart", () => {
    // 29 hours: inside the old 30-hour plausibility bound, and the
    // false positive that bound allowed through.
    const target = zoomAt("2026-06-08T09:00:00Z");
    const candidate = firefliesAt("2026-06-09T14:00:00Z");
    expect(offers(target, candidate)).toBe(false);
  });

  it("does NOT offer the same recurring meeting a week later", () => {
    // Identical participants, identical title — every signal except
    // the date says "match". The date has to win.
    const target = zoomAt("2026-06-08T14:00:00Z");
    const candidate = firefliesAt("2026-06-15T14:00:00Z");
    expect(offers(target, candidate)).toBe(false);
  });

  it("does NOT offer a pair on consecutive days at the same hour", () => {
    const target = zoomAt("2026-06-08T14:00:00Z");
    const candidate = firefliesAt("2026-06-09T14:00:00Z");
    expect(offers(target, candidate)).toBe(false);
  });

  it("STILL offers one call whose timestamps straddle midnight", () => {
    // Zoom logs the 22:00 start; Fireflies logs the 01:30 end of the
    // same call. Different UTC dates, same event.
    const target = zoomAt("2026-06-08T22:00:00Z");
    const candidate = firefliesAt("2026-06-09T01:30:00Z");
    expect(offers(target, candidate)).toBe(true);
  });

  it("does NOT offer a cross-day pair once the gap outgrows a straddle", () => {
    // 7 hours across midnight is no longer one session.
    const target = zoomAt("2026-06-08T22:00:00Z");
    const candidate = firefliesAt("2026-06-09T05:00:00Z");
    expect(offers(target, candidate)).toBe(false);
  });

  it("still offers a candidate with no recorded date at all", () => {
    // A missing date is not evidence of a different date; the matcher
    // redistributes scoring weight to title and participants instead.
    const target = zoomAt("2026-06-08T14:00:00Z");
    const candidate = firefliesAt(null);
    expect(offers(target, candidate)).toBe(true);
  });

  it("drops a distant candidate while keeping a same-day one", () => {
    const target = zoomAt("2026-06-08T14:00:00Z");
    const sameDay = firefliesAt("2026-06-08T14:05:00Z");
    const weekLater = makeRecord({
      source_platform: "Kaltura",
      recorded_at: "2026-06-15T14:00:00Z",
    });

    const ranked = rankSiblingCandidates(target, [target, sameDay, weekLater], 5);
    expect(ranked.map(c => c.video.id)).toEqual([sameDay.id]);
  });
});

describe("isSameEventDay", () => {
  it("is true for two times on one UTC calendar day", () => {
    expect(isSameEventDay("2026-06-08T00:10:00Z", "2026-06-08T23:50:00Z", 23 * 60 + 40)).toBe(true);
  });

  it("is true across midnight within the straddle window", () => {
    expect(isSameEventDay("2026-06-08T23:00:00Z", "2026-06-09T02:00:00Z", 180)).toBe(true);
  });

  it("admits a gap exactly at the straddle bound", () => {
    expect(
      isSameEventDay("2026-06-08T20:00:00Z", "2026-06-09T02:00:00Z", MIDNIGHT_STRADDLE_MAX_DELTA_MIN),
    ).toBe(true);
  });

  it("rejects a gap one minute past the bound", () => {
    expect(
      isSameEventDay("2026-06-08T20:00:00Z", "2026-06-09T02:01:00Z", MIDNIGHT_STRADDLE_MAX_DELTA_MIN + 1),
    ).toBe(false);
  });

  it("is true when the delta is unknown", () => {
    expect(isSameEventDay(null, "2026-06-08T14:00:00Z", null)).toBe(true);
    expect(isSameEventDay("2026-06-08T14:00:00Z", null, null)).toBe(true);
  });

  it("does not let the straddle allowance rescue a multi-day gap", () => {
    expect(isSameEventDay("2026-06-08T14:00:00Z", "2026-06-15T14:00:00Z", 7 * 24 * 60)).toBe(false);
  });
});
