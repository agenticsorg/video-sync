/**
 * Kaltura links point at the org's MediaSpace portal, not kaltura.com.
 *
 * The catalog already holds several URL shapes, because three routes
 * each built their own and the shape changed over time. Rewriting only
 * the generators would have left all 19 published records still
 * linking to the old preview page, so the rewrite happens on READ —
 * which is what these pin.
 */

import { describe, it, expect } from "vitest";
import {
  resolveExternalUrl,
  extractKalturaEntryId,
  kalturaWatchUrl,
  KALTURA_PORTAL_BASE,
} from "../src/lib/urlResolver";

const ENTRY = "1_yhs8i4rb";
const WATCH = `${KALTURA_PORTAL_BASE}/media/t/${ENTRY}`;

describe("extractKalturaEntryId — every shape already on a record", () => {
  it("reads the extwidget preview URL the 19 records carry", () => {
    expect(extractKalturaEntryId(
      `https://www.kaltura.com/index.php/extwidget/preview/partner_id/5896392/uiconf_id/0/entry_id/${ENTRY}/embed/iframe`,
    )).toBe(ENTRY);
  });

  it("reads the cdnapisec embed URL", () => {
    expect(extractKalturaEntryId(
      `https://cdnapisec.kaltura.com/p/5896392/sp/589639200/embedIframeJs/uiconf_id/0/partner_id/5896392?iframeembed=true&entry_id=${ENTRY}`,
    )).toBe(ENTRY);
  });

  it("reads the kaltura:// pseudo-scheme", () => {
    expect(extractKalturaEntryId(`kaltura://entry/${ENTRY}`)).toBe(ENTRY);
  });

  it("reads a portal URL it produced itself, so the rewrite is idempotent", () => {
    expect(extractKalturaEntryId(WATCH)).toBe(ENTRY);
  });

  it("returns null for a URL with no entry id", () => {
    expect(extractKalturaEntryId("https://www.kaltura.com/")).toBeNull();
    expect(extractKalturaEntryId(null)).toBeNull();
  });
});

describe("resolveExternalUrl — Kaltura", () => {
  it("rewrites the stored preview URL to the portal", () => {
    // The specific value on record 833b9f16, which is what the
    // operator saw on the card.
    expect(resolveExternalUrl(
      `https://www.kaltura.com/index.php/extwidget/preview/partner_id/5896392/uiconf_id/0/entry_id/${ENTRY}/embed/iframe`,
    )).toBe(WATCH);
  });

  it("rewrites the cdnapisec embed URL too", () => {
    expect(resolveExternalUrl(
      `https://cdnapisec.kaltura.com/p/5896392/sp/589639200/embedIframeJs/uiconf_id/0/partner_id/5896392?iframeembed=true&entry_id=${ENTRY}`,
    )).toBe(WATCH);
  });

  it("is idempotent — a portal URL passes through unchanged", () => {
    expect(resolveExternalUrl(WATCH)).toBe(WATCH);
  });

  it("leaves a playManifest download URL alone", () => {
    // These are fetched by the downloader, never navigated to.
    // Rewriting one would break publishing from a Kaltura source.
    const dl = `https://cdnapisec.kaltura.com/p/5896392/sp/589639200/playManifest/entryId/${ENTRY}/format/download/protocol/https/ks/abc123`;
    expect(resolveExternalUrl(dl)).toBe(dl);
  });

  it("still sends kaltura://entry/ to the KMC", () => {
    // A record's origin is the admin view of an entry we imported;
    // a Destination location is something to watch. Two questions,
    // two links.
    expect(resolveExternalUrl(`kaltura://entry/${ENTRY}`))
      .toBe(`https://kmc.kaltura.com/index.php/kmcng/content/entries/entry/${ENTRY}`);
  });

  it("does not disturb other platforms", () => {
    expect(resolveExternalUrl("https://www.youtube.com/watch?v=abc")).toBe("https://www.youtube.com/watch?v=abc");
    expect(resolveExternalUrl("youtube://abc")).toBe("https://www.youtube.com/watch?v=abc");
    expect(resolveExternalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(resolveExternalUrl(null)).toBeNull();
  });
});

describe("kalturaWatchUrl", () => {
  it("builds the shape the operator asked for", () => {
    expect(kalturaWatchUrl(ENTRY)).toBe("https://video.agentics.org/media/t/1_yhs8i4rb");
  });
});
