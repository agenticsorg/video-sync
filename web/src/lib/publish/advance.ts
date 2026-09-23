"use client";

/**
 * ADR-079 §1 — the publish orchestration, extracted from VideoCard.
 *
 * `executePublish` (execute.ts) walks a destination set and reports what
 * each one did. Everything AROUND that walk — recording outcomes on the
 * aggregate, the observed-visibility annotation, the failure bookkeeping,
 * the post-processing rules, the event-log lines, the whole-record
 * verdict — lived in a ~180-line closure inside VideoCard, so the only
 * way to publish anything was to render a React component.
 *
 * That is the same shape the description policy was in until
 * 2026-09-23, and it has the same consequence: ADR-047 deferred the
 * catch-up sweep's publish stages on exactly this blocker, and the
 * deferral outlived two ADRs.
 *
 * This is a MOVE. No policy changes here — the sequencing, the guards,
 * the event strings and the ADR-077 outcome semantics are all as they
 * were in the card, so the extraction can be reviewed as a refactor and
 * the card's behaviour verified unchanged before any new caller exists.
 *
 * Still client-side (videoStore, actorCommand), like
 * descriptionGenerate. ADR-079 §6 moves it server-side; that is a
 * separate change and this one deliberately doesn't anticipate it.
 */

import type { VideoRecordJSON } from "../wasm";
import { videoStore } from "../store";
import { actorCommand } from "../useCurrentActor";
import type { DestinationSpec } from "../youtubeTitleAlign";
import { destinationLabel } from "../destinationResolver";
import {
  executePublish,
  type DestinationResult,
  type ExecutePublishReport,
} from "./execute";
import { withProvenanceFooter, recordProvenanceParts } from "./provenanceFooter";
import {
  firePostProcessingRules,
  loadPostProcessingRules,
  type PublishAttributes,
} from "../processingRules";
import type { PublishCredentials } from "./types";

export type ActorState = Parameters<typeof actorCommand>[0];

/** Platforms the aggregate can record an outcome for. */
type OutcomePlatform = "YouTube" | "Kaltura" | "GoogleDrive";

export interface AdvancePublishRequest {
  record: VideoRecordJSON;
  /** Already filtered to automated destinations by the caller. */
  targets: DestinationSpec[];
  attrs: PublishAttributes;
  actorState: ActorState;
  creds: PublishCredentials;
  sourceUrlFor: (spec: DestinationSpec) => string;
  /** Kaltura's source picker result, purely so the event line can say
   *  the push was sourced from an upstream rather than the primary. */
  kalturaSource?: { platform: string; chosenOverPrimary: boolean };
  onPhase?: (phase: string) => void;
  onEvent: (message: string, ctx?: { video_id?: string }) => void;
  /** Called after each successful YouTube push. The privacy cache and
   *  the ADR-051 source-row ingest are browser concerns, so they stay
   *  with the caller rather than being reimplemented here. */
  onYouTubePushed?: (videoId: string, privacyStatus: string) => void;
}

export type AdvanceStatus =
  /** Every declared destination landed. */
  | "published"
  /** At least one landed, at least one didn't (ADR-077: still Published). */
  | "partial"
  /** Nothing landed. */
  | "failed"
  /** Something outside a per-destination push broke. */
  | "error";

export interface AdvancePublishResult {
  status: AdvanceStatus;
  report?: ExecutePublishReport;
  /** Operator-facing text for the card's error banner. Absent on a
   *  clean publish. Raw — the caller runs it through its own
   *  classifier, as the card always did. */
  message?: string;
  /** Last destination URL that landed, for the post-processing rules. */
  lastPushedUrl?: string;
}

function dateTag(recordedAt: string | null | undefined): string {
  if (!recordedAt) return "";
  const d = new Date(recordedAt);
  return Number.isNaN(d.getTime()) ? "" : ` (${d.toISOString().slice(0, 10)})`;
}

/**
 * Record a destination that landed.
 *
 * Exported because the per-platform side-publish handlers (Kaltura,
 * YouTube-only, Drive) need exactly this and used to carry their own
 * copy. Two implementations of "record a destination" can drift, and
 * drift in this specific pair is what produced the 2026-09-23 incident.
 *
 * Returns false when the aggregate refused the command and we fell back
 * to a bare location edit — the caller's event line distinguishes the
 * two, because "recorded as an outcome" and "recorded as a location"
 * mean different things to ADR-077's completeness checks.
 */
export function recordPushed(
  record: VideoRecordJSON,
  actorState: ActorState,
  platform: OutcomePlatform,
  externalId: string,
  externalUrl: string,
): boolean {
  const canRecord = record.status === "Publishing" || record.status === "Published";
  if (canRecord) {
    try {
      videoStore.mutate(record.id, (r) =>
        r.recordDestinationResult(actorCommand(actorState, {
          platform,
          external_id: externalId,
          external_url: externalUrl,
        })),
      );
      return true;
    } catch {
      // Fall through to the location edit rather than losing the
      // destination entirely — a rejected command must not mean the
      // operator's successful upload goes unrecorded.
    }
  }
  videoStore.mutate(record.id, (r) =>
    r.add_location(actorCommand(actorState, {
      platform,
      external_id: externalId,
      external_url: externalUrl,
      role: "Destination",
    })),
  );
  return false;
}

/**
 * Record a destination that did NOT land.
 *
 * Deliberately separate from recordPushed: that one falls back to
 * add_location(role: "Destination"), which would have the record claim
 * the video is on a platform the push never reached.
 *
 * Incident 2026-09-23: this call didn't exist. YouTube failed, Kaltura
 * succeeded, and the record held a single Pushed outcome — so
 * is_fully_published() and missing_destinations(), both computed from
 * destination_outcomes, saw nothing outstanding.
 */
export function recordFailed(
  record: VideoRecordJSON,
  actorState: ActorState,
  platform: OutcomePlatform,
  error: string,
  onEvent: AdvancePublishRequest["onEvent"],
): void {
  if (record.status !== "Publishing" && record.status !== "Published") return;
  try {
    videoStore.mutate(record.id, (r) =>
      r.recordDestinationResult(actorCommand(actorState, { platform, error })),
    );
  } catch (err) {
    onEvent(
      `DestinationFailureUnrecorded: "${record.title}" — could not record ${platform} failure on the record: ${err instanceof Error ? err.message : String(err)}`,
      { video_id: record.id },
    );
  }
}

/** ADR-077 §5 — what the platform's visibility actually is, where the
 *  adapter could read it back. Declared and observed side by side is
 *  what makes §6's conformance check possible. */
function recordObservedVisibility(
  record: VideoRecordJSON,
  platform: string,
  visibility: string,
): void {
  try {
    videoStore.mutate(record.id, (r) =>
      r.recordObservedVisibility(JSON.stringify({ platform, visibility })),
    );
  } catch {
    /* no outcome for this platform yet — nothing to annotate */
  }
}

/**
 * Publish a record to its resolved destination set, recording what each
 * one did.
 *
 * Never throws for a per-destination failure — the executor absorbs
 * those and they come back in the report. A thrown error means
 * something outside a push broke, and surfaces as `status: "error"`.
 */
export async function advanceToPublished(
  req: AdvancePublishRequest,
): Promise<AdvancePublishResult> {
  const { record, targets, attrs, actorState, creds, sourceUrlFor, onEvent, onPhase } = req;
  let lastPushedUrl: string | undefined;

  try {
    const report = await executePublish({
      record,
      destinations: targets,
      attrsFor: (spec) => ({
        title: attrs.title ?? record.title,
        description: withProvenanceFooter(
          attrs.description ?? record.description,
          recordProvenanceParts(record),
          spec.platform,
        ),
        tags: attrs.tags ?? record.tags ?? [],
        // Every platform takes the visibility its resolved spec carries.
        //
        // This used to read `attrs.privacy_status` for YouTube, on the
        // grounds that the preview dropdown is ADR-075's layer-4
        // per-record override. But that field is not an override — it is
        // applyProcessingRules' unconditional default of "unlisted"
        // unless a rule happened to set it, so a series declaring
        // `visibility: "public"` was silently published unlisted with
        // nothing on screen disagreeing.
        //
        // The resolver already layers this correctly: global default,
        // then the series declaration, then a rule transform. Layer 4 is
        // applied by the caller via withPreviewVisibilityOverride, so by
        // the time a spec reaches here its visibility IS the answer.
        visibility: spec.platform === "YouTube" || spec.platform === "Kaltura"
          ? spec.visibility
          : undefined,
        trimStartSeconds: attrs.trim_start_seconds,
      }),
      sourceUrlFor,
      creds,
      onPhase,
      onOutcome: (outcome: DestinationResult) => {
        const label = destinationLabel(outcome.spec);

        if (outcome.status === "skipped") {
          onEvent(
            `PublishSkipped: "${record.title}"${dateTag(record.recorded_at)} — ${outcome.skipReason}`,
            { video_id: record.id },
          );
          return;
        }

        if (outcome.status === "failed") {
          onEvent(
            `VideoPublishFailed: "${record.title}"${dateTag(record.recorded_at)} — ${label}: ${outcome.error}`,
            { video_id: record.id },
          );
          recordFailed(
            record,
            actorState,
            outcome.spec.platform as OutcomePlatform,
            outcome.error ?? "publish failed",
            onEvent,
          );
          return;
        }

        const id = outcome.external_id!;
        const url = outcome.external_url ?? "";
        lastPushedUrl = url || lastPushedUrl;
        recordPushed(record, actorState, outcome.spec.platform as OutcomePlatform, id, url);

        const sourcedFrom =
          outcome.spec.platform === "Kaltura" && req.kalturaSource?.chosenOverPrimary
            ? ` (sourced from ${req.kalturaSource.platform})`
            : "";
        onEvent(
          `VideoPublished: "${record.title}"${dateTag(record.recorded_at)} -> ${label} ${url}${sourcedFrom}`,
          { video_id: record.id },
        );

        if (outcome.observed_visibility) {
          recordObservedVisibility(record, outcome.spec.platform, outcome.observed_visibility);
        }
        if (outcome.visibility_applied === false) {
          onEvent(
            `PublishVisibilityNotApplied: "${record.title}"${dateTag(record.recorded_at)} — ${label} landed but its declared visibility did not take: ${outcome.visibility_error ?? "unknown reason"}`,
            { video_id: record.id },
          );
        }

        if (outcome.spec.platform === "YouTube") {
          req.onYouTubePushed?.(id, attrs.privacy_status);
        }
      },
    });

    if (!report.anyPushed) {
      // Nothing landed. The aggregate has already moved the record to
      // Failed via record_destination_result when every declared
      // destination failed, so mark_failed is best-effort here — it
      // covers the case where no outcome was recorded at all (e.g. every
      // target skipped).
      const detail = report.results
        .map(r => `${destinationLabel(r.spec)}: ${r.error ?? r.skipReason ?? "not attempted"}`)
        .join("; ");
      try {
        videoStore.mutate(record.id, (r) => r.mark_failed(JSON.stringify({ error_message: detail })));
      } catch {
        /* already Failed, or not in a state that accepts it */
      }
      firePostProcessingRules(loadPostProcessingRules(), false, record, undefined, detail);
      return { status: "failed", report, message: detail };
    }

    firePostProcessingRules(loadPostProcessingRules(), true, record, lastPushedUrl);

    if (report.failed > 0) {
      // Partial publish: the record is Published (ADR-077
      // §Decisions-resolved #1) but the operator needs to know which
      // destination still needs attention.
      const failedLabels = report.results
        .filter(r => r.status === "failed")
        .map(r => `${destinationLabel(r.spec)}: ${r.error}`)
        .join("; ");
      return {
        status: "partial",
        report,
        lastPushedUrl,
        message: `Published, but ${report.failed} destination(s) failed — ${failedLabels}`,
      };
    }

    return { status: "published", report, lastPushedUrl };
  } catch (err) {
    // The executor absorbs per-destination failures, so reaching here
    // means something outside a push broke.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      videoStore.mutate(record.id, (r) => r.mark_failed(JSON.stringify({ error_message: msg })));
    } catch {
      /* not in a state that accepts it */
    }
    onEvent(
      `VideoPublishFailed: "${record.title}"${dateTag(record.recorded_at)} — ${msg}`,
      { video_id: record.id },
    );
    firePostProcessingRules(loadPostProcessingRules(), false, record, undefined, msg);
    return { status: "error", message: msg };
  }
}
