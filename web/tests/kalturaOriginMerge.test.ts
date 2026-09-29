/**
 * Reuniting Kaltura-origin records with their Zoom recordings.
 *
 * Kaltura's Zoom connector ingests Zoom recordings automatically, and
 * the Kaltura importer then created a SECOND catalog record for the
 * same event — with `role: Origin`, asserting Kaltura is where the
 * content came from. It is not; the origin is a Zoom meeting.
 *
 * The connector's reference id makes the pairing an identity match:
 *
 *   Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
 *
 * These pin the pure halves — who pairs with whom, what gets written
 * back, and the guards on retiring a row.
 */

import { describe, it, expect } from "vitest";
import {
  findRecordsNeedingOriginBackfill,
  findOriginMergePairs,
  originPatch,
  kalturaOriginEntryId,
  findRecordsMissingZoomOriginLink,
  hasZoomOriginLink,
  zoomOriginLinkCmd,
  MERGEABLE,
} from "../src/lib/kalturaOriginMerge";
import type { VideoRecordJSON } from "../src/lib/wasm";

const UUID = "B7JsLl3USqCiZtsrC0FvKw==";
const REF = `Zoom_${UUID}2026-09-25T15:45:02Z`;

function rec(over: Partial<VideoRecordJSON> & { metadata_extra?: Record<string, unknown> }): VideoRecordJSON {
  return {
    id: "r1", title: "T", source_platform: "Kaltura", source_id: "1_b8kw2g8u",
    status: "Discovered", locations: [], upstream_links: [],
    ...over,
  } as unknown as VideoRecordJSON;
}

const kalturaLoc = (entryId = "1_b8kw2g8u", role = "Origin") => ({
  platform: "Kaltura", external_id: entryId, external_url: `kaltura://entry/${entryId}`,
  role, ordinal: 0, synced_at: "2026-09-28T00:00:00Z", status: null,
});

describe("kalturaOriginEntryId", () => {
  it("finds the entry a record was imported from", () => {
    expect(kalturaOriginEntryId(rec({ locations: [kalturaLoc()] }))).toBe("1_b8kw2g8u");
  });

  it("ignores a record merely published TO Kaltura", () => {
    // A Zoom-sourced record with a Kaltura Destination is the RESULT
    // of a merge, not a candidate for one.
    expect(kalturaOriginEntryId(rec({
      source_platform: "Zoom", source_id: `zoom-${UUID}`,
      locations: [kalturaLoc("1_x", "Destination")],
    }))).toBeNull();
  });
});

describe("findRecordsNeedingOriginBackfill", () => {
  it("selects Kaltura-origin records with no reference id recorded", () => {
    const work = findRecordsNeedingOriginBackfill([
      rec({ id: "a", locations: [kalturaLoc()] }),
      rec({ id: "b", locations: [kalturaLoc()], metadata_extra: { kaltura_reference_id: REF } }),
      rec({ id: "c", source_platform: "Zoom", source_id: `zoom-${UUID}` }),
    ]);
    expect(work.map(w => w.record_id)).toEqual(["a"]);
  });
});

describe("originPatch", () => {
  const base = { admin_tags: null, category_ids: [], created_at: "2026-09-25T18:13:49Z" };

  it("recovers the Zoom origin and corrects the recording time", () => {
    const p = originPatch({ ...base, reference_id: REF });
    expect(p.origin!.meeting_uuid).toBe(UUID);
    expect(p.metadata_extra.zoom_meeting_uuid).toBe(UUID);
    // The correction that matters: 18:13:49Z is when KALTURA ingested
    // the entry. The meeting started 2h28m earlier, and ADR-048 date
    // gates, ADR-060 show windows and the Overview all read this.
    expect(p.recorded_at).toBe("2026-09-25T15:45:02Z");
    expect(p.metadata_extra.kaltura_ingested_at).toBe("2026-09-25T18:13:49Z");
  });

  it("does NOT touch recorded_at when there is no connector timestamp", () => {
    // Leaving a value alone beats replacing it with a guess.
    const p = originPatch({ ...base, reference_id: "833b9f16-e4ca-449b-afff-c683818e0757" });
    expect(p.recorded_at).toBeUndefined();
    expect(p.origin).toBeUndefined();
    expect(p.metadata_extra.kaltura_reference_kind).toBe("ours");
  });

  it("records the kind even when the reference id is absent", () => {
    const p = originPatch({ ...base, reference_id: null });
    expect(p.metadata_extra.kaltura_reference_kind).toBe("absent");
    expect(p.recorded_at).toBeUndefined();
  });

  it("carries admin tags and category membership through", () => {
    const p = originPatch({ ...base, reference_id: REF, admin_tags: "zoomentry", category_ids: ["101", "202"] });
    expect(p.metadata_extra.kaltura_admin_tags).toBe("zoomentry");
    expect(p.metadata_extra.kaltura_category_ids).toBe("101,202");
  });
});

describe("findOriginMergePairs", () => {
  const zoom = rec({
    id: "zoomrec", source_platform: "Zoom", source_id: `zoom-${UUID}`,
    title: "Friday Hackerspace", status: "Published",
  });
  const kal = rec({
    id: "kalrec", locations: [kalturaLoc()], metadata_extra: { zoom_meeting_uuid: UUID },
  });

  it("pairs by meeting uuid, not by title or date", () => {
    const pairs = findOriginMergePairs([zoom, kal]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].zoom_record.id).toBe("zoomrec");
    expect(pairs[0].entry_id).toBe("1_b8kw2g8u");
  });

  it("finds nothing when we do not hold the Zoom recording", () => {
    // Roughly two thirds of them: the Kaltura originals predate
    // Zoom's retention. A missing counterpart must stay missing
    // rather than degrading into a fuzzy title match.
    expect(findOriginMergePairs([kal])).toEqual([]);
  });

  it("finds nothing before the backfill has recovered the uuid", () => {
    const noMeta = rec({ id: "kalrec", locations: [kalturaLoc()] });
    expect(findOriginMergePairs([zoom, noMeta])).toEqual([]);
  });

  it("does not pair a record with itself", () => {
    const selfish = rec({
      id: "solo", source_platform: "Kaltura", source_id: `zoom-${UUID}`,
      locations: [kalturaLoc()], metadata_extra: { zoom_meeting_uuid: UUID },
    });
    expect(findOriginMergePairs([selfish])).toEqual([]);
  });

  it("matches a uuid containing slashes and plus signs", () => {
    const odd = "63IjvIEHTsqZf5Nt/5mZbA==";
    const z = rec({ id: "z2", source_platform: "Zoom", source_id: `zoom-${odd}` });
    const k = rec({ id: "k2", locations: [kalturaLoc("1_other")], metadata_extra: { zoom_meeting_uuid: odd } });
    expect(findOriginMergePairs([z, k])).toHaveLength(1);
  });
});

describe("MERGEABLE", () => {
  it("refuses to retire a row that is mid-publish", () => {
    // Mirrors catalogDedupe's caution: abandoning a Publishing record
    // would strand an in-flight upload. Those report location_only —
    // the Zoom record still gains its Kaltura destination.
    for (const s of ["Approved", "Publishing", "ToRetry", "Published"]) {
      expect(MERGEABLE.has(s)).toBe(false);
    }
  });

  it("allows the states a stale import actually sits in", () => {
    for (const s of ["Discovered", "Indexed", "InScope", "OutOfScope", "Rejected"]) {
      expect(MERGEABLE.has(s)).toBe(true);
    }
  });
});

/**
 * The gap the operator found: record 06dbb971 had its reference id
 * recovered and `recorded_at` corrected, and still showed no Zoom
 * origin anywhere. The meeting UUID went into `metadata_extra`, which
 * neither the card nor the Provenance graph reads — both read
 * `upstream_links`, and nothing wrote one.
 */
describe("making a recovered origin visible", () => {
  const withOrigin = (over: Partial<VideoRecordJSON> & { metadata_extra?: Record<string, unknown> } = {}) => rec({
    id: "kal", locations: [kalturaLoc()],
    metadata_extra: { zoom_meeting_uuid: UUID, kaltura_reference_id: REF },
    ...over,
  });

  it("selects a record that knows its origin but shows no link", () => {
    const work = findRecordsMissingZoomOriginLink([withOrigin()]);
    expect(work).toEqual([{ record_id: "kal", title: "T", meeting_uuid: UUID }]);
  });

  it("needs no Kaltura call — the reference id is already recorded", () => {
    // findRecordsNeedingOriginBackfill would skip it, which is why the
    // button sat disabled for exactly the records the first run had
    // half-finished.
    expect(findRecordsNeedingOriginBackfill([withOrigin()])).toEqual([]);
    expect(findRecordsMissingZoomOriginLink([withOrigin()])).toHaveLength(1);
  });

  it("does not re-link a record that already has the link", () => {
    const linked = withOrigin({
      upstream_links: [{
        video_id: null, platform: "Zoom", external_id: UUID,
        account_hint: null, relation: "SameEvent", linked_by: "Auto",
        linked_at: "2026-09-29T00:00:00Z",
      }],
    });
    expect(hasZoomOriginLink(linked, UUID)).toBe(true);
    expect(findRecordsMissingZoomOriginLink([linked])).toEqual([]);
  });

  it("ignores records with no recovered origin", () => {
    expect(findRecordsMissingZoomOriginLink([rec({ id: "x", locations: [kalturaLoc()] })])).toEqual([]);
  });
});

describe("zoomOriginLinkCmd", () => {
  it("is a phantom link when we do not hold the Zoom recording", () => {
    // The common case: all 11 Kaltura-origin records name a meeting
    // the catalog does not hold, because the Kaltura entries outlive
    // Zoom's retention window.
    expect(zoomOriginLinkCmd({ meeting_uuid: UUID }, null)).toEqual({
      video_id: null, platform: "Zoom", external_id: UUID,
      relation: "SameEvent", linked_by: "Auto",
    });
  });

  it("resolves to the catalog record when we do hold it", () => {
    expect(zoomOriginLinkCmd({ meeting_uuid: UUID }, "zoomrec").video_id).toBe("zoomrec");
  });

  it("uses the relation provenanceLinker already uses for this shape", () => {
    // Renders as "Same session". None of TranscribedFrom /
    // ScreenRecordingOf / ClipOf / BroadcastedFrom describes "another
    // platform ingested this recording".
    expect(zoomOriginLinkCmd({ meeting_uuid: UUID }, null).relation).toBe("SameEvent");
  });
});
