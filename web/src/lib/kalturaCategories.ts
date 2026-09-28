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
 * 3. Unresolvable values are reported, never guessed at.
 *
 * ── Correction, after the first live run ─────────────────────────────
 * This module originally refused any `@token@` name outright, on the
 * reasoning that `@zoomCategory@` is a Kaltura Zoom-connector template
 * that only that integration can expand. The partner's own category
 * list disproved it: `@zoomCategory@` and `@zoomWebinarCategory@` are
 * REAL categories, sitting alongside 21 auto-created `ep_private_*` /
 * `ep_agenda_*` pairs. The connector was configured with an
 * unsubstituted template and created categories named after the literal
 * token. The registry entry was right; the refusal was wrong.
 *
 * So an `@token@` name now resolves against the listing like any other.
 * The shape is kept only as a HINT on failure — if such a name is
 * absent, saying "this looks like an unsubstituted placeholder" is more
 * use than a bare not_found. It no longer excuses the value from
 * counting against compliance, because a declared category that cannot
 * be applied leaves the entry short of what the series asked for,
 * whatever the reason.
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

/**
 * `listing_empty` is deliberately distinct from `not_found`.
 *
 * The first run against a live entry reported four different names as
 * `not_found` — an implausible coincidence, and the reason was
 * unfalsifiable from the output alone: a name missing from a listing of
 * 200 categories and a name missing from a listing of ZERO categories
 * are entirely different faults (fix the registry vs. fix the session's
 * permissions), and the original code called both `not_found`. A
 * diagnosis the reader cannot check is worse than no diagnosis.
 */
export type ResolutionReason = "template" | "not_found" | "ambiguous" | "listing_empty";

export interface CategoryResolution {
  /** Exactly what the series registry declared. */
  raw: string;
  /** Resolved category id, or null when it could not be resolved. */
  id: number | null;
  /** The matched category's full name, when resolved. */
  fullName: string | null;
  /** Why `id` is null. Absent on a successful resolution. */
  reason?: ResolutionReason;
  /** Close names from the listing, when `reason` is `not_found`. The
   *  answer to "then what IS it called?" without a second round trip. */
  suggestions?: string[];
}

/** Words, lowercased, punctuation dropped. "Agentics.org Video Portal"
 *  → ["agentics","org","video","portal"]. */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Categories whose names are close to what was declared.
 *
 * Scored on token overlap rather than edit distance: the realistic
 * failure is a renamed or re-nested category ("Weekly Recordings" now
 * living under a parent, "vod_sources" now "VOD Sources"), not a
 * typo. Token overlap catches those; Levenshtein would not.
 */
export function suggestFullNames(raw: string, catalog: KalturaCategory[], limit = 3): string[] {
  const want = new Set(tokenize(raw));
  if (want.size === 0) return [];
  return catalog
    .map(c => {
      const have = new Set(tokenize(c.fullName));
      let shared = 0;
      for (const t of want) if (have.has(t)) shared++;
      // Normalise by the declared name's length so a sprawling
      // category path doesn't outrank a tight match.
      return { fullName: c.fullName, score: shared / want.size };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName))
    .slice(0, limit)
    .map(s => s.fullName);
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
  // Nothing to have matched against. Reporting "not_found" here would
  // point the reader at the registry when the fault is the session.
  if (catalog.length === 0) {
    return { raw, id: null, fullName: null, reason: "listing_empty" };
  }
  // Only now is the token shape worth mentioning: the name did not
  // match any category, and its shape says why it might not exist.
  if (TEMPLATE_TOKEN_RE.test(trimmed)) {
    return { raw, id: null, fullName: null, reason: "template" };
  }
  const suggestions = suggestFullNames(raw, catalog);
  return {
    raw,
    id: null,
    fullName: null,
    reason: "not_found",
    ...(suggestions.length ? { suggestions } : {}),
  };
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
  /** How many categories `category.list` returned. Zero is the whole
   *  diagnosis; any other number makes an unresolved name a real
   *  registry problem rather than a permissions one. */
  categoriesListed?: number;
  /** A sample of what the partner actually has, sent only when
   *  something failed to resolve. Turns "then what is it called?" into
   *  a question the operator can answer from the same screen. */
  availableSample?: string[];
  /** Categories the entry already belonged to before this ran. */
  currentCategoryIds?: number[];
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
  const listingEmpty = res.unresolved.filter(u => u.reason === "listing_empty");
  const missing = res.unresolved.filter(u => u.reason === "not_found" || u.reason === "ambiguous");

  // The empty listing subsumes everything else: if no categories came
  // back, naming the individual values is noise around one fact.
  if (listingEmpty.length) {
    parts.push(
      `Kaltura returned no categories for this partner, so none of ${listingEmpty.length} declared name(s) could be resolved — the admin session likely cannot list categories`,
    );
  }
  if (missing.length) {
    parts.push(
      `${missing.length} unresolved: ${missing
        .map(m => {
          const hint = m.suggestions?.length ? ` — did you mean ${m.suggestions.join(" / ")}?` : "";
          return `${m.raw} (${m.reason})${hint}`;
        })
        .join(", ")}`,
    );
    if (typeof res.categoriesListed === "number") {
      parts.push(`checked against ${res.categoriesListed} categories on the partner`);
    }
  }
  if (templates.length) {
    parts.push(
      `${templates.map(t => t.raw).join(", ")} not found and looks like an unsubstituted integration placeholder — check the connector config in the KMC`,
    );
  }
  return parts.length ? parts.join("; ") : "nothing to do";
}

/**
 * True when the reconcile left the entry in the declared state.
 *
 * Every unresolved value counts against it. An earlier version excused
 * `template` as "not applicable", on the belief that `@zoomCategory@`
 * could never be a real category; the partner's listing showed it is
 * one. There is no reason a declared category can go unapplied and the
 * entry still be in the state the series asked for.
 */
export function isCompliant(res: ReconcileResponse): boolean {
  return res.failed.length === 0 && res.unresolved.length === 0;
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
    categoriesListed: data.categoriesListed,
    availableSample: data.availableSample,
    currentCategoryIds: data.currentCategoryIds,
  };
}
