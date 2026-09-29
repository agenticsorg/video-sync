/**
 * ADR-077 §3 — Kaltura destination adapter.
 *
 * Wraps /api/kaltura/upload (ADR-037 Phase 1): a single-shot blocking
 * upload with no progress stream, so the phase reporter fires once at the
 * start and the operator sees an indeterminate spinner.
 *
 * Applies the series' declared categories in a second step after
 * the upload — see applyCategories.
 *
 * Does NOT apply the declared visibility. Kaltura's model is an
 * access-control profile id, the upload body has no field for one, and
 * the id values are partner-specific so there is no universal mapping
 * from `public` / `members` / `unlisted`. ADR-077 §5 closes this, and it
 * needs the org's KMC administrator to supply the mapping first — the one
 * dependency in that ADR outside engineering. Until then
 * appliesDeclaredVisibility("Kaltura") is false and the UI says so.
 */

import type { DestinationAdapter, PushRequest, PushResult } from "../types";
import {
  reconcileKalturaCategories,
  summarizeReconcile,
  isCompliant,
} from "../../kalturaCategories";

export const kalturaAdapter: DestinationAdapter = {
  platform: "Kaltura",

  async push(req: PushRequest): Promise<PushResult> {
    if (req.spec.platform !== "Kaltura") {
      throw new Error(`kalturaAdapter received a ${req.spec.platform} destination`);
    }

    req.onPhase?.("Uploading to Kaltura…");

    const body: Record<string, unknown> = {
      title: req.attrs.title,
      description: req.attrs.description,
      tags: req.attrs.tags,
      downloadUrl: req.sourceUrl,
      // ADR-044 — stamp the catalog uuid as the entry's referenceId so a
      // later presence sweep can find it without depending on the
      // description footer surviving an operator edit.
      referenceId: req.record.id,
      // Categories are NOT set here. See the category step below.
      ...req.creds.source,
    };
    if (req.creds.kaltura?.partnerId && req.creds.kaltura?.adminSecret) {
      body.partnerId = req.creds.kaltura.partnerId;
      body.adminSecret = req.creds.kaltura.adminSecret;
    }

    const res = await fetch("/api/kaltura/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as {
      entryId?: string;
      playerUrl?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `Kaltura upload failed (${res.status})`);
    }
    if (!data.entryId) {
      throw new Error("Kaltura upload returned no entryId");
    }

    const categories = await applyCategories(req, data.entryId);

    return {
      external_id: data.entryId,
      external_url: data.playerUrl ?? "",
      ...categories,
    };
  },
};

/**
 * Apply the series' declared categories to the entry just created.
 *
 * A separate step, after the upload, rather than `categoriesIds` on
 * media.add. Three reasons, in order of how much they cost to learn:
 *
 * 1. The declared values are NAMES, not ids. media.add's
 *    `categoriesIds` takes ids only. The previous code papered over
 *    this with `category_ids.map(Number).filter(n => !isNaN(n))`,
 *    which silently emptied the array for every value the registry
 *    actually holds — so no Kaltura publish has ever carried a
 *    category. Resolving names needs a category.list round trip
 *    that the upload route has no business doing.
 *
 * 2. Those categories sit in an entitlement-enforced privacy context,
 *    so they are invisible to a session without `disableentitlement`.
 *    /api/kaltura/categories already mints its KS correctly; the
 *    upload route does not.
 *
 * 3. It is additive and idempotent, so the same call repairs an old
 *    entry and finishes a new one. One code path, already proven
 *    against the live 163-category listing.
 *
 * Never throws. The media is on Kaltura by this point; a category
 * failure makes the publish incomplete, not failed, and the caller
 * reports that through categories_applied exactly as it does for
 * visibility.
 */
async function applyCategories(
  req: PushRequest,
  entryId: string,
): Promise<Pick<PushResult, "categories_applied" | "categories_error">> {
  if (req.spec.platform !== "Kaltura") return {};
  const declared = req.spec.category_ids ?? [];
  if (declared.length === 0) return {};

  req.onPhase?.("Applying Kaltura categories…");
  try {
    const res = await reconcileKalturaCategories({ entryId, declared });
    return isCompliant(res)
      ? { categories_applied: true }
      : { categories_applied: false, categories_error: summarizeReconcile(res) };
  } catch (err) {
    return {
      categories_applied: false,
      categories_error: err instanceof Error ? err.message : String(err),
    };
  }
}
