"use client";

/**
 * ADR-078 — client accessor for the Drive source-folder registry.
 *
 * Mirrors seriesRegistryClient's shape: an async fetch warmed once,
 * plus a synchronous cached read for render paths that can't await.
 */

import type {
  DriveSourceFolder,
  DriveSourceListResponse,
} from "./driveSources";

export interface DriveSourcesSnapshot {
  folders: DriveSourceFolder[];
  /** The runtime SA's address, for the "share the folder with…" hint.
   *  Absent on a dev box running under user ADC. */
  service_account?: string | null;
}

const EMPTY: DriveSourcesSnapshot = { folders: [] };

let cache: DriveSourcesSnapshot | null = null;
let inflight: Promise<DriveSourcesSnapshot> | null = null;

async function fetchOnce(): Promise<DriveSourcesSnapshot> {
  try {
    const res = await fetch("/api/drive/sources", { cache: "no-store" });
    if (!res.ok) return { ...EMPTY };
    const data = (await res.json()) as Partial<DriveSourcesSnapshot>;
    return {
      folders: Array.isArray(data.folders) ? data.folders : [],
      service_account: data.service_account ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function getDriveSources(): Promise<DriveSourcesSnapshot> {
  if (cache) return cache;
  if (!inflight) inflight = fetchOnce().then(v => { cache = v; inflight = null; return v; });
  return inflight;
}

/** Cached read; empty until the first fetch resolves. */
export function getDriveSourcesCached(): DriveSourcesSnapshot {
  return cache ?? EMPTY;
}

export function refreshDriveSources(): void {
  cache = null;
  inflight = null;
}

/** Replace the whole list. Admin-only server-side; throws with the
 *  route's message (folder probe failure, destination collision) so
 *  the panel can surface it verbatim. */
export async function saveDriveSources(folders: DriveSourceFolder[]): Promise<DriveSourceFolder[]> {
  const res = await fetch("/api/drive/sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folders }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Save failed (${res.status})`);
  }
  const saved = (data as { folders?: DriveSourceFolder[] }).folders ?? [];
  cache = { folders: saved, service_account: cache?.service_account ?? null };
  return saved;
}

/** List one registered folder's videos over a date window. */
export async function listDriveFolder(
  folderId: string,
  from?: string,
  to?: string,
): Promise<DriveSourceListResponse> {
  const res = await fetch("/api/drive/sources/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId, ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Drive list failed (${res.status})`);
  }
  return data as DriveSourceListResponse;
}
