/**
 * Shared Kaltura API plumbing.
 *
 * Server-only: do not import from client components — it reaches
 * Secret Manager via getSharedCredential.
 *
 * Every Kaltura route grew its own copy of `kalturaCall` and its own
 * KS-minting block: /api/kaltura/upload, /list and /presence-batch each
 * carry a near-identical pair, and they had already drifted (only
 * upload's raises on a KalturaAPIException; the others return the
 * exception object as if it were a result). ADR-079 §1 made the same
 * observation about the destination-outcome helpers, and the reasoning
 * is identical: two implementations of one protocol detail drift, and
 * the drift surfaces as a silent wrong answer rather than an error.
 *
 * This module is the single implementation. The existing three routes
 * are left alone for now — they work, and rewriting a multi-GB upload
 * path to prove a refactor is a bad trade — but nothing new should add
 * a fourth copy.
 */

import { getSharedCredential } from "./sharedCredentials";

export const KALTURA_BASE = "https://www.kaltura.com/api_v3";

/**
 * One Kaltura API call.
 *
 * Kaltura's wire format is form-encoded with `parent:child` keys for
 * nested objects (`filter:entryIdEqual`, `categoryEntry:categoryId`),
 * so nested objects are flattened one level. `format=1` selects JSON.
 *
 * Returns `unknown` deliberately: `session.start` answers with a bare
 * JSON string while everything else answers with an object, and a
 * signature that claims otherwise is how the existing copies ended up
 * with three different unwrapping dances.
 */
export async function kalturaCall(
  service: string,
  action: string,
  params: Record<string, string | number | object>,
): Promise<unknown> {
  const body = new URLSearchParams();
  body.set("format", "1"); // 1 = JSON
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "object" && v !== null) {
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        body.set(`${k}:${kk}`, String(vv));
      }
    } else {
      body.set(k, String(v));
    }
  }
  const res = await fetch(`${KALTURA_BASE}/?service=${service}&action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Kaltura ${service}.${action} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data: unknown = await res.json();
  // Kaltura answers 200 OK with an exception body. Not raising here is
  // what lets a failure read as an empty result upstream.
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (o.objectType === "KalturaAPIException" || ("code" in o && "message" in o)) {
      throw new Error(`Kaltura ${service}.${action}: ${String(o.code ?? "error")} — ${String(o.message ?? "")}`);
    }
  }
  return data;
}

/**
 * Pull the `objects` array out of a list response.
 *
 * Kaltura returns either `{objects, totalCount}` at the top level or
 * wrapped in `{result: {...}}` depending on KS context, so this
 * unwraps recursively rather than assuming one shape.
 */
export function unwrapObjects<T = Record<string, unknown>>(v: unknown): T[] {
  if (!v || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.objects)) return o.objects as T[];
  if (o.result && typeof o.result === "object") return unwrapObjects<T>(o.result);
  return [];
}

export interface KalturaCredentials {
  partnerId: string;
  adminSecret: string;
}

/**
 * Resolve partner id + admin secret.
 *
 * Precedence is request body → shared secret → environment, matching
 * the three existing routes. `apiKey` is accepted as an alias for
 * `adminSecret` because shared payloads written before the field
 * rename used it, and those secrets are still live.
 */
export async function resolveKalturaCredentials(
  override?: { partnerId?: string; adminSecret?: string },
): Promise<KalturaCredentials | null> {
  const shared = ((await getSharedCredential("kaltura")) ?? {}) as {
    partnerId?: string;
    adminSecret?: string;
    apiKey?: string;
  };
  const partnerId = override?.partnerId || shared.partnerId || process.env.KALTURA_PARTNER_ID;
  const adminSecret =
    override?.adminSecret || shared.adminSecret || shared.apiKey || process.env.KALTURA_ADMIN_SECRET;
  if (!partnerId || !adminSecret) return null;
  return { partnerId, adminSecret };
}

/** Mint an admin (type 2) Kaltura Session. */
export async function mintAdminKs(
  creds: KalturaCredentials,
  { expiry = 3600 }: { expiry?: number } = {},
): Promise<string> {
  const res = await kalturaCall("session", "start", {
    partnerId: creds.partnerId,
    secret: creds.adminSecret,
    type: 2, // ADMIN
    userId: "video-sync",
    expiry,
  });
  const ks =
    typeof res === "string"
      ? res
      : res && typeof res === "object" && "result" in res
        ? String((res as { result?: unknown }).result ?? "")
        : "";
  // A KS is a long base64 blob. Anything short is an error body that
  // slipped through, and passing it on produces a misleading
  // "invalid session" from whichever call uses it next.
  if (!ks || ks.length < 10) {
    throw new Error(`Kaltura session.start returned no usable KS: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return ks;
}
