"use client";

/**
 * ADR-077 follow-up — know the YouTube grant has expired BEFORE a
 * publish, not during one.
 *
 * Incident 2026-09-23: an expired refresh token surfaced deep inside
 * the upload, after Kaltura had already been pushed. The operator's
 * report was "I hit publish and the card disappeared as Published, but
 * it actually failed on YouTube". A grant's validity is knowable up
 * front and cheaply, so there is no reason to find out the expensive
 * way — half-published and needing a repair.
 *
 * Two consumers, deliberately different:
 *
 *   getGrantCached()  — passive. Drives the advisory the operator sees
 *                       on the card before clicking. May be stale.
 *   assertGrantForPublish() — authoritative. Re-checks immediately
 *                       before a publish that targets YouTube, and its
 *                       answer decides whether the publish runs.
 */

export interface GrantStatus {
  valid: boolean;
  expires_in?: number;
  reason?: "no_credentials" | "invalid_grant" | "oauth_error" | "network";
  detail?: string;
  needs_reauth?: boolean;
}

/** Re-check rather than trust the cache once it is this old. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { status: GrantStatus; at: number } | null = null;
let inflight: Promise<GrantStatus> | null = null;

/** YouTube credentials live in the Connections blob, same as the
 *  publish path reads them. Sent as headers so the server uses exactly
 *  the credential the upload would have used. */
function credentialHeaders(): Record<string, string> {
  try {
    const raw = localStorage.getItem("video-sync:connections");
    if (!raw) return {};
    const conns = JSON.parse(raw) as Record<string, { credentials?: Record<string, string> }>;
    const yt = conns["YouTube"]?.credentials;
    if (!yt?.refreshToken || !yt?.clientId || !yt?.clientSecret) return {};
    return {
      "x-youtube-refresh-token": yt.refreshToken,
      "x-youtube-client-id": yt.clientId,
      "x-youtube-client-secret": yt.clientSecret,
    };
  } catch {
    return {};
  }
}

async function fetchStatus(): Promise<GrantStatus> {
  try {
    const res = await fetch("/api/youtube/grant-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...credentialHeaders() },
      cache: "no-store",
    });
    if (!res.ok) {
      // A failing check is not a failing grant. Say so rather than
      // blocking a publish on our own outage.
      return { valid: false, reason: "network", detail: `grant check failed (${res.status})`, needs_reauth: false };
    }
    return (await res.json()) as GrantStatus;
  } catch (err) {
    return {
      valid: false,
      reason: "network",
      detail: err instanceof Error ? err.message : String(err),
      needs_reauth: false,
    };
  }
}

/** Fetch, honouring the TTL. Concurrent callers share one request. */
export async function getGrant(force = false): Promise<GrantStatus> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;
  if (!inflight) {
    inflight = fetchStatus().then(s => {
      cache = { status: s, at: Date.now() };
      inflight = null;
      return s;
    });
  }
  return inflight;
}

/** Last known status, or null if never checked. Render paths only. */
export function getGrantCached(): GrantStatus | null {
  return cache?.status ?? null;
}

export function refreshGrant(): void {
  cache = null;
  inflight = null;
}

/**
 * The pre-flight. Returns null when the publish may proceed, or an
 * operator-facing message when it must not.
 *
 * A `network` reason returns null on purpose: we could not reach
 * Google, which is not evidence the grant is bad. Blocking a publish
 * because our own check was unreachable would trade one failure mode
 * for a worse one — the publish itself will surface a real auth error
 * if there is one, and now records it (fix 2979fdb).
 */
export async function assertGrantForPublish(): Promise<string | null> {
  const status = await getGrant(true);
  if (status.valid) return null;
  if (status.reason === "network") return null;
  if (status.reason === "no_credentials") {
    return "YouTube isn't connected. Add its credentials in Config → Connections before publishing there.";
  }
  if (status.reason === "invalid_grant") {
    return "YouTube authorisation has expired — re-authorise in Config → Connections, then publish again. "
         + "Nothing has been published yet.";
  }
  return `YouTube authorisation problem: ${status.detail ?? "unknown"}. Nothing has been published yet.`;
}

/** Short advisory for the card, or null when there is nothing to say. */
export function grantWarning(status: GrantStatus | null): string | null {
  if (!status || status.valid) return null;
  if (status.reason === "network") return null;   // unknown, not expired
  if (status.reason === "no_credentials") return "YouTube not connected";
  if (status.reason === "invalid_grant") return "YouTube authorisation expired";
  return "YouTube authorisation problem";
}
