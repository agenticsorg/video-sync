/**
 * ADR-080 Phase 1 — bring published Kaltura entries into line with the
 * categories their series declares.
 *
 * ── Why this scanner is not like the others ─────────────────────────
 * Every other Maintain backfill reads the catalog and knows the
 * answer. `findRecordsNeedingSummaryBadge` compares a prompt version;
 * `findOrphanClips` inspects links; `findDuplicateClusters` compares
 * records. Pure, offline, exact.
 *
 * Category compliance is not in the catalog. Nothing records which
 * Kaltura categories an entry belongs to — determining it needs a
 * `categoryEntry.list` per entry.
 *
 * So this returns CANDIDATES, not diagnoses. The name is
 * `findKalturaCategoryCandidates`, not `findRecordsNeeding…`, because
 * it cannot know which records need anything. Reconciliation is
 * additive and idempotent, so an already-compliant entry costs one
 * read and zero writes, and the card says "N to check" rather than
 * "N broken".
 *
 * ADR-080 §2 is explicit about this because the temptation to show a
 * confident number on a dashboard is exactly how the original bug
 * reported four of the operator's real categories as `not_found`.
 * ADR-080 §5 earns an exact figure properly, by persisting
 * `observed_categories` on the destination outcome; that needs a Rust
 * schema change and is deliberately not here.
 */

import { videoStore } from "./store";
import { getSeriesRegistryCached } from "./seriesRegistryClient";
import { loadProcessingRules } from "./processingRules";
import { resolveDestinations } from "./destinationResolver";
import {
  declaredKalturaCategories,
  kalturaEntryId,
  reconcileKalturaCategories,
  summarizeReconcile,
  isCompliant,
} from "./kalturaCategories";
import type { VideoRecordJSON } from "./wasm";
import type { SeriesRegistryEntry } from "./youtubeTitleAlign";
import type { ProcessingRule } from "./processingRules";

export interface KalturaCategoryCandidate {
  record_id: string;
  title: string;
  entry_id: string;
  series_name: string | null;
  declared: string[];
}

/**
 * Published Kaltura entries whose series declares categories.
 *
 * Pure. `Destination` role only (ADR-080 §1) — `kalturaEntryId`
 * enforces that. Entries this app merely indexed carry role `Origin`
 * and are Phase 3.
 */
export function findKalturaCategoryCandidates(
  allRecords: readonly VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
  rules: ProcessingRule[],
): KalturaCategoryCandidate[] {
  const out: KalturaCategoryCandidate[] = [];
  for (const r of allRecords) {
    const entryId = kalturaEntryId(r.locations);
    if (!entryId) continue;

    const resolved = resolveDestinations(r, registry, rules, null);
    const declared = declaredKalturaCategories(resolved.destinations);
    if (declared.length === 0) continue;

    out.push({
      record_id: r.id,
      title: r.title,
      entry_id: entryId,
      series_name: resolved.provenance.source === "series" ? resolved.provenance.series_name : null,
      declared,
    });
  }
  return out;
}

/** Candidates resolved from the warmed caches, for the panel. */
export function findKalturaCategoryCandidatesNow(
  allRecords: readonly VideoRecordJSON[],
): KalturaCategoryCandidate[] {
  return findKalturaCategoryCandidates(allRecords, getSeriesRegistryCached(), loadProcessingRules());
}

export interface KalturaCategoryProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  title?: string;
  outcome?:
    | { kind: "applied"; added: string[] }
    | { kind: "already_compliant" }
    /** Landed partially. NOT an error, and NOT a success. */
    | { kind: "incomplete"; detail: string }
    | { kind: "error"; error: string };
  totals?: { applied: number; already: number; incomplete: number; errors: number };
}

/**
 * Reconcile each candidate, one at a time.
 *
 * Sequential per ADR-080 §3: Kaltura rate-limits an admin session, and
 * a partial failure must leave a readable trail of what landed rather
 * than an unordered pile of rejections. An error on one record is
 * recorded and the loop continues.
 *
 * `incomplete` is a distinct outcome, not a sub-case of success. A
 * record whose four declared categories resolve to three is neither
 * fixed nor failed, and collapsing that into either is how the
 * original problem stayed invisible for as long as it did.
 */
export async function runKalturaCategoryBackfill(
  onEvent: (ev: KalturaCategoryProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ applied: number; already: number; incomplete: number; errors: number }> {
  const work = findKalturaCategoryCandidatesNow(videoStore.getAll());
  onEvent({ type: "started", total: work.length });
  log?.(`Kaltura category check started — ${work.length} published entr${work.length === 1 ? "y" : "ies"} to check`);

  const totals = { applied: 0, already: 0, incomplete: 0, errors: 0 };

  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    const emit = (outcome: KalturaCategoryProgressEvent["outcome"]) =>
      onEvent({ type: "item_done", index: i + 1, total: work.length, title: w.title, outcome });

    try {
      const res = await reconcileKalturaCategories({ entryId: w.entry_id, declared: w.declared });
      const summary = summarizeReconcile(res);

      if (!isCompliant(res)) {
        totals.incomplete++;
        log?.(`Kaltura categories [${w.entry_id}] incomplete — ${summary}`, { video_id: w.record_id });
        emit({ kind: "incomplete", detail: summary });
      } else if (res.added.length > 0) {
        totals.applied++;
        const added = res.added.map(a => a.fullName ?? a.raw);
        log?.(`Kaltura categories [${w.entry_id}] applied — ${added.join(", ")}`, { video_id: w.record_id });
        emit({ kind: "applied", added });
      } else {
        totals.already++;
        log?.(`Kaltura categories [${w.entry_id}] already compliant`, { video_id: w.record_id });
        emit({ kind: "already_compliant" });
      }
    } catch (err) {
      totals.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`Kaltura categories [${w.entry_id}] failed — ${msg}`, { video_id: w.record_id });
      emit({ kind: "error", error: msg });
    }
  }

  onEvent({ type: "complete", total: work.length, totals });
  return totals;
}
