/**
 * YouTube upload-quota accounting.
 *
 * Until 2026-09-24 the counter was incremented in exactly one place —
 * BackfillPanel's orchestrator loop — so it counted backfill uploads and
 * nothing else. On 2026-09-23 four "Retry YouTube" publishes spent about
 * 6,400 units and the state file still read uploads_today: 0. The
 * displayed number looked like quota and wasn't, which is worse than
 * showing nothing.
 */

import { describe, it, expect } from "vitest";
import {
  quotaDay,
  snapshot,
  YOUTUBE_MAX_UPLOADS_PER_DAY,
  YOUTUBE_UPLOAD_COST_UNITS,
  YOUTUBE_DAILY_QUOTA_UNITS,
} from "../src/lib/uploadQuota";

describe("the ceiling", () => {
  it("is six uploads — 10,000 units at 1,600 each", () => {
    expect(YOUTUBE_DAILY_QUOTA_UNITS).toBe(10_000);
    expect(YOUTUBE_UPLOAD_COST_UNITS).toBe(1600);
    expect(YOUTUBE_MAX_UPLOADS_PER_DAY).toBe(6);
  });

  it("floors rather than rounds — a partial upload is not an upload", () => {
    expect(YOUTUBE_MAX_UPLOADS_PER_DAY * YOUTUBE_UPLOAD_COST_UNITS)
      .toBeLessThanOrEqual(YOUTUBE_DAILY_QUOTA_UNITS);
  });
});

describe("quotaDay — Pacific, not UTC", () => {
  it("uses the Pacific date when UTC has already rolled over", () => {
    // 2026-09-24T03:00Z is still the 23rd in Los Angeles. The old code
    // used a UTC day and so reset the counter seven hours early,
    // reporting headroom the API would still refuse.
    expect(quotaDay(new Date("2026-09-24T03:00:00Z"))).toBe("2026-09-23");
  });

  it("rolls over at Pacific midnight", () => {
    expect(quotaDay(new Date("2026-09-24T06:59:00Z"))).toBe("2026-09-23");
    expect(quotaDay(new Date("2026-09-24T07:01:00Z"))).toBe("2026-09-24");
  });

  it("returns a plain YYYY-MM-DD", () => {
    expect(quotaDay(new Date("2026-09-24T18:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("snapshot", () => {
  it("reports remaining and units used", () => {
    const s = snapshot({ uploads_today: 4, last_reset_date: "2026-09-24" });
    expect(s.limit).toBe(6);
    expect(s.remaining).toBe(2);
    expect(s.units_used).toBe(6400);   // the four retries of 2026-09-23
  });

  it("never reports negative headroom", () => {
    // Uploads outside our accounting (another client, a manual upload)
    // can push the count past the ceiling. "-2 remaining" would be
    // nonsense to render.
    expect(snapshot({ uploads_today: 8, last_reset_date: "2026-09-24" }).remaining).toBe(0);
  });

  it("reports a full day's headroom when nothing has been uploaded", () => {
    const s = snapshot({ uploads_today: 0, last_reset_date: "2026-09-24" });
    expect(s.remaining).toBe(6);
    expect(s.units_used).toBe(0);
  });
});
