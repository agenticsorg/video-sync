"use client";

/**
 * Client accessor for the YouTube upload-quota snapshot.
 *
 * The number this exposes is the *API* ceiling — 10,000 units/day at
 * 1,600 per upload, so six — which is a different thing from a backfill
 * profile's `max_uploads_per_day`, a self-imposed pacing choice. Showing
 * the pacing limit alone is what let 2026-09-23 spend ~6,400 units with
 * nothing on screen saying so.
 */

export interface QuotaSnapshot {
  uploads_today: number;
  last_reset_date: string;
  limit: number;
  remaining: number;
  units_used: number;
}

let cache: QuotaSnapshot | null = null;
let inflight: Promise<QuotaSnapshot | null> | null = null;

async function fetchOnce(): Promise<QuotaSnapshot | null> {
  try {
    const res = await fetch("/api/backfill/state", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as QuotaSnapshot;
  } catch {
    return null;
  }
}

/** Fetch once and cache. Returns null when unavailable — callers render
 *  nothing rather than a misleading zero. */
export async function getUploadQuota(force = false): Promise<QuotaSnapshot | null> {
  if (!force && cache) return cache;
  if (!inflight) {
    inflight = fetchOnce().then(s => { if (s) cache = s; inflight = null; return s; });
  }
  return inflight;
}

export function getUploadQuotaCached(): QuotaSnapshot | null {
  return cache;
}

export function refreshUploadQuota(): void {
  cache = null;
  inflight = null;
}
