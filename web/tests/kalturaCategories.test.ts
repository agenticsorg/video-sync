/**
 * Kaltura category reconciliation.
 *
 * The bug this fixes was silent, so the tests pin the silence as much
 * as the behaviour. The series registry declares:
 *
 *   ["@zoomCategory@", "Agentics.org Video Portal",
 *    "Ai Hackerspace Live Recordings", "vod_sources", "Weekly Recordings"]
 *
 * and publish/adapters/kaltura.ts:39 ran `.map(id => Number(id))
 * .filter(n => !Number.isNaN(n))` over it. Every value is NaN, so the
 * array emptied; /api/kaltura/upload then skipped `categoriesIds`
 * because `length > 0` was false. Nothing threw, nothing logged, and
 * 19 published entries carry no category as a result.
 */

import { describe, it, expect } from "vitest";
import {
  resolveDeclaredCategory,
  planReconcile,
  declaredKalturaCategories,
  kalturaEntryId,
  summarizeReconcile,
  isCompliant,
  TEMPLATE_TOKEN_RE,
  type KalturaCategory,
  type ReconcileResponse,
} from "../src/lib/kalturaCategories";
import type { DestinationSpec } from "../src/lib/youtubeTitleAlign";
import type { PlatformLocationJSON } from "../src/lib/wasm";

/** The live declaration, verbatim from series-registry.json. */
const DECLARED = [
  "@zoomCategory@",
  "Agentics.org Video Portal",
  "Ai Hackerspace Live Recordings",
  "vod_sources",
  "Weekly Recordings",
];

const CATALOG: KalturaCategory[] = [
  { id: 101, name: "Agentics.org Video Portal", fullName: "Agentics.org Video Portal" },
  { id: 102, name: "Ai Hackerspace Live Recordings", fullName: "Ai Hackerspace Live Recordings" },
  { id: 103, name: "vod_sources", fullName: "vod_sources" },
  { id: 104, name: "Weekly Recordings", fullName: "Agentics.org Video Portal>Weekly Recordings" },
];

describe("the regression that caused this", () => {
  it("shows why every declared value vanished", () => {
    // The exact expression from the adapter.
    const survivors = DECLARED.map(id => Number(id)).filter(n => !Number.isNaN(n));
    expect(survivors).toEqual([]);
    // ...and the route's guard, which is what made it silent.
    expect(survivors.length > 0).toBe(false);
  });

  it("resolves every non-template value the old path dropped", () => {
    const resolved = DECLARED.map(d => resolveDeclaredCategory(d, CATALOG));
    expect(resolved.filter(r => r.id !== null).map(r => r.id)).toEqual([101, 102, 103, 104]);
  });
});

describe("resolveDeclaredCategory", () => {
  it("treats a bare integer as an id", () => {
    expect(resolveDeclaredCategory("101", CATALOG)).toMatchObject({ id: 101 });
  });

  it("accepts an id that is not in the listing, rather than calling it missing", () => {
    // A category the admin KS cannot list is still a valid id to add
    // to; refusing it would be a false negative.
    expect(resolveDeclaredCategory("999", CATALOG)).toMatchObject({ id: 999, fullName: null });
  });

  it("does not treat a name as a number", () => {
    // Number("") === 0 and Number(" 12 ") === 12: the shape test is the
    // point, not the coercion.
    expect(resolveDeclaredCategory("vod_sources", CATALOG).id).toBe(103);
    expect(resolveDeclaredCategory("", CATALOG).id).toBeNull();
  });

  it("matches on full name before bare name", () => {
    expect(resolveDeclaredCategory("Agentics.org Video Portal>Weekly Recordings", CATALOG).id).toBe(104);
  });

  it("matches a bare leaf name when it is unambiguous", () => {
    expect(resolveDeclaredCategory("Weekly Recordings", CATALOG).id).toBe(104);
  });

  it("ignores case and surrounding whitespace", () => {
    // The registry field is a comma-split text input, so " vod_sources"
    // is a typo rather than a different category.
    expect(resolveDeclaredCategory("  VOD_SOURCES ", CATALOG).id).toBe(103);
  });

  it("refuses to guess when a leaf name is ambiguous", () => {
    const ambiguous: KalturaCategory[] = [
      { id: 1, name: "Recordings", fullName: "A>Recordings" },
      { id: 2, name: "Recordings", fullName: "B>Recordings" },
    ];
    const r = resolveDeclaredCategory("Recordings", ambiguous);
    expect(r.id).toBeNull();
    expect(r.reason).toBe("ambiguous");
  });

  it("reports an unknown name as not_found", () => {
    expect(resolveDeclaredCategory("No Such Category", CATALOG)).toMatchObject({
      id: null,
      reason: "not_found",
    });
  });

  it("classifies an integration placeholder separately from a missing category", () => {
    // @zoomCategory@ is substituted by Kaltura's Zoom connector at
    // ingest. No external caller can apply it, so calling it
    // "not_found" would put a permanent false failure on three series.
    const r = resolveDeclaredCategory("@zoomCategory@", CATALOG);
    expect(r.id).toBeNull();
    expect(r.reason).toBe("template");
  });

  it("recognises template tokens but not ordinary names containing @", () => {
    expect(TEMPLATE_TOKEN_RE.test("@zoomCategory@")).toBe(true);
    expect(TEMPLATE_TOKEN_RE.test("me@example.com")).toBe(false);
    expect(TEMPLATE_TOKEN_RE.test("@not closed")).toBe(false);
  });
});

describe("planReconcile", () => {
  it("splits the live declaration into add / present / unresolved", () => {
    const plan = planReconcile(DECLARED, CATALOG, [101]); // already in the Portal
    expect(plan.toAdd.map(t => t.id)).toEqual([102, 103, 104]);
    expect(plan.alreadyPresent.map(t => t.id)).toEqual([101]);
    expect(plan.unresolved.map(t => t.raw)).toEqual(["@zoomCategory@"]);
  });

  it("never proposes removing a category the entry already has", () => {
    // Additive by construction — a KMC admin's manual categorisation
    // must survive the repair. 777 is not declared and not touched.
    const plan = planReconcile(["vod_sources"], CATALOG, [777]);
    expect(plan.toAdd.map(t => t.id)).toEqual([103]);
    expect(JSON.stringify(plan)).not.toContain("777");
  });

  it("collapses a category declared twice under different spellings", () => {
    // Two categoryEntry.add calls for one membership: Kaltura rejects
    // the second as a duplicate, which would surface as a spurious
    // failure on an otherwise clean run.
    const plan = planReconcile(["vod_sources", "VOD_SOURCES", "103"], CATALOG, []);
    expect(plan.toAdd.map(t => t.id)).toEqual([103]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(planReconcile(["vod_sources", "", "   "], CATALOG, []).toAdd).toHaveLength(1);
  });

  it("is a no-op the second time it runs", () => {
    const first = planReconcile(DECLARED, CATALOG, []);
    const after = first.toAdd.map(t => t.id as number);
    const second = planReconcile(DECLARED, CATALOG, after);
    expect(second.toAdd).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(4);
  });
});

describe("declaredKalturaCategories", () => {
  it("reads the Kaltura destination's categories", () => {
    const dests: DestinationSpec[] = [
      { platform: "YouTube", visibility: "public" },
      { platform: "Kaltura", visibility: "members", category_ids: DECLARED },
    ];
    expect(declaredKalturaCategories(dests)).toEqual(DECLARED);
  });

  it("returns empty for a Kaltura destination that declares none", () => {
    // "Toronto Meetup" in the live registry — Kaltura, no category_ids.
    expect(declaredKalturaCategories([{ platform: "Kaltura", visibility: "members" }])).toEqual([]);
  });

  it("returns empty when the series wants no Kaltura at all", () => {
    expect(declaredKalturaCategories([{ platform: "YouTube", visibility: "public" }])).toEqual([]);
  });
});

describe("kalturaEntryId", () => {
  const loc = (over: Partial<PlatformLocationJSON>): PlatformLocationJSON => ({
    platform: "Kaltura",
    external_id: "1_vstvnbok",
    external_url: null,
    role: "Destination",
    ordinal: 0,
    synced_at: "2026-09-01T00:00:00Z",
    status: null,
    ...over,
  });

  it("finds the published entry", () => {
    expect(kalturaEntryId([loc({})])).toBe("1_vstvnbok");
  });

  it("ignores a Kaltura SOURCE location", () => {
    // A record imported FROM Kaltura is not a record published TO it;
    // reconciling categories onto the source entry would edit someone
    // else's upload.
    expect(kalturaEntryId([loc({ role: "Source" })])).toBeNull();
  });

  it("ignores other platforms and an absent location list", () => {
    expect(kalturaEntryId([loc({ platform: "YouTube" })])).toBeNull();
    expect(kalturaEntryId(undefined)).toBeNull();
  });
});

describe("summarizeReconcile / isCompliant", () => {
  const base: ReconcileResponse = {
    entryId: "1_vstvnbok",
    added: [],
    alreadyPresent: [],
    unresolved: [],
    failed: [],
  };

  it("names what it added", () => {
    const text = summarizeReconcile({
      ...base,
      added: [{ raw: "vod_sources", id: 103, fullName: "vod_sources" }],
    });
    expect(text).toContain("added vod_sources");
  });

  it("says nothing to do when there was nothing to do", () => {
    expect(summarizeReconcile(base)).toBe("nothing to do");
  });

  it("explains a template token rather than counting it as a failure", () => {
    const res = { ...base, unresolved: [{ raw: "@zoomCategory@", id: null, fullName: null, reason: "template" as const }] };
    expect(summarizeReconcile(res)).toContain("integration placeholder");
    // The entry IS as compliant as this tool can make it.
    expect(isCompliant(res)).toBe(true);
  });

  it("does not call an entry compliant when a real category is missing", () => {
    const res = { ...base, unresolved: [{ raw: "Typo Category", id: null, fullName: null, reason: "not_found" as const }] };
    expect(summarizeReconcile(res)).toContain("not_found");
    expect(isCompliant(res)).toBe(false);
  });

  it("does not call an entry compliant when an add failed", () => {
    const res = {
      ...base,
      failed: [{ raw: "vod_sources", id: 103, fullName: "vod_sources", error: "permission denied" }],
    };
    expect(isCompliant(res)).toBe(false);
    expect(summarizeReconcile(res)).toContain("permission denied");
  });
});
