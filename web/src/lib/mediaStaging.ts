/**
 * Where large media gets staged during a publish.
 *
 * Server-only: do not import from client components.
 *
 * Cloud Run's /tmp is a RAM-backed tmpfs, so every byte written there
 * counts against the container's memory. On 2026-09-24 a publish of a
 * 4.86 GB Drive recording OOM-killed an 8 GiB instance mid-download:
 *
 *     "container instance was found to be using too much memory
 *      and was terminated"
 *     Container terminated on signal 9
 *
 * The bucket already mounted at /app/data is not RAM. Cloud Run's gcsfuse
 * runs with streaming writes on and a small block budget —
 *
 *     Write:{ BlockSizeMb:32  GlobalMaxBlocks:4  MaxBlocksPerFile:1
 *             EnableStreamingWrites:true }
 *     FileSystem:{ TempDir: }        (no local staging directory)
 *
 * — so a 7 GB file streams through about 32 MB of buffer instead of
 * materialising in memory. That is the whole reason this module exists.
 *
 * Staged files are deleted after use. Because the mount is a real GCS
 * bucket, an orphan left by a crash is a real (and large) object, so the
 * bucket also carries a lifecycle rule expiring anything under
 * `staging/` after a day — belt as well as braces.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { serverLog } from "./serverLogger";

/** Prefix inside the FUSE bucket. Matched by the staging lifecycle rule. */
const STAGING_SUBDIR = "staging";

/**
 * Anything at or above this size must not go to tmpfs. Well under the
 * 8 GiB container limit, because the download is not the only thing
 * using memory — Node's heap, other concurrent requests, and (when a
 * trim runs) a second copy of the file all share it.
 */
export const TMPFS_MAX_SAFE_BYTES = 256 * 1024 * 1024;

/**
 * The staging directory.
 *
 * Prefers the FUSE mount. Falls back to tmpdir() when the mount is
 * absent — local dev, and any deployment without the volume — because
 * failing to publish is worse than publishing a small file from RAM.
 */
export async function stagingDir(): Promise<{ dir: string; onFuse: boolean }> {
  const fuseDir = join(process.cwd(), "data", STAGING_SUBDIR);
  try {
    await fs.mkdir(fuseDir, { recursive: true });
    return { dir: fuseDir, onFuse: true };
  } catch (err) {
    serverLog("warn", "lib:mediaStaging", "fuse-staging-unavailable", {
      fuseDir,
      error: err instanceof Error ? err.message : String(err),
      fallback: "tmpfs",
    });
    return { dir: tmpdir(), onFuse: false };
  }
}

/** A staged path. `label` only aids identifying orphans in the bucket. */
export async function stagedPath(label: string): Promise<{ path: string; onFuse: boolean }> {
  const { dir, onFuse } = await stagingDir();
  // Replacing "/" already prevents traversal — the result is a single
  // filename — but collapsing runs of dots keeps the bucket listing
  // readable and avoids a name that merely looks alarming.
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").slice(0, 60);
  return { path: join(dir, `${safe}-${Date.now()}.mp4`), onFuse };
}

/**
 * Delete a staged file. Never throws — this runs in `finally` blocks
 * where the publish has already succeeded or failed on its own terms,
 * and a cleanup error must not overwrite that outcome.
 */
export async function discardStaged(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await fs.unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Worth a line: on the FUSE mount this leaves a multi-GB object
    // behind until the lifecycle rule sweeps it.
    serverLog("warn", "lib:mediaStaging", "staged-file-not-removed", { path, code });
  }
}
