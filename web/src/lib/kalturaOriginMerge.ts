/**
 * Kaltura-origin records, reunited with the Zoom recordings they came
 * from.
 *
 * Kaltura's Zoom connector ingests Zoom recordings automatically. The
 * Kaltura importer then creates a catalog record with
 * `source_platform: "Kaltura"` and a `role: Origin` location — which
 * asserts that Kaltura is where the content originated. For a
 * connector-ingested entry that is false: the origin is a Zoom
 * meeting, and Kaltura holds a copy it pulled.
 *
 * The connector tells us so, in the entry's reference id:
 *
 *     Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
 *
 * See lib/kalturaZoomOrigin for the parse. This module does two jobs
 * on top of it:
 *
 *   BACKFILL  fetch the reference id for Kaltura-origin records that
 *             predate its capture, and correct `recorded_at` from the
 *             ingest time to the real recording start.
 *   MERGE     where the Zoom recording is also in the catalog, move
 *             the Kaltura entry onto that record as a Destination and
 *             retire the duplicate Kaltura row.
 *
 * The merge is the operator's chosen shape over linking. It is the
 * correct end state — one record per event, with every platform that
 * holds a copy listed as a location — but it retires a row, so the
 * driver is conservative about when it will do it (see MERGEABLE).
 */

import { videoStore } from "./store";
import { actorCommand, type ActorState } from "./useCurrentActor";
import type { VideoRecordJSON } from "./wasm";
import { kalturaWatchUrl } from "./urlResolver";
import {
  parseZoomReferenceId,
  classifyReferenceId,
  type KalturaZoomOrigin,
} from "./kalturaZoomOrigin";

/** `metadata_extra` keys this module reads and writes. */
export interface KalturaOriginMeta {
  kaltura_reference_id?: string;
  kaltura_reference_kind?: string;
  kaltura_ingested_at?: string;
  zoom_meeting_uuid?: string;
  zoom_recorded_at?: string;
}

function meta(r: VideoRecordJSON): KalturaOriginMeta {
  return ((r as VideoRecordJSON & { metadata_extra?: unknown }).metadata_extra ?? {}) as KalturaOriginMeta;
}

/** The Kaltura entry a record was imported FROM. */
export function kalturaOriginEntryId(r: VideoRecordJSON): string | null {
  if (r.source_platform !== "Kaltura") return null;
  const loc = (r.locations ?? []).find(l => l.platform === "Kaltura" && l.role === "Origin");
  return loc?.external_id ?? r.source_id ?? null;
}

// ── Backfill: recover the reference id we never stored ──────────────

export interface OriginBackfillCandidate {
  record_id: string;
  title: string;
  entry_id: string;
}

/**
 * Kaltura-origin records with no reference id recorded.
 *
 * Pure. These predate the importer capturing it, so the answer is
 * genuinely in the catalog: the key is either there or it is not.
 */
export function findRecordsNeedingOriginBackfill(
  allRecords: readonly VideoRecordJSON[],
): OriginBackfillCandidate[] {
  const out: OriginBackfillCandidate[] = [];
  for (const r of allRecords) {
    const entryId = kalturaOriginEntryId(r);
    if (!entryId) continue;
    if (meta(r).kaltura_reference_id) continue;
    out.push({ record_id: r.id, title: r.title, entry_id: entryId });
  }
  return out;
}

/** What a fetched entry contributes back to the record. */
export interface OriginFacts {
  reference_id: string | null;
  admin_tags: string | null;
  category_ids: string[];
  created_at: string;
}

/**
 * The `metadata_extra` patch and `recorded_at` correction implied by a
 * fetched entry. Pure, so the decision is testable without Kaltura.
 *
 * `recorded_at` is only corrected when the connector gives a real
 * recording start. Kaltura's `createdAt` is when it INGESTED the
 * entry — 1_b8kw2g8u was created at 18:13:49Z for a recording that
 * began at 15:45:02Z — and ADR-048 date gates, ADR-060 show windows
 * and the Overview all read that field. Where there is no connector
 * timestamp, the existing value is left alone rather than guessed at.
 */
export function originPatch(facts: OriginFacts): {
  metadata_extra: Record<string, string | null>;
  recorded_at?: string;
  origin?: KalturaZoomOrigin;
} {
  const patch: Record<string, string | null> = {
    kaltura_reference_id: facts.reference_id,
    kaltura_reference_kind: classifyReferenceId(facts.reference_id),
    kaltura_ingested_at: facts.created_at,
  };
  if (facts.admin_tags) patch.kaltura_admin_tags = facts.admin_tags;
  if (facts.category_ids.length > 0) patch.kaltura_category_ids = facts.category_ids.join(",");

  const origin = parseZoomReferenceId(facts.reference_id);
  if (!origin) return { metadata_extra: patch };

  patch.zoom_meeting_uuid = origin.meeting_uuid;
  patch.zoom_recorded_at = origin.recorded_at;
  return { metadata_extra: patch, recorded_at: origin.recorded_at, origin };
}

// ── Linking: make the recovered origin visible ──────────────────────

/**
 * The upstream link a recovered Zoom origin implies.
 *
 * Recording the meeting UUID in `metadata_extra` is not enough: the
 * card and the Provenance graph read `upstream_links`, so a record
 * that demonstrably knows where it came from still displayed nothing.
 * That is what the operator saw on 06dbb971 — reference id recovered,
 * `recorded_at` corrected, and no visible Zoom origin anywhere.
 *
 * `video_id: null` is a PHANTOM link: we know the meeting, we do not
 * hold a catalog record for it. provenanceLinker already uses this
 * shape for Fireflies transcripts whose Zoom meeting is not indexed,
 * and it is the common case here — every one of the 11 Kaltura-origin
 * records names a meeting the catalog does not hold, because the
 * Kaltura entries outlive Zoom's retention window.
 *
 * `SameEvent` follows provenanceLinker's own choice for this shape.
 * It renders as "Same session", which is honest: the Kaltura entry is
 * a copy of that meeting's recording. None of the other relations
 * (TranscribedFrom, ScreenRecordingOf, ClipOf, BroadcastedFrom)
 * describes "another platform ingested it".
 */
export function zoomOriginLinkCmd(
  origin: { meeting_uuid: string },
  zoomRecordId: string | null,
): { video_id: string | null; platform: string; external_id: string; relation: string; linked_by: string } {
  return {
    video_id: zoomRecordId,
    platform: "Zoom",
    external_id: origin.meeting_uuid,
    relation: "SameEvent",
    linked_by: "Auto",
  };
}

/**
 * Records that know their Zoom origin but do not show it.
 *
 * Pure, and the answer is entirely in the catalog — no Kaltura call.
 * This exists because the first version of the backfill wrote the
 * meeting UUID into `metadata_extra` and stopped there, so eleven
 * records were left knowing their origin and displaying nothing. A
 * re-run must repair them without re-reading Kaltura for data it
 * already has.
 */
export function findRecordsMissingZoomOriginLink(
  allRecords: readonly VideoRecordJSON[],
): { record_id: string; title: string; meeting_uuid: string }[] {
  const out: { record_id: string; title: string; meeting_uuid: string }[] = [];
  for (const r of allRecords) {
    const uuid = meta(r).zoom_meeting_uuid;
    if (!uuid) continue;
    if (hasZoomOriginLink(r, uuid)) continue;
    out.push({ record_id: r.id, title: r.title, meeting_uuid: uuid });
  }
  return out;
}

/** Is this Zoom origin already recorded as an upstream link? */
export function hasZoomOriginLink(r: VideoRecordJSON, meetingUuid: string): boolean {
  return (r.upstream_links ?? []).some(
    l => l.platform === "Zoom" && l.external_id === meetingUuid,
  );
}

/**
 * Write the upstream link, resolving to a catalog record when we hold
 * the Zoom recording and leaving a phantom when we do not.
 *
 * Returns whether a link was written. Never throws: the provenance in
 * `metadata_extra` has already landed by the time this runs, and a
 * failed link must not discard it.
 */
export function ensureZoomOriginLink(
  recordId: string,
  meetingUuid: string,
  actorState: ActorState,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): { linked: boolean; phantom: boolean } {
  const all = videoStore.getAll();
  const current = all.find(x => x.id === recordId);
  if (!current || hasZoomOriginLink(current, meetingUuid)) return { linked: false, phantom: false };

  const zoomRec = all.find(x => x.source_platform === "Zoom" && x.source_id === `zoom-${meetingUuid}`);
  try {
    videoStore.mutate(recordId, (r) =>
      r.link_upstream(actorCommand(actorState, zoomOriginLinkCmd({ meeting_uuid: meetingUuid }, zoomRec?.id ?? null))),
    );
    return { linked: true, phantom: !zoomRec };
  } catch (err) {
    log?.(
      `Origin link failed for ${recordId.slice(0, 8)} -> Zoom ${meetingUuid}: ${err instanceof Error ? err.message : String(err)}`,
      { video_id: recordId },
    );
    return { linked: false, phantom: !zoomRec };
  }
}

// ── Merge: one record per event ─────────────────────────────────────

export interface OriginMergePair {
  kaltura_record: VideoRecordJSON;
  zoom_record: VideoRecordJSON;
  entry_id: string;
  meeting_uuid: string;
}

/**
 * Statuses a Kaltura duplicate may be retired from.
 *
 * Mirrors catalogDedupe's caution. A record in Approved / Publishing /
 * ToRetry needs a state walk that this must not automate — retiring a
 * row mid-publish would strand an in-flight upload.
 */
export const MERGEABLE = new Set(["Discovered", "Indexed", "InScope", "OutOfScope", "Rejected"]);

/**
 * Kaltura-origin records whose Zoom recording is also in the catalog.
 *
 * Identity only — the Zoom meeting UUID from the connector's reference
 * id against the Zoom record's `source_id`. No titles, no dates, no
 * thresholds. A record whose Zoom counterpart is absent is not a
 * candidate; roughly two thirds of them are, because the Kaltura
 * originals predate Zoom's retention window.
 */
export function findOriginMergePairs(
  allRecords: readonly VideoRecordJSON[],
): OriginMergePair[] {
  const zoomBySourceId = new Map<string, VideoRecordJSON>();
  for (const r of allRecords) {
    if (r.source_platform === "Zoom" && r.source_id) zoomBySourceId.set(r.source_id, r);
  }

  const pairs: OriginMergePair[] = [];
  for (const r of allRecords) {
    const entryId = kalturaOriginEntryId(r);
    if (!entryId) continue;
    const uuid = meta(r).zoom_meeting_uuid;
    if (!uuid) continue;
    const zoom = zoomBySourceId.get(`zoom-${uuid}`);
    if (!zoom || zoom.id === r.id) continue;
    pairs.push({ kaltura_record: r, zoom_record: zoom, entry_id: entryId, meeting_uuid: uuid });
  }
  return pairs;
}

export interface OriginMergeProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  title?: string;
  outcome?:
    | { kind: "merged"; entryId: string; intoRecordId: string }
    | { kind: "location_only"; entryId: string; intoRecordId: string; status: string }
    | { kind: "already"; entryId: string }
    | { kind: "error"; error: string };
  totals?: { merged: number; location_only: number; already: number; errors: number };
}

/**
 * Attach each Kaltura entry to its Zoom record, then retire the
 * duplicate.
 *
 * Order matters and is not incidental: the location is added FIRST and
 * the Kaltura row retired second. If the retire fails, the catalog
 * holds a duplicate whose entry is also correctly recorded on the Zoom
 * record — recoverable, and visible. The reverse order would retire
 * the only record naming the entry and lose it if the add then failed.
 *
 * When the duplicate cannot be retired (MERGEABLE), the location is
 * still added and the outcome reported as `location_only`, so the Zoom
 * record gains its Kaltura destination and an operator can finish the
 * retirement by hand.
 */
export async function runKalturaOriginMerge(
  actorState: ActorState,
  onEvent: (ev: OriginMergeProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ merged: number; location_only: number; already: number; errors: number }> {
  const pairs = findOriginMergePairs(videoStore.getAll());
  onEvent({ type: "started", total: pairs.length });
  log?.(`Kaltura origin merge started — ${pairs.length} record${pairs.length === 1 ? "" : "s"} to reunite`);

  const totals = { merged: 0, location_only: 0, already: 0, errors: 0 };

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const short = p.kaltura_record.id.slice(0, 8);
    try {
      const alreadyThere = (p.zoom_record.locations ?? []).some(
        l => l.platform === "Kaltura" && l.external_id === p.entry_id,
      );

      if (!alreadyThere) {
        videoStore.mutate(p.zoom_record.id, (r) =>
          r.add_location(actorCommand(actorState, {
            platform: "Kaltura",
            external_id: p.entry_id,
            external_url: kalturaWatchUrl(p.entry_id),
            role: "Destination",
          })),
        );
      }

      const status = p.kaltura_record.status;
      if (!MERGEABLE.has(status)) {
        totals.location_only++;
        log?.(
          `Origin merge — ${p.entry_id} recorded on ${p.zoom_record.id.slice(0, 8)}; Kaltura row ${short} left in place (status ${status} needs a manual walk-back)`,
          { video_id: p.kaltura_record.id },
        );
        onEvent({
          type: "item_done", index: i + 1, total: pairs.length, title: p.kaltura_record.title,
          outcome: { kind: "location_only", entryId: p.entry_id, intoRecordId: p.zoom_record.id, status },
        });
        continue;
      }

      videoStore.mutate(p.kaltura_record.id, (r) => r.abandon(actorCommand(actorState)));
      alreadyThere ? totals.already++ : totals.merged++;
      log?.(
        `Origin merge — ${p.entry_id} moved onto ${p.zoom_record.id.slice(0, 8)} as a Destination; duplicate Kaltura row ${short} retired`,
        { video_id: p.zoom_record.id },
      );
      onEvent({
        type: "item_done", index: i + 1, total: pairs.length, title: p.kaltura_record.title,
        outcome: alreadyThere
          ? { kind: "already", entryId: p.entry_id }
          : { kind: "merged", entryId: p.entry_id, intoRecordId: p.zoom_record.id },
      });
    } catch (err) {
      totals.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`Origin merge failed for ${short}: ${msg}`, { video_id: p.kaltura_record.id });
      onEvent({
        type: "item_done", index: i + 1, total: pairs.length, title: p.kaltura_record.title,
        outcome: { kind: "error", error: msg },
      });
    }
  }

  onEvent({ type: "complete", total: pairs.length, totals });
  return totals;
}

/** A record's metadata_extra as it stands right now, from the store. */
export function currentExtra(recordId: string): Record<string, unknown> {
  const r = videoStore.getAll().find(x => x.id === recordId);
  return ((r as (VideoRecordJSON & { metadata_extra?: unknown }) | undefined)?.metadata_extra ?? {}) as Record<string, unknown>;
}

/** Keys present before a write and absent after it. */
export function droppedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(before).filter(k => !(k in after));
}

// ── Backfill driver ─────────────────────────────────────────────────

export interface OriginBackfillProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  title?: string;
  outcome?:
    | { kind: "zoom_origin"; uuid: string; correctedDate: boolean }
    | { kind: "recorded"; kind_of_reference: string }
    | { kind: "not_found" }
    | { kind: "error"; error: string };
  totals?: { zoom_origin: number; recorded: number; not_found: number; errors: number };
}

/**
 * Fetch the reference id for Kaltura-origin records that predate its
 * capture, and write what it implies back onto the record.
 *
 * Entries are fetched in one batched call per chunk via
 * /api/kaltura/list's `entryIds` mode, so 11 records cost one request
 * rather than eleven.
 *
 * This corrects `recorded_at` where the connector supplies a real
 * recording start. That is a mutation of existing data and the reason
 * this runs as an explicit operator action rather than at load: three
 * of the affected records are Vibe / Friday Hackerspace rows whose
 * dates feed series matching, so the change must be visible and
 * attributable in the event log.
 */
export async function runKalturaOriginBackfill(
  actorState: ActorState,
  onEvent: (ev: OriginBackfillProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ zoom_origin: number; recorded: number; not_found: number; errors: number }> {
  // Pass 1, local and free: records that already know their Zoom
  // origin but have no upstream link to show for it. The first
  // version of this backfill wrote the meeting UUID into
  // metadata_extra and stopped, so a re-run must repair those without
  // re-reading Kaltura for data it already holds.
  const unlinked = findRecordsMissingZoomOriginLink(videoStore.getAll());
  let relinked = 0;
  for (const u of unlinked) {
    const { linked, phantom } = ensureZoomOriginLink(u.record_id, u.meeting_uuid, actorState, log);
    if (!linked) continue;
    relinked++;
    log?.(
      `Origin link — ${u.record_id.slice(0, 8)} -> Zoom ${u.meeting_uuid}` +
      `${phantom ? " (not in catalog — phantom link)" : " (linked to its catalog record)"}`,
      { video_id: u.record_id },
    );
  }
  if (relinked > 0) log?.(`Kaltura origin backfill — restored ${relinked} missing upstream link${relinked === 1 ? "" : "s"} from data already held`);

  // Pass 2: records with no reference id at all, which needs Kaltura.
  const work = findRecordsNeedingOriginBackfill(videoStore.getAll());
  onEvent({ type: "started", total: work.length });
  log?.(`Kaltura origin backfill started — ${work.length} record${work.length === 1 ? "" : "s"} missing a reference id`);

  const totals = { zoom_origin: relinked, recorded: 0, not_found: 0, errors: 0 };
  if (work.length === 0) {
    onEvent({ type: "complete", total: 0, totals });
    return totals;
  }

  // One request for the whole batch. Kaltura's idIn filter is a
  // comma-separated list; 500 is the pager ceiling the route uses.
  let byEntryId = new Map<string, OriginFacts>();
  try {
    const res = await fetch("/api/kaltura/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: work.map(w => w.entry_id) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      entries?: { id: string; reference_id: string | null; admin_tags: string | null; category_ids: string[]; createdAt: string }[];
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? `Kaltura list failed (${res.status})`);
    byEntryId = new Map(
      (data.entries ?? []).map(e => [e.id, {
        reference_id: e.reference_id,
        admin_tags: e.admin_tags,
        category_ids: e.category_ids ?? [],
        created_at: e.createdAt,
      }]),
    );
  } catch (err) {
    // A failed fetch is one failure, not N. Report it once and stop
    // rather than emitting an identical error per record.
    const msg = err instanceof Error ? err.message : String(err);
    totals.errors = work.length;
    log?.(`Kaltura origin backfill aborted — ${msg}`);
    onEvent({ type: "complete", total: work.length, totals });
    return totals;
  }

  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    const emit = (outcome: OriginBackfillProgressEvent["outcome"]) =>
      onEvent({ type: "item_done", index: i + 1, total: work.length, title: w.title, outcome });

    const facts = byEntryId.get(w.entry_id);
    if (!facts) {
      totals.not_found++;
      log?.(`Origin backfill — entry ${w.entry_id} not returned by Kaltura`, { video_id: w.record_id });
      emit({ kind: "not_found" });
      continue;
    }

    try {
      const patch = originPatch(facts);

      // Carry the record's EXISTING metadata_extra keys in the patch
      // explicitly, rather than relying on the aggregate's shallow
      // merge to preserve them.
      //
      // On 2026-09-29 this backfill destroyed four keys —
      // kaltura_original_title, player_url and both title_aligned_*
      // — on both records that had any (catalog.json generations
      // 1790709694686195 -> 1790724730490401). The Rust merge in
      // apply_metadata_edits is correct and the exact payload,
      // replayed against the real WASM, preserves everything. The
      // mechanism was never isolated.
      //
      // So this does not rely on knowing it. A patch that restates
      // what is already there produces the same result whether the
      // aggregate merges or replaces, which removes the whole class
      // of failure rather than the one instance of it.
      const before = currentExtra(w.record_id);
      const merged: Record<string, unknown> = { ...before, ...patch.metadata_extra };

      const edits: Record<string, unknown> = { metadata_extra: merged };
      if (patch.recorded_at) edits.recorded_at = patch.recorded_at;
      videoStore.mutate(w.record_id, (r) => r.update_metadata(actorCommand(actorState, { edits })));

      // Verify. If a key present before is gone after, stop the run:
      // whatever removed it will remove it from every remaining
      // record, and a loud halt beats a quiet sweep through the rest.
      const lost = droppedKeys(before, currentExtra(w.record_id));
      if (lost.length > 0) {
        const msg = `Origin backfill HALTED — writing ${w.record_id.slice(0, 8)} dropped metadata keys ${lost.join(", ")}. `
          + "No further records will be touched. This is the 2026-09-29 data-loss guard.";
        log?.(msg, { video_id: w.record_id });
        totals.errors++;
        emit({ kind: "error", error: msg });
        onEvent({ type: "complete", total: work.length, totals });
        return totals;
      }

      const origin = patch.origin;
      if (origin) {
        // Make it visible. metadata_extra alone is invisible to the
        // card and the Provenance graph.
        const { phantom } = ensureZoomOriginLink(w.record_id, origin.meeting_uuid, actorState, log);
        totals.zoom_origin++;
        log?.(
          `Origin backfill — ${w.entry_id} came from Zoom meeting ${origin.meeting_uuid}` +
          `${phantom ? " (not in catalog — phantom link)" : " (linked to its catalog record)"}` +
          `; recorded_at set to ${origin.recorded_at} (was Kaltura's ingest time ${facts.created_at})`,
          { video_id: w.record_id },
        );
        emit({ kind: "zoom_origin", uuid: origin.meeting_uuid, correctedDate: patch.recorded_at !== facts.created_at });
      } else {
        totals.recorded++;
        const kind = String(patch.metadata_extra.kaltura_reference_kind ?? "absent");
        log?.(`Origin backfill — ${w.entry_id} reference id is ${kind}; no Zoom origin to recover`, { video_id: w.record_id });
        emit({ kind: "recorded", kind_of_reference: kind });
      }
    } catch (err) {
      totals.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`Origin backfill failed for ${w.record_id.slice(0, 8)}: ${msg}`, { video_id: w.record_id });
      emit({ kind: "error", error: msg });
    }
  }

  onEvent({ type: "complete", total: work.length, totals });
  return totals;
}
