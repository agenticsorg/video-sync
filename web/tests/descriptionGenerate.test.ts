/**
 * Tests for the extracted description pipeline — the guard that decides
 * whether an unattended pass may touch a record, and the staleness rule
 * that tells a current description from one the Show Notes moved on
 * beneath.
 *
 * These mirror the Rust tests on `VideoRecord::description_is_regenerable`
 * / `description_is_stale`. Both sides must agree: the aggregate governs
 * the mutation, this side governs whether we attempt it.
 */

import { describe, it, expect } from "vitest";
import {
  describeSkipReason,
  isStale,
  findRecordsNeedingDescription,
} from "../src/lib/descriptionGenerate";
import { isInActiveConsideration } from "../src/lib/catchupOrchestrator";
import type { VideoRecordJSON } from "../src/lib/wasm";

const LONG_TRANSCRIPT = "x".repeat(500);

function makeRecord(overrides: Partial<VideoRecordJSON>): VideoRecordJSON {
  return {
    id: "rec-" + Math.random().toString(36).slice(2, 10),
    source_id: "stub-source",
    source_platform: "Zoom",
    title: "stub",
    description: null,
    duration_seconds: 0,
    participants: [],
    download_url: "stub://",
    thumbnail_url: null,
    tags: [],
    recorded_at: "2026-06-08T00:00:00Z",
    indexed_at: "2026-06-08T00:00:00Z",
    status: "Discovered",
    locations: [],
    upstream_links: [],
    rejected_links: [],
    metadata_extra: null,
    destination_id: null,
    destination_url: null,
    notes: [],
    transcript_text: LONG_TRANSCRIPT,
    summary_doc_id: null,
    summary_prompt_version: null,
    summary_locked: false,
    summary_counts: null,
    ...overrides,
  } as unknown as VideoRecordJSON;
}

/** A record with Show Notes and a description derived from them. */
function derivedRecord(overrides: Partial<VideoRecordJSON> = {}): VideoRecordJSON {
  return makeRecord({
    description: "An existing generated description.",
    description_source: "ShowNotesLlm",
    description_source_doc_id: "doc-1",
    description_source_prompt_version: 3,
    summary_doc_id: "doc-1",
    summary_prompt_version: 3,
    ...overrides,
  });
}

describe("describeSkipReason — what an unattended pass may touch", () => {
  it("SKIPS a locked description", () => {
    const r = derivedRecord({ description_locked: true });
    expect(describeSkipReason(r, "copy_show_notes")).toBe("locked");
  });

  it("SKIPS a hand-written description", () => {
    const r = derivedRecord({ description_source: "Manual" });
    expect(describeSkipReason(r, "copy_show_notes")).toBe("manual");
  });

  it("SKIPS a description with no recorded provenance", () => {
    // Every record written before the fields existed looks like this.
    // Unknown authorship must read as "leave it alone".
    const r = derivedRecord({ description_source: undefined });
    expect(describeSkipReason(r, "copy_show_notes")).toBe("unknown_provenance");
  });

  it("SKIPS a generated description that is still current", () => {
    expect(describeSkipReason(derivedRecord(), "copy_show_notes")).toBe("current");
  });

  it("ALLOWS a record whose Show Notes moved on beneath it", () => {
    const r = derivedRecord({ summary_prompt_version: 4 });
    expect(describeSkipReason(r, "copy_show_notes")).toBeNull();
  });

  it("ALLOWS an empty description regardless of missing provenance", () => {
    const r = makeRecord({ description: null, summary_doc_id: "doc-1" });
    expect(describeSkipReason(r, "copy_show_notes")).toBeNull();
  });

  it("treats a whitespace-only description as empty", () => {
    const r = makeRecord({ description: "   \n  ", summary_doc_id: "doc-1" });
    expect(describeSkipReason(r, "copy_show_notes")).toBeNull();
  });

  it("SKIPS when there is neither Show Notes nor a usable transcript", () => {
    const r = makeRecord({ description: null, summary_doc_id: null, transcript_text: "tiny" });
    expect(describeSkipReason(r, "copy_show_notes")).toBe("no_source_material");
  });

  it("ALLOWS Show-Notes mode to fall back to a transcript (ADR-064)", () => {
    const r = makeRecord({ description: null, summary_doc_id: null });
    expect(describeSkipReason(r, "copy_show_notes")).toBeNull();
  });

  it("SKIPS generate mode without a transcript, even with Show Notes", () => {
    const r = makeRecord({ description: null, summary_doc_id: "doc-1", transcript_text: null });
    expect(describeSkipReason(r, "generate")).toBe("no_source_material");
  });

  it("puts the lock ahead of every other reason", () => {
    const r = makeRecord({
      description: null,
      description_locked: true,
      summary_doc_id: null,
      transcript_text: null,
    });
    expect(describeSkipReason(r, "copy_show_notes")).toBe("locked");
  });
});

describe("isStale — drift from the source Show Notes", () => {
  it("is false when the derived version matches the record's Show Notes", () => {
    expect(isStale(derivedRecord())).toBe(false);
  });

  it("is true after the Show Notes are regenerated under a newer prompt", () => {
    expect(isStale(derivedRecord({ summary_prompt_version: 4 }))).toBe(true);
  });

  it("is true when derived from a different doc than the record now carries", () => {
    expect(isStale(derivedRecord({ summary_doc_id: "doc-2" }))).toBe(true);
  });

  it("tracks the deterministic fallback the same way", () => {
    const r = derivedRecord({
      description_source: "ShowNotesDeterministic",
      summary_prompt_version: 5,
    });
    expect(isStale(r)).toBe(true);
  });

  it("is false for transcript-derived descriptions — no upstream doc", () => {
    const r = derivedRecord({
      description_source: "Transcript",
      description_source_doc_id: null,
      description_source_prompt_version: null,
      summary_prompt_version: 9,
    });
    expect(isStale(r)).toBe(false);
  });

  it("is false for hand-written descriptions", () => {
    const r = derivedRecord({ description_source: "Manual", summary_prompt_version: 9 });
    expect(isStale(r)).toBe(false);
  });

  it("does not call a description stale on missing version information", () => {
    const r = derivedRecord({ description_source_prompt_version: null });
    expect(isStale(r)).toBe(false);
  });

  it("does not treat a removed Show Notes doc as drift", () => {
    // summary_doc_id cleared: the description is orphaned, not stale.
    // Regenerating it would need a source that no longer exists.
    const r = derivedRecord({
      summary_doc_id: null,
      summary_prompt_version: null,
      description_source_doc_id: null,
    });
    expect(isStale(r)).toBe(false);
  });
});

describe("findRecordsNeedingDescription — the pre-flight work list", () => {
  it("classifies an empty description as missing", () => {
    const r = makeRecord({ description: null, summary_doc_id: "doc-1" });
    const work = findRecordsNeedingDescription([r], "copy_show_notes");
    expect(work).toHaveLength(1);
    expect(work[0].reason).toBe("missing");
  });

  it("classifies a drifted description as stale", () => {
    const r = derivedRecord({ summary_prompt_version: 4 });
    const work = findRecordsNeedingDescription([r], "copy_show_notes");
    expect(work).toHaveLength(1);
    expect(work[0].reason).toBe("stale");
  });

  it("excludes everything the guard would skip", () => {
    const records = [
      derivedRecord(),                                        // current
      derivedRecord({ description_locked: true }),            // locked
      derivedRecord({ description_source: "Manual" }),        // manual
      derivedRecord({ description_source: undefined }),       // unknown
      makeRecord({ description: null, summary_doc_id: null, transcript_text: null }),
    ];
    expect(findRecordsNeedingDescription(records, "copy_show_notes")).toHaveLength(0);
  });

  it("returns the records themselves so a driver can act on them", () => {
    const r = derivedRecord({ summary_prompt_version: 4 });
    const work = findRecordsNeedingDescription([r], "copy_show_notes");
    expect(work[0].record.id).toBe(r.id);
  });
});

describe("isInActiveConsideration — the sweep's spending gate", () => {
  it("admits InScope and Approved", () => {
    expect(isInActiveConsideration(makeRecord({ status: "InScope" }))).toBe(true);
    expect(isInActiveConsideration(makeRecord({ status: "Approved" }))).toBe(true);
  });

  it("excludes a record nobody has triaged yet", () => {
    expect(isInActiveConsideration(makeRecord({ status: "Discovered" }))).toBe(false);
  });

  it("excludes records the operator has already ruled out", () => {
    for (const status of ["Skipped", "Abandoned"]) {
      expect(isInActiveConsideration(makeRecord({ status }))).toBe(false);
    }
  });

  it("excludes records that have already shipped or are mid-flight", () => {
    // Published Show Notes can still be refreshed, but that is the
    // Summary Badge Backfill's job — the sweep's budget goes to work
    // still moving.
    for (const status of ["Publishing", "Published", "Failed", "ToRetry"]) {
      expect(isInActiveConsideration(makeRecord({ status }))).toBe(false);
    }
  });

  it("covers every status the aggregate defines", () => {
    // If VideoStatus grows a variant, this forces a decision about
    // which side of the gate it falls on rather than defaulting to
    // "excluded" unnoticed.
    const allStatuses = [
      "Discovered", "InScope", "Approved", "Skipped",
      "Publishing", "Published", "Failed", "Abandoned", "ToRetry",
    ];
    const admitted = allStatuses.filter(s => isInActiveConsideration(makeRecord({ status: s })));
    expect(admitted).toEqual(["InScope", "Approved"]);
  });
});
