/**
 * POST /api/kaltura/categories
 *
 * Bring a published Kaltura entry into line with the categories its
 * series declares (ADR-075 `DestinationSpec.category_ids`).
 *
 * Body:     { entryId: string, declared: string[], partnerId?, adminSecret? }
 * Returns:  { entryId, added[], alreadyPresent[], unresolved[], failed[] }
 *
 * Additive by construction: it issues `categoryEntry.add` for the
 * missing memberships and touches nothing else. It deliberately does
 * NOT use `media.update { categoriesIds }`, which replaces the entry's
 * whole membership set and would strip categories a KMC admin added by
 * hand.
 *
 * See lib/kalturaCategories.ts for why declared values are resolved by
 * name as well as by id, and why `@zoomCategory@` is reported rather
 * than attempted.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import {
  kalturaCall,
  unwrapObjects,
  unwrapList,
  mintAdminKs,
  resolveKalturaCredentials,
  DISABLE_ENTITLEMENT,
  getCachedCategories,
  setCachedCategories,
  invalidateCategoryCache,
} from "../../../../lib/kalturaApi";
import {
  planReconcile,
  type KalturaCategory,
  type ReconcileOutcome,
  type ReconcileResponse,
} from "../../../../lib/kalturaCategories";

// Dynamic — calls the Kaltura API and reads Secret Manager.
export const dynamic = "force-dynamic";

const CATEGORY_PAGE_SIZE = 500;
/** Paging stops here. A partner with more categories than this needs a
 *  targeted lookup, not a full listing; the response says so rather
 *  than silently resolving against a truncated catalog. */
const MAX_CATEGORY_PAGES = 8;
/**
 * How many existing category names to echo back when a declared name
 * fails to resolve.
 *
 * Was 25, which truncated a 28-category partner and hid exactly the
 * three names we then had to redeploy to see. The cap exists to bound
 * a pathological partner, not to summarise a normal one, so it sits
 * well above any realistic category count.
 */
const SAMPLE_SIZE = 200;

/**
 * Every category on the partner account.
 *
 * One listing beats a `fullNameEqual` lookup per declared value: it is
 * fewer calls for the 5-category series, and it is the only way to
 * detect an ambiguous name (two categories sharing a leaf name) rather
 * than taking whichever one Kaltura returns first.
 */
async function listAllCategories(
  ks: string,
): Promise<{ categories: KalturaCategory[]; truncated: boolean; totalCount: number | null }> {
  const categories: KalturaCategory[] = [];
  let totalCount: number | null = null;

  for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
    const res = await kalturaCall("category", "list", {
      ks,
      // An explicit filter objectType, matching every other Kaltura
      // call in this repo (media.list passes KalturaMediaEntryFilter).
      filter: { objectType: "KalturaCategoryFilter" },
      pager: { pageSize: CATEGORY_PAGE_SIZE, pageIndex: page, objectType: "KalturaFilterPager" },
    });
    const { objects, totalCount: reported } = unwrapList<{
      id?: number | string;
      name?: string;
      fullName?: string;
    }>(res);
    if (reported !== null) totalCount = reported;

    for (const o of objects) {
      const id = Number(o.id);
      if (!Number.isFinite(id)) continue;
      const name = String(o.name ?? "");
      categories.push({ id, name, fullName: String(o.fullName ?? name) });
    }

    // Stop on the server's own count, not on a short page. A page
    // shorter than requested means "the server returned less than it
    // was asked for", which is NOT the same as "that was everything" —
    // conflating the two is how a partial listing passed for complete
    // and turned four real categories into four confident not_founds.
    if (objects.length === 0) break;
    if (totalCount !== null && categories.length >= totalCount) break;
    if (totalCount === null && objects.length < CATEGORY_PAGE_SIZE) break;
  }

  const truncated = totalCount !== null && categories.length < totalCount;
  return { categories, truncated, totalCount };
}

/** Category ids the entry already belongs to. */
async function currentMembership(ks: string, entryId: string): Promise<number[]> {
  const res = await kalturaCall("categoryEntry", "list", {
    ks,
    filter: { objectType: "KalturaCategoryEntryFilter", entryIdEqual: entryId },
    pager: { pageSize: CATEGORY_PAGE_SIZE, pageIndex: 1, objectType: "KalturaFilterPager" },
  });
  return unwrapObjects<{ categoryId?: number | string }>(res)
    .map(o => Number(o.categoryId))
    .filter(n => Number.isFinite(n));
}

async function handler(req: NextRequest): Promise<NextResponse> {
  let body: { entryId?: string; declared?: string[]; partnerId?: string; adminSecret?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
  const declared = Array.isArray(body.declared) ? body.declared.filter(v => typeof v === "string") : [];
  if (!entryId) {
    return NextResponse.json({ error: "entryId is required" }, { status: 400 });
  }
  // Kaltura entry ids are `<partner>_<alnum>`. Validating at the
  // boundary keeps an arbitrary string out of the API call.
  if (!/^[0-9]+_[A-Za-z0-9]+$/.test(entryId)) {
    return NextResponse.json({ error: `Not a Kaltura entry id: ${entryId}` }, { status: 400 });
  }
  if (declared.length === 0) {
    return NextResponse.json({ error: "declared must be a non-empty array of category ids or names" }, { status: 400 });
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const creds = await resolveKalturaCredentials(body);
  if (!creds) {
    return NextResponse.json(
      { error: "Kaltura is not configured — partnerId and adminSecret are required" },
      { status: 400 },
    );
  }

  serverLog("info", "ext:kaltura-categories", "starting", { rid, entryId, declaredCount: declared.length });

  try {
    // disableentitlement: without it an ADMIN KS sees only the privacy
    // contexts it is entitled to, and the rest of the category tree is
    // silently absent rather than refused. See DISABLE_ENTITLEMENT.
    const ks = await mintAdminKs(creds, { privileges: DISABLE_ENTITLEMENT });

    // ADR-080 §4 — one listing per partner per window, not one per
    // record. The membership read is always live; it is per-entry and
    // is what the plan is computed against.
    type Listing = { categories: KalturaCategory[]; truncated: boolean; totalCount: number | null };
    const cached = getCachedCategories<Listing>(creds.partnerId);
    const [listing, currentIds] = await Promise.all([
      cached ? Promise.resolve(cached) : listAllCategories(ks).then(l => { setCachedCategories(creds.partnerId, l); return l; }),
      currentMembership(ks, entryId),
    ]);
    let { categories, truncated, totalCount } = listing;
    let fromCache = Boolean(cached);
    if (truncated) {
      // Resolving names against a partial catalog would report real
      // categories as "not_found" and invite someone to create a
      // duplicate. Refuse instead.
      return NextResponse.json(
        { error: `Read ${categories.length} of ${totalCount} categories; name resolution needs the full listing` },
        { status: 501 },
      );
    }

    let plan = planReconcile(declared, categories, currentIds);

    // A miss against a CACHED listing proves nothing — the category
    // may have been created since it was read. Re-read once before
    // anyone is told a name does not exist. This is the guard that
    // stops the memo reintroducing the bug it is an optimisation for.
    if (fromCache && plan.unresolved.some(u => u.reason === "not_found" || u.reason === "listing_empty")) {
      invalidateCategoryCache(creds.partnerId);
      const fresh = await listAllCategories(ks);
      setCachedCategories(creds.partnerId, fresh);
      ({ categories, truncated, totalCount } = fresh);
      fromCache = false;
      plan = planReconcile(declared, categories, currentIds);
      serverLog("info", "ext:kaltura-categories", "cache-miss-reread", {
        rid, entryId, categories: categories.length,
      });
    }

    const added: ReconcileOutcome[] = [];
    const failed: ReconcileOutcome[] = [];
    // Sequential: Kaltura rate-limits an admin KS, and a partial
    // failure must leave a readable trail of what did land rather
    // than an unordered pile of rejections.
    for (const target of plan.toAdd) {
      try {
        await kalturaCall("categoryEntry", "add", {
          ks,
          categoryEntry: {
            objectType: "KalturaCategoryEntry",
            entryId,
            categoryId: target.id as number,
          },
        });
        added.push(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ ...target, error: message.slice(0, 200) });
      }
    }

    // Only sent when something failed to resolve. On a clean run it is
    // noise; on a failure it is the answer to "then what IS it called?"
    const anythingUnresolved = plan.unresolved.some(u => u.reason !== "template");
    const response: ReconcileResponse = {
      entryId,
      added,
      alreadyPresent: plan.alreadyPresent,
      unresolved: plan.unresolved,
      failed,
      categoriesListed: categories.length,
      categoriesReportedByKaltura: totalCount,
      currentCategoryIds: currentIds,
      ...(anythingUnresolved
        ? { availableSample: categories.slice(0, SAMPLE_SIZE).map(c => c.fullName) }
        : {}),
    };
    serverLog("info", "ext:kaltura-categories", "done", {
      rid,
      entryId,
      added: added.length,
      alreadyPresent: plan.alreadyPresent.length,
      unresolved: plan.unresolved.map(u => `${u.raw}:${u.reason}`),
      failed: failed.length,
      // The three numbers that make an unresolved name diagnosable:
      // an empty listing is a permissions fault, a populated one is a
      // registry fault, and the membership says whether categories are
      // reaching this entry by some other route (the Zoom connector).
      categoriesListed: categories.length,
      categoriesReportedByKaltura: totalCount,
      listingFromCache: fromCache,
      currentCategoryIds: currentIds,
      sample: categories.slice(0, SAMPLE_SIZE).map(c => c.fullName),
    });
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLog("error", "ext:kaltura-categories", "failed", { rid, entryId, error: message.slice(0, 500) });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const POST = withRequestLogging("api:kaltura/categories", handler);
