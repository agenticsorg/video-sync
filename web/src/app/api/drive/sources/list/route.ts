/**
 * POST /api/drive/sources/list
 *
 * Body: { folder_id: string, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
 * Response: DriveSourceListResponse
 *
 * ADR-078 §2 — list the video files in a registered folder over a date
 * window. Deliberately the same contract shape as /api/kaltura/list so
 * the import panel can reuse the preview-and-select UI.
 *
 * One folder, no recursion (§2): Drive has no recursive query, so
 * recursion is a crawl to write and bound, not a flag to set. Deferred.
 *
 * The folder must be in the registry. The route refuses arbitrary
 * folder ids from the client — that's the behavioural narrowing that
 * keeps `drive.readonly` from being usable as a general Drive browser
 * (§Consequences).
 *
 * Two dedupe passes and one exclusion run over the results:
 *   §4 already_indexed — a record already holds source_id drive-<id>
 *   §4 duplicate_of    — another record holds identical bytes (md5)
 *   §5 guard 1         — files we published INTO this folder are
 *                        dropped, so the app never offers its own
 *                        output back as a new source record
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { withRequestLogging, serverLog } from "../../../../../lib/serverLogger";
import { getActor } from "../../../../../lib/auth";
import { readCatalog } from "../../../../../lib/catalogStore";
import type { VideoRecordJSON } from "../../../../../lib/wasm";
import { driveReadonlyToken } from "../route";
import {
  DRIVE_LIST_MAX_FILES,
  DRIVE_LIST_PAGE_SIZE,
  classifyDriveFile,
  collectDriveFacts,
  type DriveSourceFile,
  type DriveSourceFolder,
} from "../../../../../lib/driveSources";

export const dynamic = "force-dynamic";

const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
const FILE = () => join(process.cwd(), "data", "drive-sources.json");

const FIELDS =
  "nextPageToken, files(id,name,mimeType,size,createdTime,modifiedTime," +
  "videoMediaMetadata(durationMillis),thumbnailLink,webViewLink," +
  "owners(emailAddress),md5Checksum)";

interface DriveApiFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  videoMediaMetadata?: { durationMillis?: string };
  thumbnailLink?: string;
  webViewLink?: string;
  owners?: Array<{ emailAddress?: string }>;
  md5Checksum?: string;
}

async function registeredFolders(): Promise<DriveSourceFolder[]> {
  try {
    const raw = await fs.readFile(FILE(), "utf-8");
    const parsed = JSON.parse(raw) as { folders?: DriveSourceFolder[] };
    return Array.isArray(parsed.folders) ? parsed.folders : [];
  } catch {
    return [];
  }
}

/**
 * Build the Drive query. `mimeType contains 'video/'` does at the query
 * layer what ADR-071 §1's per-file guard does — Docs, images and PDFs
 * never enter the result set, so the operator never sees a row that
 * would fail on import.
 */
export function buildQuery(folderId: string, from?: string, to?: string): string {
  const clauses = [
    `'${folderId.replace(/'/g, "\\'")}' in parents`,
    `mimeType contains 'video/'`,
    `trashed = false`,
  ];
  // Drive wants an RFC-3339 instant. A bare YYYY-MM-DD `to` must cover
  // the whole day, so it becomes the end of that day rather than
  // midnight — otherwise "to: today" silently excludes today.
  if (from) clauses.push(`createdTime >= '${from}T00:00:00'`);
  if (to) clauses.push(`createdTime <= '${to}T23:59:59'`);
  return clauses.join(" and ");
}

function normalise(f: DriveApiFile): Omit<DriveSourceFile, "already_indexed"> {
  const millis = Number(f.videoMediaMetadata?.durationMillis ?? NaN);
  return {
    file_id: f.id,
    name: f.name,
    mime_type: f.mimeType,
    size_bytes: f.size != null ? Number(f.size) : null,
    duration_seconds: Number.isFinite(millis) ? Math.round(millis / 1000) : null,
    created_time: f.createdTime ?? null,
    modified_time: f.modifiedTime ?? null,
    thumbnail_link: f.thumbnailLink ?? null,
    web_view_link: f.webViewLink ?? null,
    owner_email: f.owners?.[0]?.emailAddress ?? null,
    md5_checksum: f.md5Checksum ?? null,
  };
}

async function handler(req: NextRequest) {
  try {
    await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }

  let body: { folder_id?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const folderId = (body.folder_id ?? "").trim();
  if (!folderId) {
    return NextResponse.json({ error: "folder_id required" }, { status: 400 });
  }

  // Registry membership is the access control. Without it this route
  // would be a general-purpose Drive browser for anything the service
  // account can see.
  const folders = await registeredFolders();
  const folder = folders.find(f => f.folder_id === folderId);
  if (!folder) {
    return NextResponse.json(
      { error: "That folder is not a registered Drive source. Add it in Config → Drive source folders first." },
      { status: 404 },
    );
  }
  if (!folder.enabled) {
    return NextResponse.json({ error: `Folder "${folder.label}" is disabled.` }, { status: 409 });
  }

  const token = await driveReadonlyToken();
  if (!token) {
    return NextResponse.json({ error: "Could not mint a Drive token for the service account." }, { status: 502 });
  }

  const q = buildQuery(folderId, body.from, body.to);
  const raw: DriveApiFile[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  do {
    const url = new URL(`${DRIVE_V3}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("orderBy", "createdTime desc");
    url.searchParams.set("pageSize", String(DRIVE_LIST_PAGE_SIZE));
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      serverLog("warn", "api:drive/sources/list", "drive-list-failed", {
        folder_id: folderId, status: res.status, detail: detail.slice(0, 300),
      });
      return NextResponse.json(
        { error: `Drive list failed (${res.status}) for "${folder.label}".` },
        { status: res.status === 403 || res.status === 404 ? 403 : 502 },
      );
    }
    const page = (await res.json()) as { files?: DriveApiFile[]; nextPageToken?: string };
    raw.push(...(page.files ?? []));
    pageToken = page.nextPageToken;

    if (raw.length >= DRIVE_LIST_MAX_FILES) {
      truncated = Boolean(pageToken) || raw.length > DRIVE_LIST_MAX_FILES;
      raw.length = Math.min(raw.length, DRIVE_LIST_MAX_FILES);
      break;
    }
  } while (pageToken);

  // ── Dedupe + exclusion against the catalog (§4, §5) ─────────────
  // The rules themselves live in lib/driveSources so they're testable
  // without a Drive round trip; this just feeds them the catalog.
  const store = await readCatalog();
  const parsed: VideoRecordJSON[] = [];
  for (const rawRecord of Object.values(store.records)) {
    try {
      parsed.push(JSON.parse(rawRecord) as VideoRecordJSON);
    } catch {
      // A single unparseable record must not fail the whole listing.
    }
  }
  const facts = collectDriveFacts(parsed);

  const files: DriveSourceFile[] = [];
  let excludedOwnOutput = 0;
  for (const f of raw) {
    const row = classifyDriveFile(normalise(f), facts);
    if (!row) { excludedOwnOutput++; continue; }
    files.push(row);
  }

  if (excludedOwnOutput > 0) {
    serverLog("info", "api:drive/sources/list", "excluded-own-published-output", {
      folder_id: folderId, count: excludedOwnOutput,
    });
  }

  return NextResponse.json({ files, total: files.length, truncated });
}

export const POST = withRequestLogging("api:drive/sources/list", handler as never);
