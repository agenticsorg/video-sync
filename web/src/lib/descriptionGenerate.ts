"use client";

/**
 * Description generation, extracted from VideoCard so something other
 * than a button click can drive it.
 *
 * This is the description-side counterpart to `tryEnsureSummary` in
 * `catchupOrchestrator.ts`, and deliberately matches its shape: take a
 * record, do the work, report `{ generated, reason }`, mutate through
 * `videoStore`. No React, no component state — the caller owns the UI.
 *
 * The policy it implements is ADR-064 + ADR-067 unchanged:
 *
 *   mode "copy_show_notes" + Show Notes present
 *     → LLM rewrite via /api/description/from-show-notes (ADR-067)
 *     → on any failure, the deterministic showNotesToDescription
 *       converter (ADR-064 §2) as the safety net
 *   otherwise
 *     → LLM one-shot over the ADR-059/060-trimmed transcript
 *
 * What is new is the guard in `describeSkipReason`. A per-card click is
 * an explicit instruction and passes `force`; an unattended pass does
 * not, and must not overwrite a locked description, a hand-written one,
 * or one whose provenance we cannot account for. That distinction is
 * why the aggregate grew `description_locked` / `description_source`.
 */

import type { VideoRecordJSON, DescriptionSourceJSON } from "./wasm";
import { videoStore } from "./store";
import { actorCommand } from "./useCurrentActor";
import { getDescriptionConfig, getDescriptionConfigCached } from "./descriptionConfig";
import { showNotesToDescription } from "./showNotesToDescription";
import { loadProcessingRules, applyProcessingRules, requestLlmSummary } from "./processingRules";
import { getSeriesRegistryCached } from "./seriesRegistryClient";
import { sliceTranscriptFromSeconds, sliceTranscriptToSeconds } from "./transcriptSlice";

/** Shortest text we accept as a real description from any path. */
const MIN_DESCRIPTION_CHARS = 20;

/** Transcript below this is not worth an LLM call. */
const MIN_TRANSCRIPT_CHARS = 200;

export type ActorState = Parameters<typeof actorCommand>[0];

export interface EnsureDescriptionOptions {
  actorState: ActorState;
  /** Aborts the in-flight fetches. */
  signal?: AbortSignal;
  /**
   * Skip the should-we-touch-this guard. Set by an explicit operator
   * click, which is an instruction rather than a sweep. Never set by an
   * unattended pass.
   */
  force?: boolean;
  /**
   * Emit an audit line. Same signature as VideoCard's `onEvent` so the
   * card can pass its own straight through.
   */
  onEvent?: (message: string, ctx?: Record<string, unknown>) => void;
  /**
   * Also write the un-capped long form to the Drive artifact bag
   * (ADR-074). Fire-and-forget and non-fatal. Defaults to true; a bulk
   * pass may turn it off to halve its LLM spend.
   */
  writeFullVariant?: boolean;
}

export type SkipReason =
  | "locked"
  | "manual"
  | "unknown_provenance"
  | "current"
  | "no_source_material";

export interface EnsureDescriptionResult {
  generated: boolean;
  /** Why nothing was written. Absent when `generated` is true. */
  reason?: SkipReason;
  /** Which path produced the text. Absent when nothing was written. */
  source?: DescriptionSourceJSON;
  /** Length of the stored text. */
  length?: number;
  /** True when the LLM path failed and the deterministic net caught it. */
  usedFallback?: boolean;
}

/** Format a record's date for the audit line, matching VideoCard. */
function dateTag(recordedAt: string | null | undefined): string {
  if (!recordedAt) return "";
  const d = new Date(recordedAt);
  return Number.isNaN(d.getTime()) ? "" : ` (${d.toISOString().slice(0, 10)})`;
}

/**
 * Whether an unattended pass may overwrite this record's description,
 * and if not, why. Mirrors `VideoRecord::description_is_regenerable` and
 * `description_is_stale` in the Rust aggregate — reimplemented here
 * rather than called through WASM because callers hold plain JSON, and
 * a scanner deciding what work exists shouldn't need a live record.
 *
 * Keep the two in step: the Rust side is the one that governs a
 * mutation, this one governs whether we bother attempting it.
 */
export function describeSkipReason(
  record: VideoRecordJSON,
  currentMode: "copy_show_notes" | "generate",
): SkipReason | null {
  if (record.description_locked) return "locked";

  const existing = (record.description ?? "").trim();
  if (existing.length > 0) {
    // Absent provenance means the record predates these fields. Unknown
    // authorship is treated as human authorship: we cannot reproduce
    // what we cannot account for.
    if (!record.description_source) return "unknown_provenance";
    if (record.description_source === "Manual") return "manual";
  }

  // Nothing to derive from.
  const hasShowNotes = !!record.summary_doc_id;
  const hasTranscript = (record.transcript_text?.length ?? 0) >= MIN_TRANSCRIPT_CHARS;
  if (currentMode === "copy_show_notes" && !hasShowNotes && !hasTranscript) {
    return "no_source_material";
  }
  if (currentMode === "generate" && !hasTranscript) return "no_source_material";

  // An existing generated description is current unless the Show Notes
  // moved on beneath it.
  if (existing.length > 0 && !isStale(record)) return "current";

  return null;
}

/**
 * Has the description drifted from the Show Notes it was derived from?
 * Mirrors `VideoRecord::description_is_stale`.
 */
export function isStale(record: VideoRecordJSON): boolean {
  const source = record.description_source;
  if (source !== "ShowNotesLlm" && source !== "ShowNotesDeterministic") return false;

  const derivedDoc = record.description_source_doc_id ?? null;
  if (derivedDoc && derivedDoc !== (record.summary_doc_id ?? null)) return true;

  const derivedVersion = record.description_source_prompt_version;
  const currentVersion = record.summary_prompt_version;
  if (derivedVersion == null || currentVersion == null) return false;
  return derivedVersion < currentVersion;
}

/**
 * Write the text and its provenance in one aggregate command, so a
 * later pass can tell who authored this and whether it still matches
 * the Show Notes it came from.
 */
function commitDescription(
  record: VideoRecordJSON,
  text: string,
  source: DescriptionSourceJSON,
  sourceDocId: string | null,
  actorState: ActorState,
): void {
  videoStore.mutate(record.id, (r) =>
    r.set_description_metadata(actorCommand(actorState, {
      text,
      source,
      source_doc_id: sourceDocId,
      // Pin the Show Notes version the text was derived from, so a
      // later Show Notes regen makes this description detectably stale.
      source_prompt_version: sourceDocId ? record.summary_prompt_version ?? null : null,
      generated_at: new Date().toISOString(),
    })),
  );
}

/**
 * Ask the ADR-067 endpoint to rewrite Show Notes markdown into a
 * YouTube-facing description. Throws on any non-success so the caller
 * can fall through to the deterministic converter.
 */
async function llmRewrite(
  showNotes: string,
  opts: { noCap?: boolean; signal?: AbortSignal },
): Promise<string> {
  const res = await fetch("/api/description/from-show-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ show_notes: showNotes, ...(opts.noCap ? { no_cap: true } : {}) }),
    signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `LLM call failed (${res.status})`);
  }
  const text = (data as { text?: string }).text?.trim() ?? "";
  if (text.length < MIN_DESCRIPTION_CHARS) throw new Error("LLM returned empty description");
  return text;
}

/**
 * ADR-074 follow-up — mirror the un-capped long form into the Drive
 * artifact bag for consumers with no 5000-char ceiling (chapter site,
 * Discord digest, MCP clients). Fire-and-forget: the shipped
 * description is unaffected by anything that goes wrong here.
 */
async function writeFullDescriptionVariant(
  record: VideoRecordJSON,
  showNotes: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    let fullText = "";
    try {
      fullText = await llmRewrite(showNotes, { noCap: true, signal });
    } catch {
      /* fall through to the deterministic strip */
    }
    if (fullText.length < MIN_DESCRIPTION_CHARS) {
      fullText = showNotesToDescription(showNotes, { noCap: true });
    }
    if (fullText.length < MIN_DESCRIPTION_CHARS) return;

    await fetch(`/api/artifacts/${encodeURIComponent(record.id)}/description-full`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: fullText,
        title: record.title,
        source_platform: record.source_platform,
        source_id: record.source_id,
        recorded_at: record.recorded_at ?? record.indexed_at ?? new Date().toISOString(),
      }),
      signal,
    });
  } catch {
    /* non-fatal — the shipped description is unaffected */
  }
}

/**
 * Produce a description for one record, or explain why it didn't.
 *
 * Throws only on a genuine failure (both generation paths dead, no
 * transcript when one was required, an unauthorised actor). A record
 * that simply needs no work comes back `{ generated: false, reason }`.
 */
export async function ensureDescription(
  record: VideoRecordJSON,
  opts: EnsureDescriptionOptions,
): Promise<EnsureDescriptionResult> {
  const { actorState, signal, force = false, onEvent, writeFullVariant = true } = opts;

  // The card warms this cache at mount; a headless caller may not have,
  // so fetch rather than assume. Resolves instantly once warm.
  const cfg = await getDescriptionConfig().catch(() => getDescriptionConfigCached());

  if (!force) {
    const skip = describeSkipReason(record, cfg.mode);
    if (skip) return { generated: false, reason: skip };
  }

  const hasShowNotes = !!record.summary_doc_id;

  // ── Path 1: derive from Show Notes ────────────────────────────
  if (cfg.mode === "copy_show_notes" && hasShowNotes) {
    const readRes = await fetch(
      `/api/summary/read?docId=${encodeURIComponent(record.summary_doc_id!)}`,
      { signal },
    );
    if (!readRes.ok) throw new Error(`Show Notes read failed (${readRes.status})`);
    const md = await readRes.text();

    let description = "";
    let source: DescriptionSourceJSON = "ShowNotesLlm";
    let usedFallback = false;
    try {
      description = await llmRewrite(md, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      onEvent?.(
        `DescriptionCopiedFallback: "${record.title}"${dateTag(record.recorded_at)} — LLM path failed (${err instanceof Error ? err.message : String(err)}); using deterministic converter`,
        { video_id: record.id },
      );
      description = showNotesToDescription(md);
      source = "ShowNotesDeterministic";
      usedFallback = true;
      if (description.length < MIN_DESCRIPTION_CHARS) {
        throw new Error("Both LLM and deterministic conversion failed");
      }
    }

    commitDescription(record, description, source, record.summary_doc_id!, actorState);

    if (writeFullVariant) {
      void writeFullDescriptionVariant(record, md, signal);
    }

    onEvent?.(
      `DescriptionCopied: "${record.title}"${dateTag(record.recorded_at)} (${description.length} chars) — from Show Notes via ${usedFallback ? "deterministic_fallback" : "llm"}`,
      { video_id: record.id },
    );
    return { generated: true, source, length: description.length, usedFallback };
  }

  // ── Path 2: derive from the transcript ────────────────────────
  // Reached in `generate` mode, and as the ADR-064 fallback for a
  // `copy_show_notes` record that has no Show Notes yet.
  if (!record.transcript_text || record.transcript_text.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error(
      cfg.mode === "copy_show_notes"
        ? "No Show Notes on Drive and no transcript to fall back on."
        : "Transcript is too short or missing.",
    );
  }

  // ADR-059/060 — summarise the scheduled programme window, not the
  // pre-show chatter. Same trim the publish path applies.
  const attrs = applyProcessingRules(loadProcessingRules(), record, getSeriesRegistryCached());
  const trimStart = Math.max(0, Math.floor(attrs.trim_start_seconds ?? 0));
  const trimEnd = Math.max(0, Math.floor(attrs.trim_end_seconds ?? 0));
  const duration = record.duration_seconds || 0;

  let transcript = record.transcript_text;
  if (trimStart > 0) transcript = sliceTranscriptFromSeconds(transcript, trimStart);
  if (trimEnd > 0 && duration > trimEnd) {
    transcript = sliceTranscriptToSeconds(transcript, duration - trimEnd);
  }
  // A trim that ate the whole transcript means the rule doesn't fit this
  // record; fall back to the untrimmed text rather than summarising air.
  const finalTranscript =
    transcript.length >= MIN_TRANSCRIPT_CHARS ? transcript : record.transcript_text;

  const result = await requestLlmSummary(finalTranscript);
  const description = result.summary?.trim();
  if (!description) throw new Error("LLM returned no summary text");

  commitDescription(record, description, "Transcript", null, actorState);

  onEvent?.(
    `DescriptionGenerated: "${record.title}"${dateTag(record.recorded_at)} (${description.length} chars) — from transcript${cfg.mode === "copy_show_notes" ? " (Show Notes fallback)" : ""}`,
    { video_id: record.id },
  );
  return { generated: true, source: "Transcript", length: description.length };
}

/**
 * Records an unattended pass would act on, without acting. The
 * pre-flight count for a bulk description refresh, mirroring
 * `findRecordsNeedingSummaryBadge` (ADR-052).
 */
export function findRecordsNeedingDescription(
  records: VideoRecordJSON[],
  mode: "copy_show_notes" | "generate",
): Array<{ record: VideoRecordJSON; reason: "missing" | "stale" }> {
  const out: Array<{ record: VideoRecordJSON; reason: "missing" | "stale" }> = [];
  for (const record of records) {
    if (describeSkipReason(record, mode) !== null) continue;
    const existing = (record.description ?? "").trim();
    out.push({ record, reason: existing.length === 0 ? "missing" : "stale" });
  }
  return out;
}
