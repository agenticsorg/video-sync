/**
 * Server-side catalog store (ADR-035 Level 2).
 *
 * Extracted from app/api/catalog/route.ts: a Next.js route module may only
 * export request handlers and a fixed set of config values, so exporting
 * readCatalog from there violated the route contract and failed the
 * generated route-type check — which is what blocked `deploy.sh`'s
 * pre-flight. Five modules import readCatalog, so it belongs in lib.
 *
 * Server-only — never import from a client component.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { serverLog } from "./serverLogger";

const CATALOG_FILE = join(process.cwd(), "data", "catalog.json");

export interface CatalogStore {
  records: Record<string, string>;
  lastModified: Record<string, string>;
}

// In-process mutex. Node's event loop is single-threaded but the
// read-merge-write cycle awaits between steps, so two concurrent
// requests can interleave and overwrite each other. Serializing
// ensures the bulk initial push from a fresh browser doesn't lose
// records. (Limitation: across Cloud Run instances this lock is
// per-instance — multi-instance race remains until ADR-035 Tier 2 SQLite.)
let writeQueue: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The catalog could not be read. Distinct from "the catalog is empty",
 * and that distinction is the whole point of this class.
 *
 * Incident 2026-09-23: gcsfuse threw `ReadFile: stale file handle …
 * catalog.json was modified or deleted by another process, possibly due
 * to concurrent modification`. The old bare `catch { return {records:{}} }`
 * turned that into "the catalog is empty", the in-flight POST merged one
 * record onto that empty base, and writeCatalog rewrote 197 records down
 * to 1 — two seconds after the read error, silently.
 *
 * A lost write is recoverable; a truncated catalog is not. Callers that
 * merge-and-write MUST let this propagate rather than writing.
 */
export class CatalogUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Catalog could not be read (${reason}). Refusing to proceed — ` +
          `treating a failed read as an empty catalog is how records get lost.`);
    this.name = "CatalogUnavailableError";
  }
}

/**
 * Have we ever successfully read a catalog with records in it, in this
 * process?
 *
 * This is what makes ENOENT safe to interpret. A genuinely fresh
 * deployment has no catalog.json and must be allowed to start empty.
 * But gcsfuse surfaces a lost/stale object as `gcs.NotFoundError:
 * storage: object doesn't exist` — which can reach us as ENOENT too,
 * and is emphatically NOT "this deployment is new".
 *
 * Once we have seen records, "the file isn't there" stops being a
 * plausible steady state and becomes a failure.
 */
let sawPopulatedCatalog = false;

/** One retry, because a stale FUSE handle usually clears immediately. */
const READ_RETRY_DELAY_MS = 150;

async function readRaw(): Promise<string | null> {
  try {
    return await fs.readFile(CATALOG_FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !sawPopulatedCatalog) {
      return null;  // genuinely fresh deployment
    }
    // Everything else — EIO, ESTALE, EACCES, or an ENOENT after we know
    // records existed — gets one retry before we give up.
    await new Promise(r => setTimeout(r, READ_RETRY_DELAY_MS));
    try {
      return await fs.readFile(CATALOG_FILE, "utf-8");
    } catch (retryErr) {
      const retryCode = (retryErr as NodeJS.ErrnoException).code;
      if (retryCode === "ENOENT" && !sawPopulatedCatalog) return null;
      serverLog("error", "lib:catalogStore", "catalog-read-failed", {
        code: retryCode, saw_populated: sawPopulatedCatalog,
        message: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
      throw new CatalogUnavailableError(retryCode ?? "read-error");
    }
  }
}

export async function readCatalog(): Promise<CatalogStore> {
  const raw = await readRaw();
  if (raw === null) {
    return { records: {}, lastModified: {} };
  }
  let parsed: Partial<CatalogStore>;
  try {
    parsed = JSON.parse(raw) as Partial<CatalogStore>;
  } catch (err) {
    // A torn read yields invalid JSON. Previously this also became an
    // empty catalog — same truncation path as a failed read.
    serverLog("error", "lib:catalogStore", "catalog-parse-failed", {
      bytes: raw.length,
      message: err instanceof Error ? err.message : String(err),
    });
    throw new CatalogUnavailableError("unparseable");
  }
  {
    // Defensive: an out-of-band script could clobber these fields to
    // the wrong type and every subsequent write would TypeError on
    // property assignment. Coerce wrong-type values to {} and warn —
    // the route then self-heals on the next successful write.
    // See ADR-035; incident 2026-06-07 (`lastModified` clobbered to
    // a string by a Python migration → all POSTs 500'd silently).
    let records: Record<string, string> = {};
    if (isPlainObject(parsed.records)) {
      records = parsed.records as Record<string, string>;
    } else if (parsed.records !== undefined) {
      serverLog("warn", "lib:catalogStore", "records-shape-corrupt", { actualType: typeof parsed.records, coercedTo: "{}" });
    }
    let lastModified: Record<string, string> = {};
    if (isPlainObject(parsed.lastModified)) {
      lastModified = parsed.lastModified as Record<string, string>;
    } else if (parsed.lastModified !== undefined) {
      serverLog("warn", "lib:catalogStore", "lastModified-shape-corrupt", { actualType: typeof parsed.lastModified, coercedTo: "{}" });
    }
    // Latch once we've seen real records, so a later "file not found"
    // reads as the failure it is rather than as a fresh deployment.
    if (Object.keys(records).length > 0) sawPopulatedCatalog = true;
    return { records, lastModified };
  }
}

/** Test seam — reset the populated latch between cases. */
export function __resetCatalogLatchForTests(): void {
  sawPopulatedCatalog = false;
}

export async function writeCatalog(store: CatalogStore) {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(CATALOG_FILE, JSON.stringify(store), "utf-8");
}

