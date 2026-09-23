/**
 * POST /api/youtube/grant-status
 *
 * "Is the YouTube OAuth grant still live?" — asked before a publish
 * rather than discovered during one.
 *
 * Incident 2026-09-23: an expired refresh token was only detected deep
 * inside the upload, after Kaltura had already been pushed. The record
 * ended up half-published and (before the companion fix) silently
 * claiming otherwise. A grant that has expired is knowable up front,
 * cheaply, so there is no reason to learn it the expensive way.
 *
 * Credentials come from the same place the publish path gets them:
 * `x-youtube-*` headers written by the client from its Connections
 * entry, falling back to the server's env (ADR-042 shared credential).
 *
 * The check is the refresh-token exchange itself — the only thing that
 * actually proves the grant is good. It hits Google's OAuth endpoint,
 * not the YouTube Data API, so it costs no API quota.
 *
 * Never logs or echoes the token. The response says whether it works
 * and, when it doesn't, Google's own reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";
import { getActor } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

export interface GrantStatus {
  /** True only when Google minted an access token for us just now. */
  valid: boolean;
  /** Seconds until the minted access token expires. Presence is a
   *  secondary signal that the exchange really succeeded. */
  expires_in?: number;
  /** Set when the grant is not usable. */
  reason?: "no_credentials" | "invalid_grant" | "oauth_error" | "network";
  /** Google's `error_description`, or ours. Safe to show an operator. */
  detail?: string;
  /** True when re-authorising is the fix — drives the UI's re-auth CTA. */
  needs_reauth?: boolean;
}

async function handler(req: NextRequest) {
  try {
    await getActor(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 });
  }

  const refreshToken = req.headers.get("x-youtube-refresh-token") || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = req.headers.get("x-youtube-client-id") || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = req.headers.get("x-youtube-client-secret") || process.env.YOUTUBE_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    const body: GrantStatus = {
      valid: false,
      reason: "no_credentials",
      detail: "No YouTube credentials configured. Connect YouTube in Config → Connections.",
      needs_reauth: true,
    };
    // 200, not 4xx: "not configured" is a legitimate answer to the
    // question, and the caller branches on `valid`.
    return NextResponse.json(body);
  }

  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    // Couldn't reach Google. That is NOT evidence the grant is bad, so
    // it must not read as "expired" — the caller treats `network` as
    // "unknown" and lets the publish proceed rather than blocking on a
    // transient outage.
    return NextResponse.json({
      valid: false,
      reason: "network",
      detail: err instanceof Error ? err.message : String(err),
      needs_reauth: false,
    } satisfies GrantStatus);
  }

  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { expires_in?: number };
    return NextResponse.json({
      valid: true,
      ...(typeof data.expires_in === "number" ? { expires_in: data.expires_in } : {}),
    } satisfies GrantStatus);
  }

  const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  const isInvalidGrant = err.error === "invalid_grant";
  serverLog("warn", "api:youtube/grant-status", "grant-check-failed", {
    status: res.status, error: err.error ?? "unknown",
  });
  return NextResponse.json({
    valid: false,
    reason: isInvalidGrant ? "invalid_grant" : "oauth_error",
    detail: err.error_description
      ?? (isInvalidGrant
        ? "The YouTube authorisation has expired or been revoked."
        : `Google returned ${err.error ?? res.status}.`),
    // invalid_grant is the re-authorise case. Other OAuth errors are
    // usually a misconfigured client id/secret, which re-auth won't fix.
    needs_reauth: isInvalidGrant,
  } satisfies GrantStatus);
}

export const POST = withRequestLogging("api:youtube/grant-status", handler as never);
