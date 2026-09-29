/**
 * Every Kaltura session must bypass entitlements.
 *
 * Kaltura enforces entitlements per privacy context. A MediaSpace/KMS
 * root sets one up, and a type-2 ADMIN session is NOT exempt: content
 * in an entitled context is simply absent from listings and closed to
 * writes, with no error. On partner 5896392 that hid 135 of 163
 * categories, and the tool confidently reported four real categories
 * the operator uses by hand as "not_found".
 *
 * The failure mode is silence, so it cannot be caught by watching for
 * errors — only by checking that every session asks. This walks the
 * source rather than asserting on one call, because the risk is a
 * NEW mint site added later without the privilege, which no
 * behavioural test would cover.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { DISABLE_ENTITLEMENT } from "../src/lib/kalturaApi";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/**
 * Comments stripped.
 *
 * The first version of this test checked the raw file, and every file
 * it checked carried a comment EXPLAINING why disableentitlement is
 * needed — so the substring matched the prose and the test passed with
 * the privilege deleted. Verified by deleting one and watching it stay
 * green. A guard that cannot fail is worse than no guard, because it
 * is also a claim that the thing is covered.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Files that mint a Kaltura session, by any of the spellings in use. */
function sessionMintSites(): { file: string; body: string }[] {
  return walk(SRC)
    .map(file => ({ file, body: code(readFileSync(file, "utf-8")) }))
    .filter(({ file, body }) =>
      !file.endsWith("kalturaApi.ts") &&
      (/service=session&action=start/.test(body) ||
        /["']session["'],\s*["']start["']/.test(body) ||
        /mintAdminKs\(/.test(body)));
}

describe("Kaltura session privileges", () => {
  it("finds the mint sites at all, so the test cannot pass by finding nothing", () => {
    // A guard on the guard: if the search stops matching — a rename, a
    // new helper — this test would otherwise go green while checking
    // zero files.
    expect(sessionMintSites().length).toBeGreaterThanOrEqual(6);
  });

  it("every site asks to bypass entitlements", () => {
    const offenders = sessionMintSites()
      .filter(({ body }) => !body.includes(DISABLE_ENTITLEMENT) && !body.includes("DISABLE_ENTITLEMENT"))
      .map(({ file }) => file.slice(SRC.length + 1));

    expect(offenders, [
      "These mint a Kaltura session without disableentitlement.",
      "Content in an entitled privacy context will be silently invisible:",
      "listings come back short and writes are refused, with no error.",
      "Pass `privileges: DISABLE_ENTITLEMENT` to mintAdminKs, or set",
      "`privileges=disableentitlement` on the session.start form.",
    ].join(" ")).toEqual([]);
  });
});

describe("the shared client", () => {
  it("exports the privilege as a constant rather than a scattered literal", () => {
    expect(DISABLE_ENTITLEMENT).toBe("disableentitlement");
  });

  it("is the only place a Kaltura call is implemented", () => {
    // Three routes each carried their own kalturaCall, and they had
    // already drifted: only one raised on a KalturaAPIException, so
    // the others returned the exception object as if it were a result.
    const dupes = walk(SRC)
      .filter(f => !f.endsWith("kalturaApi.ts"))
      .filter(f => /(async )?function kalturaCall\(/.test(code(readFileSync(f, "utf-8"))))
      .map(f => f.slice(SRC.length + 1));
    expect(dupes).toEqual([]);
  });
});
