/**
 * ADR-082 — the catalog write boundary must not lose server state.
 *
 * Both incidents are replayed here as fixtures, because the shape
 * that caused them is not obvious from the rule alone: every push was
 * a complete, valid record. Nothing was malformed. The records were
 * simply missing things the server already had, and last-writer-wins
 * faithfully wrote the loss.
 *
 *   2026-09-29  06dbb971 / 9b0bdef2 lost 4 metadata_extra keys each;
 *               06dbb971's description went 1246 -> 300 chars
 *   2026-10-03  the same, plus 954cbc2f's description 4466 -> 300
 *
 * 300 is the length Kaltura's media.list returns, so every truncation
 * was a stale import-time value overwriting text enriched later.
 */

import { describe, it, expect } from "vitest";
import { protectRecordWrite, isSilentTruncation } from "../src/lib/catalogWriteProtection";

/** The four keys both incidents destroyed. */
const SERVER_EXTRA = {
  kaltura_original_title: "Mobile Hackerspace on Wheels: Agentix Foundation Road Trip",
  player_url: "https://video.agentics.org/media/t/1_b8kw2g8u",
  title_aligned_source: "series_registry",
  title_aligned_matched_series: "Friday Hackerspace Live Events",
};
/** What the stale tab pushed: the backfill's own keys and nothing else. */
const STALE_EXTRA = {
  kaltura_reference_id: "Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z",
  kaltura_reference_kind: "zoom",
  zoom_meeting_uuid: "B7JsLl3USqCiZtsrC0FvKw==",
};

const rec = (o: Record<string, unknown>) => JSON.stringify({ id: "06dbb971", ...o });

describe("the 2026-09-29 / 2026-10-03 incident, replayed", () => {
  it("keeps the four keys the stale push omitted", () => {
    const { json, protections } = protectRecordWrite(
      "06dbb971",
      rec({ metadata_extra: { ...SERVER_EXTRA, ...STALE_EXTRA } }),
      rec({ metadata_extra: STALE_EXTRA }),
    );
    const out = JSON.parse(json).metadata_extra;
    for (const k of Object.keys(SERVER_EXTRA)) expect(out).toHaveProperty(k);
    // ...and the push's own keys still land.
    expect(out.zoom_meeting_uuid).toBe(STALE_EXTRA.zoom_meeting_uuid);
    expect(protections[0]).toMatchObject({ field: "metadata_extra" });
    expect(protections[0].kept_keys!.sort()).toEqual(Object.keys(SERVER_EXTRA).sort());
  });

  it("refuses the 1246 -> 300 truncation", () => {
    const full = "A".repeat(1246);
    const { json, protections } = protectRecordWrite(
      "06dbb971", rec({ description: full }), rec({ description: full.slice(0, 300) }),
    );
    expect(JSON.parse(json).description).toHaveLength(1246);
    expect(protections.find(p => p.field === "description")).toMatchObject({
      stored_length: 1246, incoming_length: 300,
    });
  });

  it("refuses the 4466 -> 300 truncation", () => {
    const full = "B".repeat(4466);
    const { json } = protectRecordWrite(
      "954cbc2f", rec({ description: full }), rec({ description: full.slice(0, 300) }),
    );
    expect(JSON.parse(json).description).toHaveLength(4466);
  });
});

describe("§1 metadata_extra merges key-wise", () => {
  it("lets the push UPDATE a value it does carry", () => {
    // Only disappearance is prevented; a real edit must still win.
    const { json } = protectRecordWrite("r", rec({ metadata_extra: { a: "old", b: "keep" } }),
                                              rec({ metadata_extra: { a: "new" } }));
    expect(JSON.parse(json).metadata_extra).toEqual({ a: "new", b: "keep" });
  });

  it("is a no-op when the push carries everything", () => {
    const same = rec({ metadata_extra: { a: 1 } });
    const { json, protections } = protectRecordWrite("r", same, same);
    expect(protections).toEqual([]);
    // §3 — an untouched record is returned byte-identical, not re-serialised.
    expect(json).toBe(same);
  });

  it("passes a brand-new record straight through", () => {
    const incoming = rec({ metadata_extra: { a: 1 } });
    expect(protectRecordWrite("r", undefined, incoming)).toEqual({ json: incoming, protections: [] });
  });

  it("does not resurrect keys on a record that never had any", () => {
    const { protections } = protectRecordWrite("r", rec({}), rec({ metadata_extra: { a: 1 } }));
    expect(protections).toEqual([]);
  });
});

describe("§2 description shrinkage", () => {
  it("allows a genuine rewrite, which is not a prefix", () => {
    const { json, protections } = protectRecordWrite(
      "r", rec({ description: "The original long text about AI agents." }),
           rec({ description: "Totally different and shorter." }),
    );
    expect(JSON.parse(json).description).toBe("Totally different and shorter.");
    expect(protections).toEqual([]);
  });

  it("allows growth", () => {
    const { protections } = protectRecordWrite("r", rec({ description: "short" }),
                                                    rec({ description: "short but now much longer" }));
    expect(protections).toEqual([]);
  });

  it("protects an emptied description, since '' is a prefix of anything", () => {
    const { json } = protectRecordWrite("r", rec({ description: "real text" }), rec({ description: "" }));
    expect(JSON.parse(json).description).toBe("real text");
  });

  it("yields to an explicit allowDescriptionShrink", () => {
    const { json, protections } = protectRecordWrite(
      "r", rec({ description: "keep the first bit only" }), rec({ description: "keep the first bit" }),
      { allowDescriptionShrink: true },
    );
    expect(JSON.parse(json).description).toBe("keep the first bit");
    expect(protections).toEqual([]);
  });
});

describe("isSilentTruncation", () => {
  it("is true only for a strict prefix that is shorter", () => {
    expect(isSilentTruncation("abcdef", "abc")).toBe(true);
    expect(isSilentTruncation("abcdef", "abcdef")).toBe(false);
    expect(isSilentTruncation("abc", "abcdef")).toBe(false);
    expect(isSilentTruncation("abcdef", "xyz")).toBe(false);
  });
});

describe("robustness at the boundary", () => {
  it("passes through when the STORED record will not parse", () => {
    // Refusing a write because the existing value is corrupt would
    // make a bad record permanent.
    const incoming = rec({ description: "fine" });
    expect(protectRecordWrite("r", "{not json", incoming).json).toBe(incoming);
  });

  it("treats a null metadata_extra as absent rather than throwing", () => {
    const { json } = protectRecordWrite("r", rec({ metadata_extra: null }),
                                             rec({ metadata_extra: { a: 1 } }));
    expect(JSON.parse(json).metadata_extra).toEqual({ a: 1 });
  });

  it("protects both fields in one write", () => {
    const full = "C".repeat(500);
    const { protections } = protectRecordWrite(
      "r", rec({ metadata_extra: SERVER_EXTRA, description: full }),
           rec({ metadata_extra: {}, description: full.slice(0, 100) }),
    );
    expect(protections.map(p => p.field).sort()).toEqual(["description", "metadata_extra"]);
  });
});
