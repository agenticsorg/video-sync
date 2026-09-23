/**
 * GET  /api/drive/sources  → { folders: DriveSourceFolder[], service_account?: string }
 * PUT  /api/drive/sources  → replace the whole list (Admin only)
 *
 * ADR-078 §1 — the registry of Drive folders treated as sources.
 * Storage: data/drive-sources.json on the FUSE-mounted GCS bucket,
 * whole-list replace, last-writer-wins (the ADR-031 pattern, same as
 * /api/backfill/profiles).
 *
 * Writes are Admin-gated. ADR-078 §1 said "matching /api/series-registry",
 * but that route turns out to have no gate at all — so this follows
 * /api/admin/automation instead, which is what the ADR meant.
 *
 * Two validations run before anything is persisted, both from the ADR:
 *
 *   §6 — the runtime service account must be able to SEE the folder.
 *        `drive.readonly` is not a skeleton key; the SA still needs
 *        Shared Drive membership or a direct share. We probe each new
 *        folder and refuse the save with the SA's address, rather than
 *        storing a folder that would list empty forever.
 *
 *   §5 — a folder that is already an ADR-075 GoogleDrive *destination*
 *        is refused outright. Registering where-we-publish as
 *        where-we-look-for-work would offer our own output back as new
 *        source records.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { GoogleAuth } from "google-auth-library";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";
import type { DriveSourceFolder } from "../../../../lib/driveSources";

export const dynamic = "force-dynamic";

const FILE = () => join(process.cwd(), "data", "drive-sources.json");
const SERIES_FILE = () => join(process.cwd(), "data", "series-registry.json");
const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface Store {
  folders: DriveSourceFolder[];
}

async function read(): Promise<Store> {
  try {
    const raw = await fs.readFile(FILE(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { folders: Array.isArray(parsed.folders) ? parsed.folders : [] };
  } catch {
    return { folders: [] };
  }
}

async function write(store: Store): Promise<void> {
  await fs.mkdir(join(process.cwd(), "data"), { recursive: true });
  await fs.writeFile(FILE(), JSON.stringify(store, null, 2), "utf-8");
}

/** Mint a drive.readonly access token from the runtime service account.
 *  NOT lib/drive.ts's client — that one holds `drive.file`, which only
 *  reaches files the app itself created and so can never see an
 *  operator's folder (ADR-078 §6). */
export async function driveReadonlyToken(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    const client = await auth.getClient();
    const resp = await client.getAccessToken();
    return resp.token ?? null;
  } catch {
    return null;
  }
}

/** The runtime SA's own address, for the "share the folder with…" hint.
 *  Best-effort: a local dev box on user ADC has no client_email. */
async function serviceAccountEmail(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    const creds = await auth.getCredentials();
    return creds.client_email ?? null;
  } catch {
    return null;
  }
}

type ProbeResult =
  | { ok: true; name: string }
  | { ok: false; status: number; reason: string };

/** ADR-078 §6 — can the SA actually see this folder, and is it one? */
async function probeFolder(folderId: string): Promise<ProbeResult> {
  const token = await driveReadonlyToken();
  if (!token) return { ok: false, status: 401, reason: "no_service_account_token" };
  const url =
    `${DRIVE_V3}/files/${encodeURIComponent(folderId)}` +
    `?fields=id,name,mimeType&supportsAllDrives=true`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch (err) {
    return { ok: false, status: 502, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, status: res.status, reason: `drive_${res.status}` };
  const file = (await res.json()) as { id: string; name: string; mimeType: string };
  if (file.mimeType !== FOLDER_MIME) {
    return { ok: false, status: 415, reason: `not_a_folder:${file.mimeType}` };
  }
  return { ok: true, name: file.name };
}

/** ADR-078 §5 guard 2 — folder ids the series registry publishes to. */
async function destinationFolderIds(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await fs.readFile(SERIES_FILE(), "utf-8");
    const parsed = JSON.parse(raw) as {
      entries?: Array<{
        series_name?: string;
        destinations?: Array<{ platform?: string; folder_id?: string }>;
      }>;
    };
    for (const entry of parsed.entries ?? []) {
      for (const dest of entry.destinations ?? []) {
        if (dest.platform === "GoogleDrive" && typeof dest.folder_id === "string" && dest.folder_id.trim()) {
          out.add(dest.folder_id.trim());
        }
      }
    }
  } catch {
    // No registry yet, or unreadable — nothing to collide with.
  }
  return out;
}

async function getHandler() {
  const store = await read();
  return NextResponse.json({
    folders: store.folders,
    service_account: await serviceAccountEmail(),
  });
}

async function putHandler(req: NextRequest) {
  let actor;
  try {
    actor = await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }
  if (actor.role !== "Admin") {
    return NextResponse.json({ error: "Admin role required to change Drive source folders" }, { status: 403 });
  }

  let body: { folders?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.folders)) {
    return NextResponse.json({ error: "folders array required" }, { status: 400 });
  }

  const prior = await read();
  const priorById = new Map(prior.folders.map(f => [f.folder_id, f]));
  const destinations = await destinationFolderIds();
  const seen = new Set<string>();
  const next: DriveSourceFolder[] = [];

  for (const [i, raw] of (body.folders as Array<Partial<DriveSourceFolder>>).entries()) {
    const folderId = (raw?.folder_id ?? "").trim();
    const label = (raw?.label ?? "").trim();
    if (!folderId || !/^[A-Za-z0-9_-]{10,}$/.test(folderId)) {
      return NextResponse.json({ error: `folders[${i}].folder_id must be a Drive folder id (10+ chars)` }, { status: 400 });
    }
    if (!label) {
      return NextResponse.json({ error: `folders[${i}].label must be a non-empty string` }, { status: 400 });
    }
    if (seen.has(folderId)) {
      return NextResponse.json({ error: `folders[${i}] — folder ${folderId} is listed twice` }, { status: 400 });
    }
    seen.add(folderId);

    // §5 — refuse a folder we publish into. Not a confirm: a folder
    // that is both where we publish and where we look for new work is
    // a configuration we have no use case for.
    if (destinations.has(folderId)) {
      return NextResponse.json({
        error:
          `folders[${i}] ("${label}") is already a publish destination for a series. ` +
          `Registering it as a source too would offer this app's own published videos back as new records. ` +
          `Remove the GoogleDrive destination from the series registry first, or use a different folder.`,
      }, { status: 409 });
    }

    // §6 — probe only folders we haven't already accepted. Re-saving
    // the list (a rename, an enabled toggle) shouldn't re-hit Drive
    // once per row, and shouldn't fail the whole save if Drive is
    // briefly unreachable for a folder that already worked.
    if (!priorById.has(folderId)) {
      const probe = await probeFolder(folderId);
      if (!probe.ok) {
        const sa = await serviceAccountEmail();
        const share = sa
          ? `Share it with ${sa} as a Viewer, then retry.`
          : `Share it with this deployment's service account as a Viewer, then retry.`;
        const detail =
          probe.status === 403 || probe.status === 404
            ? `Can't see that folder. ${share}`
            : probe.reason.startsWith("not_a_folder")
              ? `That id points at a file, not a folder.`
              : `Drive probe failed (${probe.reason}).`;
        serverLog("warn", "api:drive/sources", "folder-probe-failed", {
          folder_id: folderId, status: probe.status, reason: probe.reason, actor_email: actor.email,
        });
        return NextResponse.json({ error: `folders[${i}] ("${label}"): ${detail}` }, { status: 400 });
      }
    }

    const existing = priorById.get(folderId);
    next.push({
      id: raw?.id ?? existing?.id ?? crypto.randomUUID(),
      folder_id: folderId,
      label,
      enabled: raw?.enabled !== false,
      ...(raw?.series_name?.trim() ? { series_name: raw.series_name.trim() } : {}),
      added_by: existing?.added_by ?? actor.email,
      added_at: existing?.added_at ?? new Date().toISOString(),
    });
  }

  await write({ folders: next });
  serverLog("info", "api:drive/sources", "drive-sources-updated", {
    count: next.length, actor_email: actor.email,
  });
  return NextResponse.json({ folders: next });
}

export const GET = withRequestLogging("api:drive/sources", getHandler as never);
export const PUT = withRequestLogging("api:drive/sources", putHandler as never);
