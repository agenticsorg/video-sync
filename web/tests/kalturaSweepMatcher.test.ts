/**
 * ADR-081 §2/§3 — the sweep matcher, tested against the real account.
 *
 * The fixture is the actual `media.list` survey of partner 5896392 on
 * 2026-10-03: 127 entries, 118 of them Zoom-connector ingested, none
 * in any portal channel. Synthetic cases would not catch what matters
 * here, because the hazard is a PRIVATE meeting landing in the public
 * portal, and the private meetings only exist in the real data.
 *
 * Ground truth for the two shows comes from cross-checking Kaltura
 * entry ids against catalog records:
 *   1_bqguo3um / 1_b8kw2g8u -> Friday Hackerspace  (Fri 11:45)
 *   1_xk376nnl / 1_sbhiqdmf -> Agentics Live Vibe  (Thu 11:45)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  planSweep, matchEntry, eligibleSeries, localParts, declaredCategories,
  SWEEP_WINDOW_BEFORE_MIN, type SweepEntry,
} from "../src/lib/kalturaSweepMatcher";
import type { SeriesRegistryEntry } from "../src/lib/youtubeTitleAlign";

const ENTRIES: SweepEntry[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/kaltura-survey-2026-10-03.json"), "utf-8"),
);

/** The partner's real category list, from the same survey. */
const CATALOG = JSON.parse(
  readFileSync(join(__dirname, "fixtures/kaltura-categories-2026-10-03.json"), "utf-8"),
);

/** What the registry actually declares: full-path NAMES, not ids. */
const CATS = [
  "@zoomCategory@",
  "2361952EPea2653e>site>channels>Agentics.org Video Portal",
  "mediaspace_8DEe6>site>channels>Ai Hackerspace Live Recordings",
  "mediaspace_8DEe6>site>galleries>Weekly Recordings",
];

const series = (name: string, days: string[], over: Partial<SeriesRegistryEntry> = {}) => ({
  series_name: name,
  pattern: `^.*${name.split(" ")[0]}.*`,
  scheduled_days: days,
  scheduled_start_local: "12:00",
  scheduled_end_local: "13:30",
  scheduled_timezone: "America/New_York",
  destinations: [{ platform: "Kaltura", visibility: "members", category_ids: CATS }],
  ...over,
}) as unknown as SeriesRegistryEntry;

const REGISTRY = [
  series("Agentics Live Vibe - Coding", ["Thu"]),
  series("Friday Hackerspace Live Events", ["Fri"]),
];

describe("against the real 127-entry account", () => {
  const plan = planSweep(ENTRIES, REGISTRY, CATALOG);

  it("claims exactly the 16 weekly show recordings", () => {
    expect(plan.matches).toHaveLength(16);
    const byShow = plan.matches.reduce<Record<string, number>>((a, m) => {
      a[m.series_name] = (a[m.series_name] ?? 0) + 1; return a;
    }, {});
    expect(byShow).toEqual({
      "Agentics Live Vibe - Coding": 8,
      "Friday Hackerspace Live Events": 8,
    });
    // 3 per entry, not 4: every surveyed entry was already in
    // @zoomCategory@, so only the three portal categories are missing.
    // The first version compared declared NAMES against Kaltura's
    // numeric ids and reported 64 — four per entry, including the one
    // they all had. Live plan caught it; this pins it.
    expect(plan.operations).toBe(48);
  });

  it("resolves declared names to ids rather than string-comparing them", () => {
    const m = plan.matches.find(x => x.entry.id === "1_b8kw2g8u")!;
    expect(m.declared).toEqual(CATS);                       // names in
    expect(m.present).toEqual(["364214852"]);               // @zoomCategory@, resolved
    expect(m.missing).toEqual(["370465892", "370407052", "370373752"]);
    expect(m.unresolved).toEqual([]);
    // Every value written is a numeric id the apply step accepts.
    for (const id of m.missing) expect(id).toMatch(/^\d+$/);
  });

  it("reports nothing to do once the categories are applied", () => {
    // The live state after the one-off script: all four present.
    const applied = ENTRIES.map(e => e.id === "1_b8kw2g8u"
      ? { ...e, category_ids: ["364214852", "370465892", "370407052", "370373752"] } : e);
    const m = planSweep(applied, REGISTRY, CATALOG).matches.find(x => x.entry.id === "1_b8kw2g8u")!;
    expect(m.missing).toEqual([]);
    expect(m.present).toHaveLength(4);
  });

  it("claims the entries confirmed against catalog ground truth", () => {
    const got = new Set(plan.matches.map(m => m.entry.id));
    for (const id of ["1_bqguo3um", "1_b8kw2g8u"]) expect(got).toContain(id);   // Hackerspace
    for (const id of ["1_xk376nnl", "1_sbhiqdmf"]) expect(got).toContain(id);   // Vibe
  });

  it("claims NOTHING private", () => {
    // The whole safety case. These share the Zoom/Kaltura account and
    // run in the same time band as the public shows.
    const claimed = plan.matches.map(m => m.entry.name.toLowerCase());
    for (const forbidden of [
      "asia management meeting", "committee meeting", "management team meeting",
      "agentics marketing", "website - agentics", "google analytics",
      "migrating discord", "user's zoom meeting",
    ]) {
      expect(claimed.some(n => n.includes(forbidden))).toBe(false);
    }
  });

  it("leaves 111 of 127 alone", () => {
    expect(plan.skips).toHaveLength(111);
  });

  it("every claimed entry starts in the pre-show, never after the show begins", () => {
    // The recording covers the pre-show, so the offset is negative.
    for (const m of plan.matches) {
      expect(m.offset_minutes).toBeLessThanOrEqual(0);
      expect(m.offset_minutes).toBeGreaterThanOrEqual(-SWEEP_WINDOW_BEFORE_MIN);
    }
  });

  it("resolves every claimed entry to EDT, not a fixed offset", () => {
    // The survey spans Jun-Oct so all of it is EDT; the point is that
    // the matcher asked Intl rather than assuming -4.
    for (const m of plan.matches) expect(m.local).toMatch(/^(Thu|Fri) /);
  });
});

describe("the margin to the nearest private recording", () => {
  it("excludes 'Website - Agentics' at -64 min, the closest Thursday non-show", () => {
    const website = ENTRIES.filter(e => e.name.startsWith("Website - Agentics"));
    expect(website.length).toBeGreaterThan(0);
    const eligible = eligibleSeries(REGISTRY);
    for (const e of website) {
      const r = matchEntry(e, eligible);
      expect("skip" in r).toBe(true);
    }
  });

  it("would start catching it if the window widened past ~45 min", () => {
    // Documents why SWEEP_WINDOW_BEFORE_MIN is 30 and not "generous".
    expect(SWEEP_WINDOW_BEFORE_MIN).toBeLessThan(64);
    expect(64 - SWEEP_WINDOW_BEFORE_MIN).toBeGreaterThanOrEqual(30);
  });
});

describe("§3 eligibility — the default is to do nothing", () => {
  it("rejects a series with no scheduled_days", () => {
    expect(eligibleSeries([series("X", [])])).toEqual([]);
  });
  it("rejects a series with no declared categories", () => {
    expect(eligibleSeries([series("X", ["Thu"], { destinations: [] } as never)])).toEqual([]);
  });
  it("rejects a series with no timezone", () => {
    expect(eligibleSeries([series("X", ["Thu"], { scheduled_timezone: undefined })])).toEqual([]);
  });
  it("rejects a malformed weekday rather than guessing", () => {
    expect(eligibleSeries([series("X", ["Thursday"])])).toEqual([]);
  });
  it("claims nothing at all when no series is eligible", () => {
    const plan = planSweep(ENTRIES, [series("X", [])]);
    expect(plan.matches).toEqual([]);
    expect(plan.operations).toBe(0);
  });
});

describe("matchEntry skip reasons", () => {
  const eligible = eligibleSeries(REGISTRY);
  const base: SweepEntry = { id: "1_x", name: "n", reference_id: null, category_ids: [], createdAt: "2026-09-25T18:00:00Z" };

  it("skips an entry with no Zoom reference — including ones we published", () => {
    const ours = { ...base, reference_id: "833b9f16-e4ca-449b-afff-c683818e0757" };
    expect(matchEntry(ours, eligible)).toEqual({ skip: { entry: ours, reason: "no_zoom_reference" } });
  });

  it("skips the right weekday at the wrong time", () => {
    const late = { ...base, reference_id: "Zoom_abc==2026-09-25T20:00:00Z" };  // 16:00 EDT Fri
    expect(matchEntry(late, eligible)).toMatchObject({ skip: { reason: "outside_window" } });
  });

  it("skips the right time on the wrong weekday", () => {
    // 2026-09-23 is a Wednesday — the Discord-migration slot.
    const wed = { ...base, reference_id: "Zoom_abc==2026-09-23T15:45:00Z" };
    expect(matchEntry(wed, eligible)).toMatchObject({ skip: { reason: "outside_window" } });
  });
});

describe("localParts", () => {
  it("honours DST rather than a fixed offset", () => {
    // Same wall-clock intent either side of the November change.
    expect(localParts("2026-10-02T15:45:00Z", "America/New_York")!.minutes).toBe(11 * 60 + 45); // EDT
    expect(localParts("2026-12-04T16:45:00Z", "America/New_York")!.minutes).toBe(11 * 60 + 45); // EST
  });
  it("returns null for an invalid zone rather than defaulting to UTC", () => {
    expect(localParts("2026-10-02T15:45:00Z", "Not/AZone")).toBeNull();
  });
});

describe("declaredCategories", () => {
  it("reads the Kaltura destination", () => {
    expect(declaredCategories(REGISTRY[0])).toEqual(CATS);
  });
  it("is empty when the series declares no Kaltura destination", () => {
    expect(declaredCategories({ series_name: "x", pattern: "x" } as SeriesRegistryEntry)).toEqual([]);
  });
});
