/**
 * Reconcile a published Kaltura entry against the categories its series
 * declares (ADR-075 `DestinationSpec.category_ids`).
 *
 * Isomorphic — the pure half runs in the route and in the card. No node
 * imports here; the API calls live in kalturaApi.ts.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 * The declared categories have never reached Kaltura. The registry
 * holds NAMES:
 *
 *     "category_ids": ["@zoomCategory@", "Agentics.org Video Portal",
 *                      "Ai Hackerspace Live Recordings", "vod_sources",
 *                      "Weekly Recordings"]
 *
 * while publish/adapters/kaltura.ts coerced each one with `Number(id)`
 * and dropped the NaNs. Every value is a NaN, so the array emptied, and
 * /api/kaltura/upload's `categoryIds.length > 0` guard then skipped
 * `categoriesIds` entirely. No error at any step — the operator typed
 * names into a field placeheld "category ids" and nothing said no.
 *
 * So this is not drift repair. Of the 19 Kaltura-published records in
 * the catalog, none carries a category applied by this app.
 *
 * ── Design decisions ─────────────────────────────────────────────────
 * 1. BOTH shapes are accepted. A numeric value is an id; anything else
 *    is resolved by name against the partner's category list. Making
 *    the registry ids-only would be cleaner but silently invalidates
 *    live data that a human curated, and there is no picker yet to
 *    re-enter it with.
 *
 * 2. Additive, via `categoryEntry.add` — NOT `media.update` with
 *    `categoriesIds`. The latter REPLACES the whole membership set, so
 *    a repair tool built on it would strip any category a KMC admin
 *    added by hand. A fixup that quietly destroys manual work is worse
 *    than no fixup.
 *
 * 3. Unresolvable values are reported, never guessed at. `@zoomCategory@`
 *    is a Kaltura Zoom-connector template token, substituted by that
 *    integration at ingest; no external caller can apply it. Treating
 *    it as a missing category would put a permanent false failure on
 *    three series, so it gets its own reason and its own wording.
 */

import type { DestinationSpec } from "./youtubeTitleAlign";
import type { PlatformLocationJSON } from "./wasm";

/**
 * A Kaltura integration template token, e.g. `@zoomCategory@`. These
 * are placeholders the ingesting integration expands; they are not
 * categories and cannot be resolved through the API.
 */
export const TEMPLATE_TOKEN_RE = /^@[^@\s]+@$/;

/** A category as the partner's KMC defines it. */
export interface KalturaCategory {
  id: number;
  name: string;
  /** Path-like for nested categories: "Parent>Child". */
  fullName: string;
}

export type ResolutionReason = "template" | "not_found" | "ambiguous";

export interface CategoryResolution {
  /** Exactly what the series registry declared. */
  raw: string;
  /** Resolved category id, or null when it could not be resolved. */
  id: number | null;
  /** The matched category's full name, when resolved. */
  fullName: string | null;
  /** Why `id` is null. Absent on a successful resolution. */
  reason?: ResolutionReason;
}

export interface ReconcilePlan {
  /** Resolved, and the entry is not yet a member. */
  toAdd: CategoryResolution[];
  /** Resolved, and the entry is already a member — nothing to do. */
  alreadyPresent: CategoryResolution[];
  /** Could not be turned into a category id. */
  unresolved: CategoryResolution[];
}

/**
 * Resolve one declared value against the partner's categories.
 *
 * Order: template token → numeric id → exact full-name → exact name.
 *
 * Full name is tried before bare name because a declared "Child" could
 * match several nested categories, and a repair tool must not pick one
 * arbitrarily; that case reports `ambiguous` and leaves it to a human.
 * Matching is case-insensitive and trims surrounding space, because the
 * registry field is a comma-split text input and " vod_sources" is a
 * typo, not a different category.
 */
export function resolveDeclaredCategory(
  raw: string,
  catalog: KalturaCategory[],
): CategoryResolution {
  const trimmed = raw.trim();
  if (TEMPLATE_TOKEN_RE.test(trimmed)) {
    return { raw, id: null, fullName: null, reason: "template" };
  }
  // A bare integer is an id. `Number("")` is 0 and `Number(" 12 ")` is
  // 12, so test the shape rather than trusting the coercion — that
  // exact over-trust is what emptied the array in the adapter.
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    const known = catalog.find(c => c.id === id);
    return { raw, id, fullName: known?.fullName ?? null };
  }
  const needle = trimmed.toLowerCase();
  const byFullName = catalog.filter(c => c.fullName.trim().toLowerCase() === needle);
  if (byFullName.length === 1) {
    return { raw, id: byFullName[0].id, fullName: byFullName[0].fullName };
  }
  if (byFullName.length > 1) {
    return { raw, id: null, fullName: null, reason: "ambiguous" };
  }
  const byName = catalog.filter(c => c.name.trim().toLowerCase() === needle);
  if (byName.length === 1) {
    return { raw, id: byName[0].id, fullName: byName[0].fullName };
  }
  if (byName.length > 1) {
    return { raw, id: null, fullName: null, reason: "ambiguous" };
  }
  return { raw, id: null, fullName: null, reason: "not_found" };
}

/**
 * Split declared categories into what to add, what is already there,
 * and what could not be resolved.
 *
 * Duplicates in the declaration collapse: the registry field is a
 * comma-split string and the same category listed twice must not
 * produce two `categoryEntry.add` calls, the second of which Kaltura
 * rejects as a duplicate.
 */
export function planReconcile(
  declared: string[],
  catalog: KalturaCategory[],
  currentIds: number[],
): ReconcilePlan {
  const current = new Set(currentIds);
  const plan: ReconcilePlan = { toAdd: [], alreadyPresent: [], unresolved: [] };
  const seenIds = new Set<number>();
  const seenRaw = new Set<string>();

  for (const raw of declared) {
    const key = raw.trim().toLowerCase();
    if (!key || seenRaw.has(key)) continue;
    seenRaw.add(key);

    const resolution = resolveDeclaredCategory(raw, catalog);
    if (resolution.id === null) {
      plan.unresolved.push(resolution);
    } else if (current.has(resolution.id)) {
      plan.alreadyPresent.push(resolution);
    } else if (!seenIds.has(resolution.id)) {
      seenIds.add(resolution.id);
      plan.toAdd.push(resolution);
    }
  }
  return plan;
}

/** The categories the record's series declares for Kaltura, if any. */
export function declaredKalturaCategories(destinations: DestinationSpec[]): string[] {
  const kaltura = destinations.find(d => d.platform === "Kaltura");
  if (!kaltura || kaltura.platform !== "Kaltura") return [];
  return kaltura.category_ids ?? [];
}

/** The Kaltura entry id this record was published to, if any. */
export function kalturaEntryId(locations: PlatformLocationJSON[] | undefined): string | null {
  const loc = (locations ?? []).find(l => l.platform === "Kaltura" && l.role === "Destination");
  return loc?.external_id || null;
}

// ── Wire types, shared by the route and the card ────────────────────

export interface ReconcileRequest {
  entryId: string;
  declared: string[];
}

export interface ReconcileOutcome extends CategoryResolution {
  /** Set when the add itself failed, as opposed to not being attempted. */
  error?: string;
}

export interface ReconcileResponse {
  entryId: string;
  added: ReconcileOutcome[];
  alreadyPresent: CategoryResolution[];
  unresolved: CategoryResolution[];
  failed: ReconcileOutcome[];
}

/**
 * A one-line summary for the activity log.
 *
 * Phrases the template case separately: "1 unresolved" reads as a bug
 * to fix, while naming the token makes clear it is a Kaltura-side
 * placeholder that no amount of retrying will apply.
 */
export function summarizeReconcile(res: ReconcileResponse): string {
  const parts: string[] = [];
  if (res.added.length) {
    parts.push(`added ${res.added.map(a => a.fullName ?? a.raw).join(", ")}`);
  }
  if (res.alreadyPresent.length) parts.push(`${res.alreadyPresent.length} already present`);
  if (res.failed.length) {
    parts.push(`${res.failed.length} failed (${res.failed.map(f => f.error ?? "?").join("; ")})`);
  }
  const templates = res.unresolved.filter(u => u.reason === "template");
  const missing = res.unresolved.filter(u => u.reason !== "template");
  if (missing.length) {
    parts.push(`${missing.length} unresolved: ${missing.map(m => `${m.raw} (${m.reason})`).join(", ")}`);
  }
  if (templates.length) {
    parts.push(`${templates.map(t => t.raw).join(", ")} is an integration placeholder — not applicable`);
  }
  return parts.length ? parts.join("; ") : "nothing to do";
}

/** True when the reconcile left the entry in the declared state. */
export function isCompliant(res: ReconcileResponse): boolean {
  return res.failed.length === 0 && res.unresolved.every(u => u.reason === "template");
}

/** Client-side call into the route. */
export async function reconcileKalturaCategories(
  req: ReconcileRequest,
): Promise<ReconcileResponse> {
  const res = await fetch("/api/kaltura/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<ReconcileResponse> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Kaltura category sync failed (${res.status})`);
  return {
    entryId: data.entryId ?? req.entryId,
    added: data.added ?? [],
    alreadyPresent: data.alreadyPresent ?? [],
    unresolved: data.unresolved ?? [],
    failed: data.failed ?? [],
  };
}
