/**
 * Where large media is staged during a publish.
 *
 * Cloud Run's /tmp is a RAM-backed tmpfs. On 2026-09-24 a publish of a
 * 4.86 GB Drive recording OOM-killed an 8 GiB instance mid-download —
 * "container instance was found to be using too much memory", then
 * signal 9. The fix stages on the FUSE-mounted bucket instead, where
 * gcsfuse streams writes through a 32 MB block budget.
 *
 * The verification that mattered was reading the live mount config
 * (EnableStreamingWrites:true, BlockSizeMb:32, GlobalMaxBlocks:4, empty
 * TempDir) rather than assuming. What is testable here is the path
 * construction and the cleanup contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { stagedPath, stagingDir, discardStaged, TMPFS_MAX_SAFE_BYTES } from "../src/lib/mediaStaging";

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("stagingDir", () => {
  it("prefers the FUSE mount under the working directory", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const { dir, onFuse } = await stagingDir();
    expect(onFuse).toBe(true);
    expect(dir).toContain("/data/staging");
  });

  it("falls back to tmpfs when the mount is absent", async () => {
    // Local dev, or a deployment without the volume. Failing to publish
    // a small file would be worse than publishing it from RAM.
    vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("EROFS: read-only file system"));
    const { dir, onFuse } = await stagingDir();
    expect(onFuse).toBe(false);
    expect(dir).toBe(tmpdir());
  });
});

describe("stagedPath", () => {
  it("lands under the staging prefix the lifecycle rule matches", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const { path } = await stagedPath("video-upload");
    // The bucket expires anything under staging/ after a day; a path
    // outside it would leave multi-GB orphans forever.
    expect(path).toContain("/data/staging/");
    expect(path).toMatch(/video-upload-\d+\.mp4$/);
  });

  it("cannot be walked out of the staging directory", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const { dir } = await stagingDir();
    const { path } = await stagedPath("../../etc/passwd");
    // The invariant that matters is containment, not the absence of
    // dot characters: "/" is replaced, so the result is one filename.
    expect(resolve(path).startsWith(resolve(dir) + "/")).toBe(true);
    expect(path).not.toContain("..");
  });

  it("gives two calls different paths", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const a = await stagedPath("x");
    await new Promise(r => setTimeout(r, 2));
    const b = await stagedPath("x");
    expect(a.path).not.toBe(b.path);
  });
});

describe("discardStaged", () => {
  it("removes the file", async () => {
    const unlink = vi.spyOn(fs, "unlink").mockResolvedValue(undefined);
    await discardStaged("/data/staging/x.mp4");
    expect(unlink).toHaveBeenCalledWith("/data/staging/x.mp4");
  });

  it("does nothing when there is no path", async () => {
    const unlink = vi.spyOn(fs, "unlink").mockResolvedValue(undefined);
    await discardStaged(null);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("never throws — it runs in finally, after the outcome is decided", async () => {
    // A cleanup error must not overwrite the publish's own result.
    vi.spyOn(fs, "unlink").mockRejectedValue(
      Object.assign(new Error("stale file handle"), { code: "ESTALE" }),
    );
    await expect(discardStaged("/data/staging/x.mp4")).resolves.toBeUndefined();
  });

  it("treats an already-gone file as success", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValue(
      Object.assign(new Error("no such file"), { code: "ENOENT" }),
    );
    await expect(discardStaged("/data/staging/x.mp4")).resolves.toBeUndefined();
  });
});

describe("the tmpfs safety bound", () => {
  it("sits far below the container limit, because the file is not alone in memory", () => {
    // Node's heap, concurrent requests, and during a trim a SECOND copy
    // of the file all share the same 8 GiB.
    expect(TMPFS_MAX_SAFE_BYTES).toBe(256 * 1024 * 1024);
    expect(TMPFS_MAX_SAFE_BYTES).toBeLessThan(8 * 1024 ** 3 / 8);
  });

  it("would have rejected the file that caused the OOM", () => {
    const FOUR_POINT_EIGHT_SIX_GB = 4.86 * 1024 ** 3;
    expect(FOUR_POINT_EIGHT_SIX_GB).toBeGreaterThan(TMPFS_MAX_SAFE_BYTES);
  });
});
