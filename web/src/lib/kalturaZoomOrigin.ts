/**
 * Recovering a Kaltura entry's true origin from its `referenceId`.
 *
 * Isomorphic — pure, no I/O.
 *
 * Kaltura's Zoom connector ingests Zoom recordings automatically, and
 * stamps the resulting entry with a structured reference id:
 *
 *     Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
 *          └──── Zoom meeting UUID ───┘└─ recording start ─┘
 *
 * That is a deterministic join key, not a heuristic. Our Zoom records
 * store `source_id: "zoom-<UUID>"` with exactly the same base64 form,
 * so a Kaltura entry can be matched to its Zoom recording by identity.
 * ADR-044 deferred this problem to "fuzzy title + recorded-at match";
 * no fuzzy match is needed, and none should be used while this field
 * is present.
 *
 * Two facts the reference id carries that we otherwise get wrong:
 *
 * 1. WHERE IT CAME FROM. A record imported from Kaltura is stored with
 *    `role: Origin`, asserting Kaltura is where the content
 *    originated. For a connector-ingested entry that is false — the
 *    origin is a Zoom meeting, and Kaltura is a destination reached by
 *    a path this app did not drive. All 11 Kaltura-origin records in
 *    the catalog carry no upstream link at all.
 *
 * 2. WHEN IT WAS RECORDED. The importer uses Kaltura's `createdAt` as
 *    `recorded_at`, which is when KALTURA INGESTED the entry, not when
 *    the meeting happened. Entry 1_b8kw2g8u is stored as
 *    2026-09-25T18:13:49Z; its reference id says the recording started
 *    at 15:45:02Z — two and a half hours earlier. Every date-sensitive
 *    behaviour downstream (ADR-048 date gates, ADR-060 show windows,
 *    the Overview) is reading an ingest timestamp as a recording time.
 *
 * ── Parsing ──────────────────────────────────────────────────────────
 * A Zoom meeting UUID is base64 of 16 bytes: 24 characters ending in
 * `==`, drawn from `A-Za-z0-9+/=`. Real examples from the catalog
 * contain both `/` and `+`:
 *
 *     zoom-63IjvIEHTsqZf5Nt/5mZbA==
 *     zoom-GH+WEUvhRR+Ax9rLBu9vlA==
 *
 * So the UUID must NOT be obtained by splitting on `==` — that is
 * padding, and treating it as a separator is the kind of assumption
 * that reads fine and breaks on a value nobody tested. The timestamp
 * is anchored at the end instead, and its alphabet (`-`, `:`, `T`,
 * `Z`) is disjoint from base64's, so the boundary is unambiguous.
 */

/** `Zoom_<uuid><ISO-8601 instant>`, anchored on the trailing instant. */
const ZOOM_REFERENCE_RE = /^Zoom_(.+?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/;

export interface KalturaZoomOrigin {
  /** Zoom meeting UUID, exactly as Zoom reports it. */
  meeting_uuid: string;
  /** `zoom-<uuid>` — the `source_id` a Zoom record is stored under. */
  source_id: string;
  /** `zoom://recording/<uuid>` — the `download_url` form. */
  download_url: string;
  /** When the recording actually started, per the connector. */
  recorded_at: string;
}

/**
 * Parse a Kaltura `referenceId` that the Zoom connector wrote.
 *
 * Returns null for anything else — including reference ids this app
 * writes itself, which are bare catalog UUIDs (ADR-044).
 */
export function parseZoomReferenceId(referenceId: string | null | undefined): KalturaZoomOrigin | null {
  if (!referenceId) return null;
  const m = referenceId.trim().match(ZOOM_REFERENCE_RE);
  if (!m) return null;
  const uuid = m[1];
  if (!uuid) return null;
  return {
    meeting_uuid: uuid,
    source_id: `zoom-${uuid}`,
    download_url: `zoom://recording/${uuid}`,
    recorded_at: m[2],
  };
}

/** A catalog UUID, which is what THIS app writes to `referenceId`. */
const CATALOG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReferenceIdKind = "ours" | "zoom" | "foreign" | "absent";

/**
 * Who wrote this entry's `referenceId`.
 *
 * The field is overloaded: ADR-044 sets it to the catalog UUID on
 * publish, while the Zoom connector sets its own structured value.
 * The distinction matters most to the ADR-044 presence sweep, which
 * matches `filter[referenceIdIn]` against our UUIDs and then falls
 * back to parsing the ADR-022 description footer. A connector-created
 * entry has neither, so the sweep reports `absent` — and the card then
 * invites a publish of a recording Kaltura already holds.
 */
export function classifyReferenceId(referenceId: string | null | undefined): ReferenceIdKind {
  if (!referenceId || !referenceId.trim()) return "absent";
  if (CATALOG_UUID_RE.test(referenceId.trim())) return "ours";
  if (parseZoomReferenceId(referenceId)) return "zoom";
  return "foreign";
}

/** The minimum of a record this module needs. */
export interface OriginMatchRecord {
  id: string;
  source_platform: string;
  source_id: string;
}

/**
 * The catalog record for the Zoom recording this Kaltura entry came
 * from, if we hold one.
 *
 * Identity, not similarity: no titles, no dates, no thresholds. A null
 * means we do not have that Zoom recording indexed — which is a real
 * and common answer, since the catalog holds 15 Zoom records while the
 * Kaltura originals run back further than Zoom's retention.
 */
export function findZoomOriginRecord<T extends OriginMatchRecord>(
  origin: KalturaZoomOrigin,
  records: readonly T[],
): T | null {
  return records.find(r => r.source_platform === "Zoom" && r.source_id === origin.source_id) ?? null;
}
