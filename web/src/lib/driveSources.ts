/**
 * ADR-078 — Drive source folders: shared types.
 *
 * Imported by both the API routes and the client, so the registry's
 * shape has one definition. No I/O here; the server route owns
 * persistence (data/drive-sources.json) and driveSourcesClient owns
 * the browser-side accessor.
 */

/** One registered Drive folder we treat as a source (ADR-078 §1). */
export interface DriveSourceFolder {
  /** Our uuid. Stable across folder renames, and the value recorded
   *  in `metadata_extra.drive_source_folder` on ingested records. */
  id: string;
  /** Drive folder id. A full folder URL is accepted on input and
   *  normalised to the bare id before storage. */
  folder_id: string;
  /** Operator-facing name. Also the import-state source key suffix
   *  (ADR-078 §7): `GoogleDrive:<label>`. */
  label: string;
  /** Off excludes the folder from listing, and from any future sweep. */
  enabled: boolean;
  /** Optional bridge to the series registry. A hint that feeds title
   *  alignment, never an authority — ADR-078 §1. */
  series_name?: string;
  added_by: string;
  added_at: string;
}

/** One video file found in a registered folder (ADR-078 §2). */
export interface DriveSourceFile {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  created_time: string | null;
  modified_time: string | null;
  thumbnail_link: string | null;
  web_view_link: string | null;
  owner_email: string | null;
  /** Drive's content hash. Recorded on import so a re-upload under a
   *  fresh file id is detectable — ADR-078 §4. */
  md5_checksum: string | null;
  /** A catalog record already carries source_id `drive-<file_id>`.
   *  Rendered greyed and excluded from select-all. */
  already_indexed: boolean;
  /** Set when some other record holds identical bytes under a
   *  different Drive id. Advisory: flagged, never auto-merged. */
  duplicate_of?: string;
}

export interface DriveSourceListResponse {
  files: DriveSourceFile[];
  total: number;
  /** The 500-file cap bit. Narrow the date window to see the rest. */
  truncated: boolean;
}

/** Max files one list call will return, across all pages (ADR-078 §2). */
export const DRIVE_LIST_MAX_FILES = 500;

/** Drive's own page size; we walk nextPageToken up to the cap above. */
export const DRIVE_LIST_PAGE_SIZE = 100;

/**
 * Pull the bare folder id out of whatever the operator pasted —
 * a folder URL, a URL with query junk, or the id itself.
 *
 * Returns null when the input doesn't look like a folder reference,
 * so the caller can say so rather than sending garbage to Drive.
 */
export function detectFolderId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // https://drive.google.com/drive/folders/<id>?usp=sharing
  let m = s.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/i);
  if (m) return m[1];
  // https://drive.google.com/open?id=<id>
  m = s.match(/drive\.google\.com\/open\?[^"']*id=([A-Za-z0-9_-]{10,})/i);
  if (m) return m[1];
  // Bare id.
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

/**
 * What kind of thing a pasted Drive URL points at.
 *
 * The Drive tab stacks two inputs — register-a-folder and
 * paste-a-single-file — and a Drive link is valid for exactly one of
 * them. Telling an operator "paste a folder link" when they have just
 * pasted a perfectly good *file* link is technically true and useless:
 * it describes what the field wants without acknowledging what they
 * gave it, or where the thing they gave it belongs.
 *
 * `unknown` is the honest answer for `open?id=` and bare ids, which
 * Drive uses for files and folders alike — the caller should try its
 * own interpretation rather than guess on the operator's behalf.
 */
export type DriveLinkKind = "file" | "folder" | "google-doc" | "unknown";

export interface DriveLinkGuess {
  kind: DriveLinkKind;
  /** The id, when the shape carried one. */
  id: string | null;
}

export function classifyDriveLink(input: string): DriveLinkGuess {
  const s = input.trim();
  if (!s) return { kind: "unknown", id: null };

  let m = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/i);
  if (m) return { kind: "file", id: m[1] };

  m = s.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/i);
  if (m) return { kind: "folder", id: m[1] };

  // Google-native docs are never videos (ADR-071 §1's mimeType guard
  // rejects them downstream); naming them here fails faster and clearer.
  m = s.match(/docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]{10,})/i);
  if (m) return { kind: "google-doc", id: m[1] };

  // open?id= / uc?id= are used for both files and folders; a bare id
  // tells us nothing either. Hand back the id and let the caller try.
  m = s.match(/drive\.google\.com\/(?:open|uc)\?[^"']*id=([A-Za-z0-9_-]{10,})/i);
  if (m) return { kind: "unknown", id: m[1] };
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return { kind: "unknown", id: s };

  return { kind: "unknown", id: null };
}

/**
 * The message for a link that is valid but belongs in the other box.
 *
 * `expected` is what the field being typed into wants. Returns null when
 * the input isn't a recognisable mismatch, so the caller falls back to
 * its own generic message.
 */
export function wrongLinkKindMessage(
  input: string,
  expected: "file" | "folder",
): string | null {
  const { kind } = classifyDriveLink(input);

  if (expected === "folder" && kind === "file") {
    return "That's a link to a single file, not a folder. Open the folder in Drive and copy the URL from " +
           "the address bar — a folder link contains /drive/folders/. " +
           "To import just this one file instead, use the “paste a single file link” box on Import → Drive.";
  }
  if (expected === "file" && kind === "folder") {
    return "That's a link to a folder, not a single file. Folders are registered once in " +
           "Config → Drive source folders, and then browsed from the folder picker above — " +
           "that lists every video in them so you can pick what to import.";
  }
  if (kind === "google-doc") {
    return "That's a Google Doc / Sheet / Slides link, not a video. Only video files can be imported.";
  }
  return null;
}

/** The import-state source key for a folder (ADR-078 §7). */
export function importStateKey(folder: Pick<DriveSourceFolder, "label">): string {
  return `GoogleDrive:${folder.label}`;
}

// ── Dedupe + exclusion (ADR-078 §4, §5) ─────────────────────────────
//
// Extracted from the list route so the three rules that decide what an
// operator is offered are testable without a Drive round trip.

/** What the catalog knows that bears on a folder listing. */
export interface CatalogDriveFacts {
  /** `drive-<file_id>` for every GoogleDrive-sourced record. */
  indexedSourceIds: Set<string>;
  /** Content hash → the record that already holds those bytes. */
  md5ToRecord: Map<string, string>;
  /** Drive file ids this app published INTO a folder. */
  publishedFileIds: Set<string>;
}

/** Minimal record shape these rules need — keeps the helper usable from
 *  the server route (which parses raw JSON) and from tests. */
interface DriveFactsRecord {
  id: string;
  source_platform: string;
  source_id: string;
  metadata_extra?: Record<string, unknown> | null;
  locations?: Array<{ platform: string; role: string; external_id: string }>;
}

export function collectDriveFacts(records: DriveFactsRecord[]): CatalogDriveFacts {
  const indexedSourceIds = new Set<string>();
  const md5ToRecord = new Map<string, string>();
  const publishedFileIds = new Set<string>();

  for (const rec of records) {
    if (rec.source_platform === "GoogleDrive" && typeof rec.source_id === "string") {
      indexedSourceIds.add(rec.source_id);
    }
    const md5 = rec.metadata_extra?.drive_md5;
    // First writer wins, so `duplicate_of` points at the oldest record
    // holding these bytes rather than flapping with catalog order.
    if (typeof md5 === "string" && md5 && !md5ToRecord.has(md5)) {
      md5ToRecord.set(md5, rec.id);
    }
    // §5 guard 1 — keyed on file id alone, not on folder: a Drive file
    // id is globally unique, so if we published it, it is ours wherever
    // it now sits.
    for (const loc of rec.locations ?? []) {
      if (loc.platform === "GoogleDrive" && loc.role === "Destination" && loc.external_id) {
        publishedFileIds.add(loc.external_id);
      }
    }
  }
  return { indexedSourceIds, md5ToRecord, publishedFileIds };
}

/**
 * Apply the three rules to one listed file.
 *
 * Returns `null` when the file is this app's own published output and
 * must not be offered at all (§5). Otherwise returns the row with its
 * `already_indexed` (§4, authoritative) and `duplicate_of` (§4,
 * advisory) flags resolved.
 */
export function classifyDriveFile(
  base: Omit<DriveSourceFile, "already_indexed" | "duplicate_of">,
  facts: CatalogDriveFacts,
): DriveSourceFile | null {
  if (facts.publishedFileIds.has(base.file_id)) return null;

  const alreadyIndexed = facts.indexedSourceIds.has(`drive-${base.file_id}`);
  // A row that is already indexed needs no duplicate hint — it IS the
  // record. Only an unindexed file whose bytes we already hold is news.
  const duplicateOf = !alreadyIndexed && base.md5_checksum
    ? facts.md5ToRecord.get(base.md5_checksum)
    : undefined;

  return {
    ...base,
    already_indexed: alreadyIndexed,
    ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
  };
}
