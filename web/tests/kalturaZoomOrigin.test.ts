/**
 * Kaltura entries ingested by the Zoom connector carry their origin.
 *
 * Observed in the KMC on entry 1_b8kw2g8u:
 *
 *   Reference ID: Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
 *
 * ADR-044 deferred origin matching for such entries to "fuzzy title +
 * recorded-at match". It never needed to be fuzzy — the connector
 * writes the Zoom meeting UUID and the recording start time, and our
 * Zoom records are keyed on that same UUID.
 */

import { describe, it, expect } from "vitest";
import {
  parseZoomReferenceId,
  classifyReferenceId,
  findZoomOriginRecord,
  type OriginMatchRecord,
} from "../src/lib/kalturaZoomOrigin";

/** Verbatim from the KMC, entry 1_b8kw2g8u. */
const REAL = "Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z";

describe("parseZoomReferenceId — the observed value", () => {
  it("splits the real reference id into uuid and recording start", () => {
    expect(parseZoomReferenceId(REAL)).toEqual({
      meeting_uuid: "B7JsLl3USqCiZtsrC0FvKw==",
      source_id: "zoom-B7JsLl3USqCiZtsrC0FvKw==",
      download_url: "zoom://recording/B7JsLl3USqCiZtsrC0FvKw==",
      recorded_at: "2026-09-25T15:45:02Z",
    });
  });

  it("keeps the base64 padding as part of the uuid", () => {
    // `==` is padding, not a separator. Splitting on it would yield
    // a uuid that matches no Zoom record.
    expect(parseZoomReferenceId(REAL)!.meeting_uuid).toMatch(/==$/);
  });
});

describe("parseZoomReferenceId — uuids that break naive parsing", () => {
  // These are real source_ids from the catalog. Both contain
  // characters that a sloppier parser would trip on.
  it("handles a uuid containing a forward slash", () => {
    const ref = "Zoom_63IjvIEHTsqZf5Nt/5mZbA==2026-08-20T15:45:01Z";
    expect(parseZoomReferenceId(ref)!.meeting_uuid).toBe("63IjvIEHTsqZf5Nt/5mZbA==");
  });

  it("handles a uuid containing plus signs", () => {
    const ref = "Zoom_GH+WEUvhRR+Ax9rLBu9vlA==2026-08-13T15:45:19Z";
    expect(parseZoomReferenceId(ref)!.source_id).toBe("zoom-GH+WEUvhRR+Ax9rLBu9vlA==");
  });

  it("handles fractional seconds on the instant", () => {
    const ref = "Zoom_QoIOK/sXRY22mCCZtMxCkw==2026-09-03T15:47:03.500Z";
    expect(parseZoomReferenceId(ref)!.recorded_at).toBe("2026-09-03T15:47:03.500Z");
  });
});

describe("parseZoomReferenceId — what it must refuse", () => {
  it("refuses a bare catalog uuid, which is what WE write", () => {
    // ADR-044: this app sets referenceId to the catalog id on publish.
    expect(parseZoomReferenceId("833b9f16-e4ca-449b-afff-c683818e0757")).toBeNull();
  });

  it("refuses a Zoom-prefixed value with no trailing instant", () => {
    expect(parseZoomReferenceId("Zoom_B7JsLl3USqCiZtsrC0FvKw==")).toBeNull();
  });

  it("refuses empty, null and unrelated values", () => {
    expect(parseZoomReferenceId(null)).toBeNull();
    expect(parseZoomReferenceId("")).toBeNull();
    expect(parseZoomReferenceId("   ")).toBeNull();
    expect(parseZoomReferenceId("some-other-system-id")).toBeNull();
  });
});

describe("classifyReferenceId", () => {
  it("tells our own stamp from the connector's", () => {
    expect(classifyReferenceId("833b9f16-e4ca-449b-afff-c683818e0757")).toBe("ours");
    expect(classifyReferenceId(REAL)).toBe("zoom");
  });

  it("reports an unrecognised stamp as foreign rather than guessing", () => {
    expect(classifyReferenceId("SomeOtherConnector_12345")).toBe("foreign");
  });

  it("reports absence distinctly from foreignness", () => {
    // The ADR-044 sweep treats both as "no match", but they mean
    // different things: absent invites a publish, foreign means
    // something else already ingested this entry.
    expect(classifyReferenceId(null)).toBe("absent");
    expect(classifyReferenceId("")).toBe("absent");
  });
});

describe("findZoomOriginRecord", () => {
  const records: OriginMatchRecord[] = [
    { id: "aaa", source_platform: "Zoom", source_id: "zoom-B7JsLl3USqCiZtsrC0FvKw==" },
    { id: "bbb", source_platform: "Zoom", source_id: "zoom-QoIOK/sXRY22mCCZtMxCkw==" },
    { id: "ccc", source_platform: "YouTube", source_id: "youtube-B7JsLl3USqCiZtsrC0FvKw==" },
  ];

  it("matches by identity", () => {
    const origin = parseZoomReferenceId(REAL)!;
    expect(findZoomOriginRecord(origin, records)!.id).toBe("aaa");
  });

  it("does not match a same-id record on another platform", () => {
    const origin = parseZoomReferenceId(REAL)!;
    expect(findZoomOriginRecord(origin, [records[2]])).toBeNull();
  });

  it("returns null when we simply do not hold that Zoom recording", () => {
    // A real and common answer: the catalog holds 15 Zoom records,
    // while the Kaltura originals predate Zoom's retention window.
    // Null must stay null rather than degrading to a fuzzy guess.
    const origin = parseZoomReferenceId("Zoom_zzzzzzzzzzzzzzzzzzzzzz==2025-02-06T10:00:00Z")!;
    expect(findZoomOriginRecord(origin, records)).toBeNull();
  });
});

describe("the recorded_at correction", () => {
  it("is earlier than the ingest timestamp we currently store", () => {
    // Entry 1_b8kw2g8u is stored with recorded_at 2026-09-25T18:13:49Z,
    // taken from Kaltura's createdAt — when Kaltura ingested it. The
    // meeting started 2h28m earlier. Date gates (ADR-048), show
    // windows (ADR-060) and the Overview all read that field.
    const storedIngestTime = Date.parse("2026-09-25T18:13:49Z");
    const trueStart = Date.parse(parseZoomReferenceId(REAL)!.recorded_at);
    expect(trueStart).toBeLessThan(storedIngestTime);
    expect(storedIngestTime - trueStart).toBeGreaterThan(2 * 60 * 60 * 1000);
  });
});
