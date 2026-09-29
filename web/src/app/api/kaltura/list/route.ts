/**
 * POST /api/kaltura/list
 * Lists media entries from a Kaltura account between two dates.
 * Used by KalturaImport to surface entries the operator can pull into
 * the catalog as records with source_platform: "Kaltura".
 *
 * Body: { partnerId, adminSecret, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
 *
 * Response: { entries: KalturaEntry[], total: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { kalturaCall, mintAdminKs, resolveKalturaCredentials, DISABLE_ENTITLEMENT } from "../../../../lib/kalturaApi";
import { kalturaWatchUrl } from "../../../../lib/urlResolver";

// Dynamic — calls Kaltura API.
export const dynamic = "force-dynamic";

const KALTURA_BASE = "https://www.kaltura.com/api_v3";

interface KalturaEntry {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;        // ISO from createdAt epoch
  duration_seconds: number;
  tags: string[];
  thumbnail_url: string | null;
  player_url: string;
  is_live: boolean;
  /** Kaltura's own reference id. For an entry the Zoom connector
   *  ingested this carries the Zoom meeting UUID and the true
   *  recording start — see lib/kalturaZoomOrigin. Previously received
   *  from media.list and discarded, which is why every Kaltura-origin
   *  record in the catalog has no upstream link. */
  reference_id: string | null;
  /** Connector markers. The Zoom integration tags what it creates. */
  admin_tags: string | null;
  /** Category membership, as ids. Tells us what the connector already
   *  filed the entry under before any backfill touches it. */
  category_ids: string[];
}

async function handler(req: NextRequest) {
  let body: { partnerId?: string; adminSecret?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shared = (await getSharedCredential("kaltura")) ?? {};
  const sharedAny = shared as { partnerId?: string; adminSecret?: string; apiKey?: string };
  const partnerId = body.partnerId || sharedAny.partnerId || process.env.KALTURA_PARTNER_ID;
  // Accept both `adminSecret` (current convention) and `apiKey` (legacy
  // shape from earlier Phase-2 saves) when reading the shared payload.
  const adminSecret = body.adminSecret || sharedAny.adminSecret || sharedAny.apiKey || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    return NextResponse.json({ error: "partnerId and adminSecret are required" }, { status: 400 });
  }
  const rid = req.headers.get("x-request-id") ?? "n/a";

  // 1. Mint admin KS.
  //
  // disableentitlement: without it an ADMIN session sees only the
  // privacy contexts it is entitled to, so media.list silently omits
  // every entry living in an entitled category and this import UI
  // shows a partial view of the account. Same omission that hid 135
  // of the partner's 163 categories.
  let ks: string;
  try {
    ks = await mintAdminKs({ partnerId, adminSecret }, { privileges: DISABLE_ENTITLEMENT });
  } catch (err) {
    serverLog("error", "ext:kaltura-session", "auth failed", { error: String(err), rid });
    return NextResponse.json({ error: `Kaltura auth: ${String(err)}` }, { status: 502 });
  }

  // 2. media.list with optional date filter
  // filter:createdAtGreaterThanOrEqual / createdAtLessThanOrEqual are unix seconds.
  const filter: Record<string, string | number> = {
    statusEqual: 2, // READY
    objectType: "KalturaMediaEntryFilter",
  };
  if (body.from) filter.createdAtGreaterThanOrEqual = Math.floor(new Date(body.from).getTime() / 1000);
  if (body.to) filter.createdAtLessThanOrEqual = Math.floor(new Date(body.to + "T23:59:59Z").getTime() / 1000);

  let raw: unknown;
  try {
    raw = await kalturaCall("media", "list", {
      ks,
      filter,
      pager: { pageSize: 200, pageIndex: 1, objectType: "KalturaFilterPager" },
    });
  } catch (err) {
    serverLog("error", "ext:kaltura-list", "media.list failed", { error: String(err), rid });
    return NextResponse.json({ error: `Kaltura list: ${String(err)}` }, { status: 502 });
  }

  // Kaltura responses come as either { objects: [...], totalCount } at the
  // top level or wrapped in { result: { objects, totalCount } } depending on
  // KS context. Tolerant unwrap.
  function unwrap(v: unknown): { objects?: unknown[]; totalCount?: number } {
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.objects)) return o as { objects: unknown[]; totalCount?: number };
    if (o.result && typeof o.result === "object") return unwrap(o.result);
    return {};
  }
  const { objects = [], totalCount = 0 } = unwrap(raw);

  const entries: KalturaEntry[] = objects.map((o): KalturaEntry => {
    const e = o as Record<string, unknown>;
    const id = String(e.id ?? "");
    const createdAtSecs = Number(e.createdAt ?? 0);
    // Kaltura may report fractional seconds; the WASM IndexVideo command
    // needs an integer (u32). Round here so every consumer gets a clean int.
    const duration = Math.max(0, Math.round(Number(e.duration ?? 0)));
    const tagsRaw = String(e.tags ?? "");
    const playerUrl = kalturaWatchUrl(id);
    return {
      id,
      name: String(e.name ?? "Untitled"),
      description: e.description != null ? String(e.description) : null,
      createdAt: createdAtSecs > 0 ? new Date(createdAtSecs * 1000).toISOString() : new Date().toISOString(),
      duration_seconds: duration,
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()).filter(Boolean) : [],
      thumbnail_url: e.thumbnailUrl != null ? String(e.thumbnailUrl) : null,
      player_url: playerUrl,
      is_live: Number(e.mediaType) === 7 || Number(e.mediaType) === 201,
      reference_id: e.referenceId != null ? String(e.referenceId) : null,
      admin_tags: e.adminTags != null ? String(e.adminTags) : null,
      category_ids: String(e.categoriesIds ?? "").split(",").map(x => x.trim()).filter(Boolean),
    };
  });

  serverLog("info", "ext:kaltura-list", "done", { count: entries.length, totalCount, rid });
  return NextResponse.json({ entries, total: totalCount || entries.length });
}

export const POST = withRequestLogging("api:kaltura/list", handler);
