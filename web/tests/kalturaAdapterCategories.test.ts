/**
 * The Kaltura adapter applies the series' declared categories.
 *
 * It previously sent them on the upload body as
 *   category_ids.map(Number).filter(n => !Number.isNaN(n))
 * which emptied the array for every value the registry actually holds
 * (they are names, not ids), so /api/kaltura/upload skipped the field
 * and no Kaltura publish ever carried a category.
 *
 * They now go through /api/kaltura/categories after the upload, which
 * resolves names, mints a KS with disableentitlement, and is additive
 * and idempotent. These pin the contract that matters: the categories
 * are attempted, and a category failure never fails a publish whose
 * media already landed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kalturaAdapter } from "../src/lib/publish/adapters/kaltura";
import type { PushRequest } from "../src/lib/publish/types";
import type { VideoRecordJSON } from "../src/lib/wasm";

const ENTRY = "1_yhs8i4rb";
const DECLARED = [
  "@zoomCategory@",
  "2361952EPea2653e>site>channels>Agentics.org Video Portal",
  "mediaspace_8DEe6>site>channels>Ai Hackerspace Live Recordings",
  "mediaspace_8DEe6>site>galleries>Weekly Recordings",
];

const record = { id: "833b9f16-e4ca-449b-afff-c683818e0757", title: "Friday Hackerspace" } as VideoRecordJSON;

function req(categoryIds?: string[]): PushRequest {
  return {
    record,
    spec: { platform: "Kaltura", visibility: "members", ...(categoryIds ? { category_ids: categoryIds } : {}) },
    attrs: { title: "t", description: "d", tags: [] },
    sourceUrl: "https://example.com/v.mp4",
    creds: { source: {} },
  };
}

/** Route /api/kaltura/upload and /api/kaltura/categories separately. */
function mockFetch(categoriesResponse: { ok: boolean; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    if (url === "/api/kaltura/upload") {
      return { ok: true, json: async () => ({ entryId: ENTRY, playerUrl: `https://video.agentics.org/media/t/${ENTRY}` }) };
    }
    return { ok: categoriesResponse.ok, json: async () => categoriesResponse.body };
  }));
  return calls;
}

const clean = {
  ok: true,
  body: { entryId: ENTRY, added: DECLARED.map(raw => ({ raw, id: 1, fullName: raw })), alreadyPresent: [], unresolved: [], failed: [] },
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("kalturaAdapter — categories", () => {
  it("sends the declared names verbatim, not coerced to numbers", () => {
    // The whole bug in one assertion: these values must survive.
    const calls = mockFetch(clean);
    return kalturaAdapter.push(req(DECLARED)).then(() => {
      const cat = calls.find(c => c.url === "/api/kaltura/categories");
      expect(cat).toBeDefined();
      expect(cat!.body.declared).toEqual(DECLARED);
      expect(cat!.body.entryId).toBe(ENTRY);
    });
  });

  it("no longer puts categoryIds on the upload body", () => {
    const calls = mockFetch(clean);
    return kalturaAdapter.push(req(DECLARED)).then(() => {
      const up = calls.find(c => c.url === "/api/kaltura/upload");
      expect(up!.body).not.toHaveProperty("categoryIds");
    });
  });

  it("reports categories_applied on a clean run", async () => {
    mockFetch(clean);
    const res = await kalturaAdapter.push(req(DECLARED));
    expect(res.external_id).toBe(ENTRY);
    expect(res.categories_applied).toBe(true);
    expect(res.categories_error).toBeUndefined();
  });

  it("does not call the category route when the series declares none", async () => {
    const calls = mockFetch(clean);
    await kalturaAdapter.push(req());
    expect(calls.map(c => c.url)).toEqual(["/api/kaltura/upload"]);
  });

  it("does NOT fail the publish when categories cannot be applied", async () => {
    // The media is on Kaltura by this point. Throwing here would mark
    // a successful upload as a failed publish and invite a re-upload
    // of a multi-GB file to fix a category.
    mockFetch({ ok: false, body: { error: "Kaltura session.start returned no usable KS" } });
    const res = await kalturaAdapter.push(req(DECLARED));
    expect(res.external_id).toBe(ENTRY);
    expect(res.categories_applied).toBe(false);
    expect(res.categories_error).toContain("no usable KS");
  });

  it("reports an incomplete reconcile rather than claiming success", async () => {
    mockFetch({
      ok: true,
      body: {
        entryId: ENTRY, added: [], alreadyPresent: [], failed: [],
        categoriesListed: 163,
        unresolved: [{ raw: "vod_sources", id: null, fullName: null, reason: "ambiguous", matchCount: 11 }],
      },
    });
    const res = await kalturaAdapter.push(req(["vod_sources"]));
    expect(res.categories_applied).toBe(false);
    expect(res.categories_error).toContain("matches 11 categories");
  });

  it("survives a network error on the category call", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/kaltura/upload") {
        return { ok: true, json: async () => ({ entryId: ENTRY, playerUrl: "" }) };
      }
      throw new Error("network down");
    }));
    const res = await kalturaAdapter.push(req(DECLARED));
    expect(res.external_id).toBe(ENTRY);
    expect(res.categories_applied).toBe(false);
    expect(res.categories_error).toContain("network down");
  });

  it("still fails the publish when the UPLOAD fails", async () => {
    // The carve-out is for categories only; a genuine push failure
    // must still surface as one.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "boom" }) })));
    await expect(kalturaAdapter.push(req(DECLARED))).rejects.toThrow("boom");
  });
});
