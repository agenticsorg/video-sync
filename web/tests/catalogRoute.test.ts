/**
 * Tests for the defensive guard in web/src/app/api/catalog/route.ts —
 * specifically that `readCatalog` coerces wrong-type `records` /
 * `lastModified` values to `{}` instead of returning them as-is.
 *
 * Background: 2026-06-07 incident — a Python migration clobbered
 * `lastModified` from an object to a single ISO string, and every
 * subsequent POST /api/catalog threw `TypeError: Cannot create
 * property '<id>' on string '...'`. The route now type-checks the
 * deserialized JSON before returning the store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";

const ROUTE_MODULE = "../src/app/api/catalog/route";

async function importRoute() {
  vi.resetModules();
  return await import(ROUTE_MODULE);
}

function makeGetReq(): Request {
  return new Request("https://example.com/api/catalog", { method: "GET" });
}

function makePostReq(body: unknown): Request {
  return new Request("https://example.com/api/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("catalog/route readCatalog — shape guard (incident 2026-06-07)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.ALLOW_NO_IAP;
  });

  it("returns the parsed store unchanged when both fields are plain objects", async () => {
    const good = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: { "abc": "2026-06-07T15:50:49Z" },
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(good));
    const mod = await importRoute();
    // GET handler returns whatever readCatalog returns
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual(good.records);
    expect(body.lastModified).toEqual(good.lastModified);
  });

  it("coerces a string `lastModified` (the actual incident shape) to {}", async () => {
    const corrupt = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: "2026-06-07T15:50:49+00:00Z",  // <-- the bug
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual(corrupt.records);  // records intact
    expect(body.lastModified).toEqual({});           // string coerced to {}
  });

  it("coerces an array `records` to {} (defends against the symmetric case)", async () => {
    const corrupt = {
      records: ["not", "an", "object"],
      lastModified: {},
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.records).toEqual({});
    expect(body.lastModified).toEqual({});
  });

  it("coerces a null `lastModified` to {}", async () => {
    const corrupt = {
      records: {},
      lastModified: null,
    };
    vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(corrupt));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body.lastModified).toEqual({});
  });

  it("returns the empty store when the file doesn't exist (ENOENT path)", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("ENOENT"));
    const mod = await importRoute();
    const res = await mod.GET(makeGetReq() as never);
    const body = await res.json();
    expect(body).toEqual({ records: {}, lastModified: {} });
  });

  it("POST after recovering from a corrupt lastModified now succeeds", async () => {
    // First call reads the corrupt file...
    const corrupt = {
      records: { "abc": '{"id":"abc"}' },
      lastModified: "2026-06-07T15:50:49+00:00Z",
    };
    let stored = JSON.stringify(corrupt);
    vi.spyOn(fs, "readFile").mockImplementation(async () => stored);
    vi.spyOn(fs, "writeFile").mockImplementation(async (_path, data) => {
      stored = String(data);
    });
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    // POST requires an actor (ADR-065 role-scoped writes); GET degrades to
    // unfiltered when auth is absent, so only this test needs dev-mode auth.
    // ALLOW_NO_IAP=1 yields DEV_ACTOR (Admin) so the request reaches the
    // shape-guard logic under test rather than short-circuiting at 401.
    process.env.ALLOW_NO_IAP = "1";
    const mod = await importRoute();

    const req = makePostReq({
      id: "xyz-record",
      json: JSON.stringify({ id: "xyz-record" }),
      lastModified: "2026-06-07T20:00:00Z",
    });
    // Cast Request → NextRequest at the boundary; the route only
    // reads .json() which both have.
    const res = await mod.POST(req as never);
    expect(res.status).toBe(200);
    // The on-disk shape after the write should be self-healed:
    const written = JSON.parse(stored);
    expect(written.lastModified).toEqual({ "xyz-record": "2026-06-07T20:00:00Z" });
    expect(written.records["xyz-record"]).toBeTruthy();
  });
});

/**
 * Incident 2026-09-23 — catalog truncated from 197 records to 1.
 *
 * gcsfuse threw `ReadFile: stale file handle … catalog.json was modified
 * or deleted by another process`. readCatalog's bare catch turned that
 * into an empty store, the in-flight POST merged one record onto it, and
 * writeCatalog persisted the result. Two seconds, no error, 196 records
 * gone.
 *
 * The rule these lock in: a FAILED read must never be indistinguishable
 * from an EMPTY catalog on any path that then writes.
 */
describe("catalog write path — never merge onto a failed read (incident 2026-09-23)", () => {
  const POPULATED = JSON.stringify({
    records: { a: '{"id":"a"}', b: '{"id":"b"}', c: '{"id":"c"}' },
    lastModified: { a: "2026-09-23T12:00:00Z", b: "2026-09-23T12:00:00Z", c: "2026-09-23T12:00:00Z" },
  });

  function errno(code: string): NodeJS.ErrnoException {
    const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ALLOW_NO_IAP = "1";
  });

  afterEach(() => {
    delete process.env.ALLOW_NO_IAP;
  });

  it("REFUSES the write and never calls writeFile when the read fails", async () => {
    // Both the initial read and the retry fail.
    vi.spyOn(fs, "readFile").mockRejectedValue(errno("ESTALE"));
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(res.status).toBe(503);
    // The assertion that matters: nothing was persisted.
    expect(write).not.toHaveBeenCalled();
  });

  it("REFUSES the write when the file is unparseable (a torn read)", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue('{"records": {"a": "trunc');
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(res.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });

  it("retries once before giving up — a stale handle usually clears", async () => {
    const read = vi.spyOn(fs, "readFile")
      .mockRejectedValueOnce(errno("ESTALE"))
      .mockResolvedValueOnce(POPULATED);
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(read).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    // All three prior records survived the merge, plus the new one.
    const persisted = JSON.parse((write.mock.calls[0][1] as string));
    expect(Object.keys(persisted.records).sort()).toEqual(["a", "b", "c", "x"]);
  });

  it("still writes normally when the read succeeds", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(POPULATED);
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(res.status).toBe(200);
    const persisted = JSON.parse((write.mock.calls[0][1] as string));
    expect(Object.keys(persisted.records)).toHaveLength(4);
  });

  it("lets a genuinely fresh deployment start empty (ENOENT, nothing seen yet)", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(errno("ENOENT"));
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(res.status).toBe(200);
    const persisted = JSON.parse((write.mock.calls[0][1] as string));
    expect(Object.keys(persisted.records)).toEqual(["x"]);
  });

  it("treats ENOENT as a FAILURE once records have been seen", async () => {
    // This is the gcsfuse case: `gcs.NotFoundError: storage: object
    // doesn't exist` can reach us as ENOENT, and after a populated read
    // it means the object was lost, not that the deployment is new.
    const mod = await importRoute();
    const store = await import("../src/lib/catalogStore");

    vi.spyOn(fs, "readFile").mockResolvedValueOnce(POPULATED);
    await store.readCatalog();               // latch: we have seen records

    vi.spyOn(fs, "readFile").mockRejectedValue(errno("ENOENT"));
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const res = await mod.POST(makePostReq({ id: "x", json: '{"id":"x"}' }) as never);

    expect(res.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a DELETE against an unreadable catalog too", async () => {
    // Delete-from-empty-then-write persists the truncation just as
    // effectively as the POST path did.
    vi.spyOn(fs, "readFile").mockRejectedValue(errno("EIO"));
    const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);

    const mod = await importRoute();
    const req = new Request("https://example.com/api/catalog?id=a", { method: "DELETE" });
    const res = await mod.DELETE(req as never);

    expect(res.status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });
});
