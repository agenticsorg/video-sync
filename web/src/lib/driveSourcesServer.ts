/**
 * ADR-078 — Drive source folders: server-side auth.
 *
 * Server-only: do not import from client components. It pulls in
 * google-auth-library.
 *
 * This lives here rather than in a route because Next.js App Router
 * allows a `route.ts` to export ONLY HTTP handlers and a fixed set of
 * config values. `driveReadonlyToken` was exported from
 * app/api/drive/sources/route.ts and imported by the sibling
 * `sources/list/route.ts`, which fails the production build:
 *
 *   .next/types/app/api/drive/sources/route.ts: error TS2344
 *   Property 'driveReadonlyToken' is incompatible with index signature.
 *   Type '() => Promise<string | null>' is not assignable to type 'never'.
 *
 * It is also why the companion pure helper `buildQuery` moved to
 * lib/driveSources.ts. Shared code between two routes belongs in lib,
 * not in whichever route happened to define it first.
 */

import { GoogleAuth } from "google-auth-library";

const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Mint a drive.readonly access token from the runtime service account.
 *
 * NOT lib/drive.ts's client — that one holds `drive.file`, which only
 * reaches files the app itself created and so can never see an
 * operator's folder (ADR-078 §6).
 */
export async function driveReadonlyToken(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({ scopes: [DRIVE_READONLY] });
    const client = await auth.getClient();
    const resp = await client.getAccessToken();
    return resp.token ?? null;
  } catch {
    return null;
  }
}

/**
 * The runtime SA's own address, for the "share the folder with…" hint.
 * Best-effort: a local dev box on user ADC has no client_email.
 */
export async function serviceAccountEmail(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({ scopes: [DRIVE_READONLY] });
    const creds = await auth.getCredentials();
    return creds.client_email ?? null;
  } catch {
    return null;
  }
}
