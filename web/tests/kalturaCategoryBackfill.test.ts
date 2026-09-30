/**
 * ADR-080 Phase 1 — the category backfill's scanner.
 *
 * The thing worth pinning is what this scanner REFUSES to claim.
 * Category membership lives on Kaltura, not in the catalog, so a pure
 * scanner cannot know which entries are behind. It returns candidates
 * to check. The original bug in this feature was a confident
 * conclusion drawn from an input that had been silently narrowed, and
 * a dashboard number nobody had earned is the same mistake wearing a
 * different hat.
 */

import { describe, it, expect } from "vitest";
import { findKalturaCategoryCandidates } from "../src/lib/kalturaCategoryBackfill";
import type { VideoRecordJSON } from "../src/lib/wasm";
import type { SeriesRegistryEntry } from "../src/lib/youtubeTitleAlign";

/** The live declaration, post-2026-09-29 full-path migration. */
const DECLARED = [
  "@zoomCategory@",
  "2361952EPea2653e>site>channels>Agentics.org Video Portal",
  "mediaspace_8DEe6>site>channels>Ai Hackerspace Live Recordings",
  "mediaspace_8DEe6>site>galleries>Weekly Recordings",
];

const registry = [
  {
    series_name: "Friday Hackerspace Live Events",
    pattern: "^Friday Hackerspace Live Events",
    destinations: [{ platform: "Kaltura", visibility: "members", category_ids: DECLARED }],
  },
  {
    series_name: "Toronto Meetup",
    pattern: "^Toronto Meetup",
    destinations: [{ platform: "Kaltura", visibility: "members" }],
  },
] as unknown as SeriesRegistryEntry[];

const kalturaLoc = (entryId: string, role = "Destination") => ({
  platform: "Kaltura", external_id: entryId, external_url: `https://video.agentics.org/media/t/${entryId}`,
  role, ordinal: 0, synced_at: "2026-09-29T00:00:00Z", status: null,
});

function rec(over: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: "r1", title: "Friday Hackerspace Live Events - 7 Aug 2026",
    source_platform: "Zoom", source_id: "zoom-x", status: "Published",
    recorded_at: "2026-08-07T15:45:00Z", locations: [], upstream_links: [],
    ...over,
  } as unknown as VideoRecordJSON;
}

const find = (records: VideoRecordJSON[]) => findKalturaCategoryCandidates(records, registry, []);

describe("findKalturaCategoryCandidates", () => {
  it("selects a published entry whose series declares categories", () => {
    const got = find([rec({ locations: [kalturaLoc("1_yhs8i4rb")] })]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      entry_id: "1_yhs8i4rb",
      series_name: "Friday Hackerspace Live Events",
      declared: DECLARED,
    });
  });

  it("ignores an entry we only INDEXED — role Origin is Phase 3", () => {
    // ADR-080 §1 keeps Phase 1 to entries this app published, which
    // is exactly the set the per-card action already operates on.
    expect(find([rec({ locations: [kalturaLoc("1_yhs8i4rb", "Origin")] })])).toEqual([]);
  });

  it("ignores a series that declares Kaltura but no categories", () => {
    // "Toronto Meetup" in the live registry. Nothing to reconcile
    // against, so it is not a candidate.
    expect(find([rec({ title: "Toronto Meetup - 3 Sep 2026", locations: [kalturaLoc("1_t") ] })])).toEqual([]);
  });

  it("ignores a record matching no series", () => {
    expect(find([rec({ title: "Some Other Thing", locations: [kalturaLoc("1_z")] })])).toEqual([]);
  });

  it("ignores a record with no Kaltura entry at all", () => {
    expect(find([rec({ locations: [] })])).toEqual([]);
  });

  it("does not care about status — the debt is on Published records", () => {
    // All 8 in-scope records sit Published. Gating on a status would
    // have found nothing.
    const got = find([rec({ status: "Published", locations: [kalturaLoc("1_a")] })]);
    expect(got).toHaveLength(1);
  });
});

describe("what the scanner deliberately does NOT claim", () => {
  it("returns candidates even though it cannot know they are behind", () => {
    // The key property. Membership lives on Kaltura; this function
    // does no I/O. A record already in all four categories is still
    // returned, and reconciling it costs one read and zero writes.
    const compliant = rec({ locations: [kalturaLoc("1_already_compliant")] });
    expect(find([compliant])).toHaveLength(1);
  });

  it("is named for what it does — candidates, not needs", () => {
    // findRecordsNeeding… would be a lie, and the card's wording
    // follows the function's. ADR-080 §2.
    expect(findKalturaCategoryCandidates.name).toBe("findKalturaCategoryCandidates");
  });

  it("is pure — the same input twice gives the same answer", () => {
    const records = [rec({ locations: [kalturaLoc("1_yhs8i4rb")] })];
    expect(find(records)).toEqual(find(records));
  });
});
