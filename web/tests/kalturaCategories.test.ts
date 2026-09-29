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
  suggestFullNames,
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

  it("distinguishes an empty listing from a name that is genuinely absent", () => {
    // The live first run reported four unrelated names as not_found,
    // which was unfalsifiable: a name missing from 200 categories and a
    // name missing from ZERO categories are different faults (registry
    // vs. session permissions) and both read as not_found.
    expect(resolveDeclaredCategory("vod_sources", []).reason).toBe("listing_empty");
    expect(resolveDeclaredCategory("vod_sources", CATALOG).id).toBe(103);
  });

  it("still accepts a numeric id when the listing is empty", () => {
    // An id needs no listing to be usable, so an unreadable category
    // list must not block the one case that does not depend on it.
    expect(resolveDeclaredCategory("103", [])).toMatchObject({ id: 103 });
  });

  it("suggests the likely intended category when a name misses", () => {
    const renamed: KalturaCategory[] = [
      { id: 7, name: "VOD Sources", fullName: "Agentics>VOD Sources" },
      { id: 8, name: "Unrelated", fullName: "Unrelated" },
    ];
    const r = resolveDeclaredCategory("vod_sources", renamed);
    expect(r.reason).toBe("not_found");
    expect(r.suggestions).toContain("Agentics>VOD Sources");
  });
});

describe("suggestFullNames", () => {
  it("finds a category that has been re-nested under a parent", () => {
    // The realistic failure is a moved or reworded category, not a
    // typo — which is why this scores token overlap, not edit distance.
    const moved: KalturaCategory[] = [
      { id: 1, name: "Weekly Recordings", fullName: "Agentics.org Video Portal>Weekly Recordings" },
      { id: 2, name: "Daily Standups", fullName: "Daily Standups" },
    ];
    expect(suggestFullNames("Weekly Recordings", moved)[0])
      .toBe("Agentics.org Video Portal>Weekly Recordings");
  });

  it("ranks a tighter match above a sprawling path that merely contains the words", () => {
    const cats: KalturaCategory[] = [
      { id: 1, name: "Portal", fullName: "Agentics.org Video Portal" },
      { id: 2, name: "Misc", fullName: "Archive>Old>Stuff" },
    ];
    expect(suggestFullNames("Agentics.org Video Portal", cats)[0]).toBe("Agentics.org Video Portal");
  });

  it("offers nothing rather than noise when nothing is close", () => {
    expect(suggestFullNames("Completely Unrelated", [
      { id: 1, name: "vod_sources", fullName: "vod_sources" },
    ])).toEqual([]);
  });

  it("returns nothing for an empty catalog or an empty needle", () => {
    expect(suggestFullNames("anything", [])).toEqual([]);
    expect(suggestFullNames("", CATALOG)).toEqual([]);
  });

  it("resolves @zoomCategory@ when the partner really has it", () => {
    // The correction. This module first refused any @token@ name as an
    // unexpandable Zoom-connector template. The partner's own listing
    // disproved that: @zoomCategory@ and @zoomWebinarCategory@ are real
    // categories, created by a connector configured with an
    // unsubstituted template. Refusing them applied nothing and blamed
    // the registry for being right.
    const withToken = [...CATALOG, { id: 200, name: "@zoomCategory@", fullName: "@zoomCategory@" }];
    expect(resolveDeclaredCategory("@zoomCategory@", withToken).id).toBe(200);
  });

  it("keeps the token shape as a hint only when the name is absent", () => {
    const r = resolveDeclaredCategory("@zoomCategory@", CATALOG);
    expect(r.id).toBeNull();
    expect(r.reason).toBe("template");
  });

  it("prefers listing_empty over the token hint", () => {
    // An empty listing explains the miss; the name's shape does not.
    expect(resolveDeclaredCategory("@zoomCategory@", []).reason).toBe("listing_empty");
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

  it("points an absent token at the connector config, and still counts it against compliance", () => {
    const res = { ...base, unresolved: [{ raw: "@zoomCategory@", id: null, fullName: null, reason: "template" as const }] };
    expect(summarizeReconcile(res)).toContain("unsubstituted integration placeholder");
    // Previously excused as "not applicable". A declared category that
    // could not be applied leaves the entry short of what the series
    // asked for, whatever the reason.
    expect(isCompliant(res)).toBe(false);
  });

  it("is compliant only when nothing is left unresolved", () => {
    expect(isCompliant(base)).toBe(true);
    expect(isCompliant({ ...base, added: [{ raw: "vod_sources", id: 103, fullName: "vod_sources" }] })).toBe(true);
  });

  it("blames the session, not the registry, when the listing came back empty", () => {
    const res: ReconcileResponse = {
      ...base,
      categoriesListed: 0,
      unresolved: DECLARED.filter(d => !d.startsWith("@")).map(raw => ({
        raw, id: null, fullName: null, reason: "listing_empty" as const,
      })),
    };
    const text = summarizeReconcile(res);
    expect(text).toContain("no categories for this partner");
    expect(text).toContain("cannot list categories");
    // The four names individually would be noise around the one fact.
    expect(text).not.toContain("not_found");
    expect(isCompliant(res)).toBe(false);
  });

  it("refuses to stand behind a not_found when the listing was read short", () => {
    // Partner 5896392 returned 28 categories while the operator was
    // using four others by hand. A miss checked against a partial
    // catalog is not evidence, and saying "checked against 28" implied
    // a completeness the call never established.
    const text = summarizeReconcile({
      ...base,
      categoriesListed: 28,
      categoriesReportedByKaltura: 312,
      unresolved: [{ raw: "vod_sources", id: null, fullName: null, reason: "not_found" as const }],
    });
    expect(text).toContain("only 28 of 312");
    expect(text).toContain("prove nothing");
  });

  it("says how many categories it checked against, so not_found is falsifiable", () => {
    const text = summarizeReconcile({
      ...base,
      categoriesListed: 204,
      unresolved: [{ raw: "vod_sources", id: null, fullName: null, reason: "not_found" as const }],
    });
    expect(text).toContain("checked against 204 categories");
  });

  it("surfaces a suggestion inline", () => {
    const text = summarizeReconcile({
      ...base,
      categoriesListed: 12,
      unresolved: [{
        raw: "vod_sources", id: null, fullName: null,
        reason: "not_found" as const, suggestions: ["Agentics>VOD Sources"],
      }],
    });
    expect(text).toContain("did you mean Agentics>VOD Sources?");
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
