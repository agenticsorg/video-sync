/**
 * The category-listing memo (ADR-080 §4).
 *
 * Reconciling one entry costs a full category.list — 163 categories on
 * partner 5896392. A backfill over eight records would read it eight
 * times.
 *
 * The cache is an optimisation for a feature whose defining bug was a
 * stale/narrow view of the category list reported as fact. So the
 * property that matters most is not that it caches, but that it gets
 * out of the way the moment a name fails to resolve.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedCategories,
  setCachedCategories,
  invalidateCategoryCache,
} from "../src/lib/kalturaApi";

const PARTNER = "5896392";

beforeEach(() => { invalidateCategoryCache(PARTNER); vi.useRealTimers(); });
afterEach(() => vi.useRealTimers());

describe("the listing memo", () => {
  it("is cold until something is stored", () => {
    expect(getCachedCategories(PARTNER)).toBeUndefined();
  });

  it("returns what was stored, for that partner only", () => {
    setCachedCategories(PARTNER, { categories: [{ id: 1, name: "a", fullName: "a" }] });
    expect(getCachedCategories(PARTNER)).toBeDefined();
    // A second partner must not read the first's listing — category
    // ids are partner-scoped and a cross-partner hit would apply an
    // entry to a category on the wrong account.
    expect(getCachedCategories("999999")).toBeUndefined();
  });

  it("expires, so a category created in the KMC is not invisible for long", () => {
    vi.useFakeTimers();
    setCachedCategories(PARTNER, { categories: [] });
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(getCachedCategories(PARTNER)).toBeDefined();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(getCachedCategories(PARTNER)).toBeUndefined();
  });

  it("can be dropped on demand", () => {
    // This is what the route does the instant a declared name misses
    // against a cached listing: a miss proves nothing until it has
    // been checked against a fresh read. Without it the memo would
    // reproduce the exact bug it is an optimisation for — real
    // categories reported not_found against a listing that was not
    // the truth.
    setCachedCategories(PARTNER, { categories: [] });
    invalidateCategoryCache(PARTNER);
    expect(getCachedCategories(PARTNER)).toBeUndefined();
  });
});
