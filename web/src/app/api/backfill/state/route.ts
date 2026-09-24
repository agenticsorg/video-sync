/**
 * GET  /api/backfill/state — the upload-quota snapshot
 * POST /api/backfill/state — operator correction of the counter
 *
 * The accounting itself lives in lib/uploadQuota, which /api/youtube/upload
 * calls after every successful upload. This route no longer accepts
 * `{ increment: true }`: until 2026-09-24 BackfillPanel incremented from
 * the client after its own uploads, which meant backfill runs were
 * counted and nothing else was. Counting at the upload route covers
 * every path, and keeping a second incrementer alive would double-count
 * the backfill ones.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { readQuota, setQuota } from "../../../../lib/uploadQuota";

export const dynamic = "force-dynamic";

async function getHandler() {
  return NextResponse.json(await readQuota());
}

async function postHandler(req: NextRequest) {
  let body: { uploads_today?: number; last_reset_date?: string; increment?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.increment) {
    return NextResponse.json({
      error: "increment is no longer accepted — /api/youtube/upload counts every upload itself. "
           + "Set uploads_today explicitly if you need to correct the counter.",
    }, { status: 400 });
  }
  return NextResponse.json(await setQuota(body));
}

export const GET = withRequestLogging("api:backfill/state", getHandler);
export const POST = withRequestLogging("api:backfill/state", postHandler);
