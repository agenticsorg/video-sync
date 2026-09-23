/**
 * ADR-077 follow-up — the YouTube grant pre-flight.
 *
 * Incident 2026-09-23: the grant had expired, YouTube failed deep inside
 * the upload, Kaltura had already been pushed, and the record ended up
 * half-published. These pin the two rules that stop that repeating:
 *
 *   - a grant we KNOW is bad blocks the publish before anything moves
 *   - a check we could not complete does NOT block, because "I couldn't
 *     ask Google" is not evidence the grant is expired
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertGrantForPublish,
  getGrant,
  getGrantCached,
  grantWarning,
  refreshGrant,
  type GrantStatus,
} from "../src/lib/youtubeGrant";

function mockGrantResponse(body: GrantStatus, ok = true) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
}

describe("assertGrantForPublish — the blocking pre-flight", () => {
  beforeEach(() => {
    refreshGrant();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("allows the publish when the grant is live", async () => {
    mockGrantResponse({ valid: true, expires_in: 3599 });
    expect(await assertGrantForPublish()).toBeNull();
  });

  it("BLOCKS on an expired grant, and says nothing was published", async () => {
    mockGrantResponse({ valid: false, reason: "invalid_grant", needs_reauth: true });
    const problem = await assertGrantForPublish();
    expect(problem).toContain("expired");
    // The operator's first question after a blocked publish is "did any
    // of it go out?" — the message has to answer it.
    expect(problem).toContain("Nothing has been published yet");
  });

  it("BLOCKS when YouTube was never connected", async () => {
    mockGrantResponse({ valid: false, reason: "no_credentials", needs_reauth: true });
    expect(await assertGrantForPublish()).toContain("isn't connected");
  });

  it("does NOT block when the check itself could not reach Google", async () => {
    // The critical asymmetry. Failing to ask is not a failed grant, and
    // blocking on our own outage would be a worse failure than the one
    // this guard exists to prevent.
    mockGrantResponse({ valid: false, reason: "network", detail: "ECONNRESET" });
    expect(await assertGrantForPublish()).toBeNull();
  });

  it("does NOT block when the grant endpoint itself errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    expect(await assertGrantForPublish()).toBeNull();
  });

  it("does NOT block when fetch throws outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await assertGrantForPublish()).toBeNull();
  });

  it("blocks on a non-invalid_grant OAuth error, surfacing the detail", async () => {
    mockGrantResponse({ valid: false, reason: "oauth_error", detail: "unauthorized_client" });
    const problem = await assertGrantForPublish();
    expect(problem).toContain("unauthorized_client");
  });

  it("always re-checks rather than trusting the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await getGrant();                 // warm
    await assertGrantForPublish();    // must not reuse it
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getGrant caching", () => {
  beforeEach(() => {
    refreshGrant();
    vi.unstubAllGlobals();
  });

  it("serves a warm cache without re-requesting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await getGrant();
    await getGrant();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([getGrant(), getGrant(), getGrant()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports null from the cache before anything has been checked", () => {
    expect(getGrantCached()).toBeNull();
  });
});

describe("grantWarning — the passive card advisory", () => {
  it("says nothing when the grant is valid", () => {
    expect(grantWarning({ valid: true })).toBeNull();
  });

  it("says nothing when nothing has been checked yet", () => {
    expect(grantWarning(null)).toBeNull();
  });

  it("says nothing when the check failed — unknown is not expired", () => {
    expect(grantWarning({ valid: false, reason: "network" })).toBeNull();
  });

  it("names an expired authorisation", () => {
    expect(grantWarning({ valid: false, reason: "invalid_grant" })).toBe("YouTube authorisation expired");
  });

  it("distinguishes never-connected from expired", () => {
    expect(grantWarning({ valid: false, reason: "no_credentials" })).toBe("YouTube not connected");
  });
});
