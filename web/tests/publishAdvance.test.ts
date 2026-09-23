/**
 * ADR-079 §1 — the extracted publish orchestration.
 *
 * Before the extraction this logic lived in a closure inside VideoCard
 * and could only be exercised by rendering a React component, so none
 * of it was covered — including the 2026-09-23 regression where a
 * failed destination left no trace on the record. These tests are the
 * payoff for moving it, and the failure-recording one is the regression
 * guard that matters most.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DestinationResult, ExecutePublishReport } from "../src/lib/publish/execute";

// ── Doubles ─────────────────────────────────────────────────────────
// executePublish is the seam: it reports what each destination did, and
// everything under test is the orchestration around that report.

const mutations: Array<{ id: string; kind: string; payload: unknown }> = [];
const postProcessing: Array<{ success: boolean; url?: string; error?: string }> = [];
let executeImpl: () => Promise<ExecutePublishReport>;

vi.mock("../src/lib/publish/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/publish/execute")>();
  return {
    ...actual,
    executePublish: vi.fn(async (req: { onOutcome?: (o: DestinationResult) => void }) => {
      const report = await executeImpl();
      for (const r of report.results) req.onOutcome?.(r);
      return report;
    }),
  };
});

vi.mock("../src/lib/store", () => ({
  videoStore: {
    // Record what command each mutation ran, by inspecting the recorder
    // the callback drives. That is enough to assert "a Failed outcome
    // was written" without standing up WASM.
    mutate: (id: string, fn: (r: Record<string, (p: string) => string>) => string) => {
      const recorder = new Proxy({} as Record<string, (p: string) => string>, {
        get: (_t, kind: string) => (payload: string) => {
          mutations.push({ id, kind, payload: JSON.parse(payload) });
          return "[]";
        },
      });
      return fn(recorder);
    },
  },
}));

vi.mock("../src/lib/useCurrentActor", () => ({
  actorCommand: (_s: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ actor: { user_id: "u1", role: "Admin" }, ...extra }),
}));

vi.mock("../src/lib/processingRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/processingRules")>();
  return {
    ...actual,
    loadPostProcessingRules: () => [],
    firePostProcessingRules: (_r: unknown, success: boolean, _v: unknown, url?: string, error?: string) => {
      postProcessing.push({ success, url, error });
    },
  };
});

const { advanceToPublished } = await import("../src/lib/publish/advance");

// ── Fixtures ────────────────────────────────────────────────────────

const RECORD = {
  id: "rec-1",
  title: "Friday Hackerspace",
  description: "desc",
  tags: ["a"],
  recorded_at: "2026-09-20T14:00:00Z",
  status: "Publishing",
  locations: [],
  upstream_links: [],
} as never;

const ATTRS = {
  title: "Friday Hackerspace — 20 Sep 2026",
  description: "desc",
  tags: ["a"],
  privacy_status: "unlisted",
  trim_start_seconds: 0,
} as never;

function pushed(platform: string, id: string): DestinationResult {
  return {
    spec: { platform, visibility: "public" } as never,
    status: "pushed",
    external_id: id,
    external_url: `https://example.test/${id}`,
  } as DestinationResult;
}

function failed(platform: string, error: string): DestinationResult {
  return { spec: { platform, visibility: "public" } as never, status: "failed", error } as DestinationResult;
}

function report(results: DestinationResult[]): ExecutePublishReport {
  const p = results.filter(r => r.status === "pushed").length;
  const f = results.filter(r => r.status === "failed").length;
  const s = results.filter(r => r.status === "skipped").length;
  return { results, pushed: p, failed: f, skipped: s, anyPushed: p > 0, allPushed: p > 0 && f === 0 };
}

function run(results: DestinationResult[], impl?: () => Promise<ExecutePublishReport>) {
  executeImpl = impl ?? (async () => report(results));
  const events: string[] = [];
  return advanceToPublished({
    record: RECORD,
    targets: results.map(r => r.spec),
    attrs: ATTRS,
    actorState: {} as never,
    creds: {} as never,
    sourceUrlFor: () => "https://example.test/src.mp4",
    onEvent: (m) => events.push(m),
  }).then(result => ({ result, events }));
}

beforeEach(() => {
  mutations.length = 0;
  postProcessing.length = 0;
});

// ── The verdict ─────────────────────────────────────────────────────

describe("advanceToPublished — whole-record verdict", () => {
  it("reports published when every destination lands", async () => {
    const { result } = await run([pushed("YouTube", "yt1"), pushed("Kaltura", "k1")]);
    expect(result.status).toBe("published");
    expect(result.message).toBeUndefined();
    expect(result.lastPushedUrl).toBe("https://example.test/k1");
  });

  it("reports partial when one lands and one fails, naming the failure", async () => {
    // ADR-077 §Decisions-resolved #1: a partial publish IS Published.
    // The operator still has to be told which destination needs work.
    const { result } = await run([pushed("Kaltura", "k1"), failed("YouTube", "invalid_grant")]);
    expect(result.status).toBe("partial");
    expect(result.message).toContain("1 destination(s) failed");
    expect(result.message).toContain("invalid_grant");
  });

  it("reports failed when nothing lands", async () => {
    const { result } = await run([failed("YouTube", "boom"), failed("Kaltura", "nope")]);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("boom");
    expect(result.message).toContain("nope");
  });

  it("reports error when something outside a push breaks", async () => {
    const { result } = await run([], async () => {
      throw new Error("destination resolution exploded");
    });
    expect(result.status).toBe("error");
    expect(result.message).toBe("destination resolution exploded");
  });
});

// ── The 2026-09-23 regression ───────────────────────────────────────

describe("advanceToPublished — a failed destination is recorded ON the record", () => {
  it("writes a Failed outcome, not just an event-log line", async () => {
    // The incident: this call didn't exist. YouTube failed, Kaltura
    // succeeded, and the record held one Pushed outcome — so
    // is_fully_published() saw nothing outstanding and the card left
    // the review queue looking complete.
    await run([pushed("Kaltura", "k1"), failed("YouTube", "invalid_grant")]);

    const failure = mutations.find(
      m => m.kind === "recordDestinationResult"
        && (m.payload as { platform?: string }).platform === "YouTube",
    );
    expect(failure).toBeDefined();
    expect((failure!.payload as { error?: string }).error).toBe("invalid_grant");
  });

  it("does NOT add a Destination location for a failed push", async () => {
    // A failed push must never leave the record claiming the video is
    // on that platform.
    await run([failed("YouTube", "invalid_grant")]);
    const locationAdds = mutations.filter(m => m.kind === "add_location");
    expect(locationAdds).toHaveLength(0);
  });

  it("still records the peer that succeeded", async () => {
    await run([pushed("Kaltura", "k1"), failed("YouTube", "invalid_grant")]);
    const success = mutations.find(
      m => m.kind === "recordDestinationResult"
        && (m.payload as { platform?: string }).platform === "Kaltura",
    );
    expect((success!.payload as { external_id?: string }).external_id).toBe("k1");
    expect((success!.payload as { error?: string }).error).toBeUndefined();
  });

  it("emits a VideoPublishFailed event alongside the recorded outcome", async () => {
    const { events } = await run([pushed("Kaltura", "k1"), failed("YouTube", "invalid_grant")]);
    expect(events.some(e => e.startsWith("VideoPublishFailed:") && e.includes("invalid_grant"))).toBe(true);
  });
});

// ── Post-processing rules (ADR-024) ─────────────────────────────────

describe("advanceToPublished — post-processing rules fire once, with the right verdict", () => {
  it("fires success with the last pushed URL on a clean publish", async () => {
    await run([pushed("YouTube", "yt1")]);
    expect(postProcessing).toEqual([{ success: true, url: "https://example.test/yt1", error: undefined }]);
  });

  it("fires success on a PARTIAL publish — something did land", async () => {
    await run([pushed("Kaltura", "k1"), failed("YouTube", "invalid_grant")]);
    expect(postProcessing).toHaveLength(1);
    expect(postProcessing[0].success).toBe(true);
  });

  it("fires failure, with detail, when nothing landed", async () => {
    await run([failed("YouTube", "boom")]);
    expect(postProcessing).toHaveLength(1);
    expect(postProcessing[0].success).toBe(false);
    expect(postProcessing[0].error).toContain("boom");
  });

  it("marks the record Failed when nothing landed", async () => {
    await run([failed("YouTube", "boom")]);
    expect(mutations.some(m => m.kind === "mark_failed")).toBe(true);
  });
});
