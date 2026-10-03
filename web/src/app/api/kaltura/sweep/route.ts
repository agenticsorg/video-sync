/**
 * POST /api/kaltura/sweep — ADR-081 Phases 2 & 3.
 *
 * Brings Kaltura-hosted recordings into their series' portal
 * categories. Kaltura ingests from Zoom automatically on
 * notification, so the account is current within the hour while the
 * catalog holds a fraction of it — a catalog-driven reconcile
 * (ADR-080) reaches about a ninth of the problem. This sweeps
 * Kaltura directly and needs no catalog record.
 *
 * Body:
 *   { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", apply?: boolean }
 *
 * `apply` defaults to FALSE. ADR-081 §4 — the first output is a plan
 * an operator reads; nothing is written until they ask. That gate is
 * deliberately stronger than ADR-080's one-click card, because a
 * mistake here makes a private meeting visible on the portal rather
 * than mis-filing our own content.
 *
 * Matching is in lib/kalturaSweepMatcher (pure, shared with the
 * Maintain card). This route only fetches, calls it, and — when
 * asked — writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import {
  kalturaCall, unwrapList, mintAdminKs, resolveKalturaCredentials, DISABLE_ENTITLEMENT,
} from "../../../../lib/kalturaApi";
import { readSeriesRegistryServer } from "../../../../lib/destinationResolverServer";
import { planSweep, type SweepEntry, type SweepPlan } from "../../../../lib/kalturaSweepMatcher";
import type { KalturaCategory } from "../../../../lib/kalturaCategories";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const MAX_PAGES = 8;

/**
 * Every category on the partner, so declared NAMES can be resolved to
 * the numeric ids Kaltura's media.list reports.
 *
 * The registry holds full paths like
 * "mediaspace_8DEe6>site>galleries>Weekly Recordings"; entries carry
 * "370373752". Without this listing the two are compared as strings
 * and nothing ever matches.
 */
async function listCategories(ks: string): Promise<KalturaCategory[]> {
  const out: KalturaCategory[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await kalturaCall("category", "list", {
      ks,
      filter: { objectType: "KalturaCategoryFilter" },
      pager: { pageSize: PAGE_SIZE, pageIndex: page, objectType: "KalturaFilterPager" },
    });
    const { objects, totalCount } = unwrapList<{ id?: number | string; name?: string; fullName?: string }>(res);
    for (const o of objects) {
      const id = Number(o.id);
      if (!Number.isFinite(id)) continue;
      const name = String(o.name ?? "");
      out.push({ id, name, fullName: String(o.fullName ?? name) });
    }
    if (objects.length === 0) break;
    if (totalCount !== null && out.length >= totalCount) break;
    if (totalCount === null && objects.length < PAGE_SIZE) break;
  }
  return out;
}

/** Entries created in the window, with the fields matching needs. */
async function listEntries(ks: string, from?: string, to?: string): Promise<{ entries: SweepEntry[]; truncated: boolean }> {
  const filter: Record<string, string | number> = { objectType: "KalturaMediaEntryFilter" };
  if (from) filter.createdAtGreaterThanOrEqual = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  if (to) filter.createdAtLessThanOrEqual = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);

  const entries: SweepEntry[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await kalturaCall("media", "list", {
      ks, filter,
      pager: { pageSize: PAGE_SIZE, pageIndex: page, objectType: "KalturaFilterPager" },
    });
    const { objects, totalCount } = unwrapList<Record<string, unknown>>(res);
    if (totalCount !== null) total = totalCount;
    for (const o of objects) {
      const created = Number(o.createdAt);
      entries.push({
        id: String(o.id ?? ""),
        name: String(o.name ?? ""),
        reference_id: o.referenceId != null ? String(o.referenceId) : null,
        category_ids: String(o.categoriesIds ?? "").split(",").map(s => s.trim()).filter(Boolean),
        createdAt: Number.isFinite(created) ? new Date(created * 1000).toISOString() : "",
      });
    }
    if (objects.length === 0) break;
    if (total !== null && entries.length >= total) break;
    if (total === null && objects.length < PAGE_SIZE) break;
  }
  // Reading short and matching against a partial list would silently
  // under-claim; say so rather than report a plan that looks complete.
  return { entries, truncated: total !== null && entries.length < total };
}

interface ApplyOutcome {
  entry_id: string;
  series_name: string;
  added: string[];
  failed: { category: string; error: string }[];
}

async function handler(req: NextRequest): Promise<NextResponse> {
  let body: { from?: string; to?: string; apply?: boolean };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const apply = body.apply === true;
  const rid = req.headers.get("x-request-id") ?? "n/a";

  const creds = await resolveKalturaCredentials();
  if (!creds) {
    return NextResponse.json({ error: "Kaltura is not configured" }, { status: 400 });
  }

  try {
    const { entries: registry } = await readSeriesRegistryServer();
    // disableentitlement: without it media.list omits entries in an
    // entitled category and the sweep silently under-claims.
    const ks = await mintAdminKs(creds, { privileges: DISABLE_ENTITLEMENT });
    const { entries, truncated } = await listEntries(ks, body.from, body.to);
    if (truncated) {
      return NextResponse.json(
        { error: `Read ${entries.length} entries but Kaltura reports more; narrow the date range` },
        { status: 501 },
      );
    }

    const categories = await listCategories(ks);
    const plan: SweepPlan = planSweep(entries, registry, categories);
    serverLog("info", "ext:kaltura-sweep", apply ? "applying" : "planned", {
      rid, scanned: entries.length, matched: plan.matches.length,
      operations: plan.operations, categories: categories.length, apply,
    });

    if (!apply) {
      return NextResponse.json({
        applied: false, scanned: entries.length,
        matches: plan.matches, operations: plan.operations,
        alreadyComplete: plan.alreadyComplete, skipped: plan.skips.length,
      });
    }

    // §3 — apply. Sequential: Kaltura rate-limits an admin session,
    // and a partial failure must leave a readable trail of what
    // landed rather than an unordered pile of rejections.
    const outcomes: ApplyOutcome[] = [];
    for (const m of plan.matches) {
      const out: ApplyOutcome = { entry_id: m.entry.id, series_name: m.series_name, added: [], failed: [] };
      for (const cat of m.missing) {
        if (!/^\d+$/.test(cat)) {
          // The sweep applies ids only. A name would need resolving
          // against the category list, which /api/kaltura/categories
          // already does per-entry — this route must not grow a
          // second, divergent resolver.
          out.failed.push({ category: cat, error: "not a numeric category id — use /api/kaltura/categories" });
          continue;
        }
        try {
          await kalturaCall("categoryEntry", "add", {
            ks,
            categoryEntry: { objectType: "KalturaCategoryEntry", entryId: m.entry.id, categoryId: Number(cat) },
          });
          out.added.push(cat);
        } catch (err) {
          out.failed.push({ category: cat, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        }
      }
      outcomes.push(out);
    }

    const added = outcomes.reduce((n, o) => n + o.added.length, 0);
    const failed = outcomes.reduce((n, o) => n + o.failed.length, 0);
    serverLog("info", "ext:kaltura-sweep", "applied", { rid, added, failed, entries: outcomes.length });
    return NextResponse.json({ applied: true, scanned: entries.length, added, failed, outcomes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLog("error", "ext:kaltura-sweep", "failed", { rid, error: message.slice(0, 500) });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const POST = withRequestLogging("api:kaltura/sweep", handler);
