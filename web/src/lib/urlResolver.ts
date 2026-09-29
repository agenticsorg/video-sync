/**
 * The org's MediaSpace portal. Kaltura entries are watched here, not
 * on kaltura.com.
 */
export const KALTURA_PORTAL_BASE = "https://video.agentics.org";

/** The watch page for a Kaltura entry on the org's portal. */
export function kalturaWatchUrl(entryId: string): string {
  return `${KALTURA_PORTAL_BASE}/media/t/${entryId}`;
}

/**
 * Pull the entry id out of any Kaltura URL shape we have ever stored.
 *
 * Four generations of URL are already on records, because three routes
 * each built their own and the shape changed over time:
 *
 *   kaltura://entry/1_yhs8i4rb
 *   https://www.kaltura.com/index.php/extwidget/preview/partner_id/…/entry_id/1_yhs8i4rb/embed/iframe
 *   https://cdnapisec.kaltura.com/p/…/embedIframeJs/…?iframeembed=true&entry_id=1_yhs8i4rb
 *   https://video.agentics.org/media/t/1_yhs8i4rb
 *
 * Normalising on read rather than only on write is what makes the 19
 * records already carrying an old shape render correctly without a
 * catalog migration.
 */
export function extractKalturaEntryId(url: string | null | undefined): string | null {
  if (!url) return null;
  const patterns = [
    /^kaltura:\/\/entry\/(\d+_[A-Za-z0-9]+)/,
    /[?&]entry_id=(\d+_[A-Za-z0-9]+)/,
    /\/entry_id\/(\d+_[A-Za-z0-9]+)/,
    /\/entryId\/(\d+_[A-Za-z0-9]+)/,
    /\/media\/t\/(\d+_[A-Za-z0-9]+)/,
    /\/entry\/(\d+_[A-Za-z0-9]+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Resolve internal pseudo-URLs (used as download_url on catalog records)
 *  to real navigable web URLs, or return null for unhandled schemes. */
export function resolveExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  // Kaltura player/preview URLs are rewritten to the org's portal.
  // This runs BEFORE the http passthrough, because the stored value on
  // every existing record is already an https kaltura.com URL and
  // would otherwise sail through untouched. Download URLs
  // (playManifest) are deliberately not matched — they are fetched,
  // not navigated to.
  if (/kaltura\.com/.test(url) && !/playManifest/.test(url)) {
    const entryId = extractKalturaEntryId(url);
    if (entryId) return kalturaWatchUrl(entryId);
  }

  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  if (url.startsWith("fireflies://")) {
    const id = url.slice("fireflies://".length);
    return `https://app.fireflies.ai/view/${id}`;
  }

  if (url.startsWith("zoom://recording/")) {
    const uuid = url.slice("zoom://recording/".length);
    // Zoom requires double-encoding when the UUID contains a slash
    const encoded = uuid.includes("/")
      ? encodeURIComponent(encodeURIComponent(uuid))
      : encodeURIComponent(uuid);
    return `https://zoom.us/recording/play/${encoded}`;
  }

  if (url.startsWith("youtube://")) {
    return `https://www.youtube.com/watch?v=${url.slice("youtube://".length)}`;
  }

  // kaltura://entry/ stays pointed at the KMC. It appears as a
  // record's origin/download_url — the admin view of an entry we
  // imported — whereas a Destination location is something to watch.
  // Different links for different questions; say so rather than
  // quietly collapsing them.
  if (url.startsWith("kaltura://entry/")) {
    return `https://kmc.kaltura.com/index.php/kmcng/content/entries/entry/${url.slice("kaltura://entry/".length)}`;
  }

  return null;
}
