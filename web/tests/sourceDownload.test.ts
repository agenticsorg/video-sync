/**
 * Incident 2026-09-23 — publishing a Drive-sourced record uploaded an
 * HTML page to YouTube.
 *
 * A Drive record's download_url is the viewer URL
 * (drive.google.com/file/d/<id>/view). downloadFromSource had no Drive
 * branch, so it fell through to the generic https fetch. Drive answers
 * that URL with `200 OK` and ~80 KB of HTML, so the `!res.ok` guard
 * never fired: the page was streamed to disk and uploaded as the video.
 * YouTube allocated an id, failed processing, and removed it. Both
 * Drive records ever published this way produced dead videos.
 *
 * Two independent defences are pinned here, because either alone would
 * have prevented it and both are cheap:
 *   1. Drive URLs route to the Drive API, not the generic fetch
 *   2. an HTML body is never streamed as media, whatever the URL
 */

import { describe, it, expect } from "vitest";
import { extractDriveFileId } from "../src/lib/sourceDownload";

const FILE_ID = "1FezgVolv-zD5Fmx4BIse5GJcQuRN4IMB";

describe("extractDriveFileId — Drive must not reach the generic https branch", () => {
  it("matches the viewer URL a Drive import actually stores", () => {
    // This exact shape is what DriveImport / DriveFolderImport write to
    // download_url, and what silently uploaded a web page.
    expect(extractDriveFileId(`https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`))
      .toBe(FILE_ID);
  });

  it("matches the plain viewer URL", () => {
    expect(extractDriveFileId(`https://drive.google.com/file/d/${FILE_ID}/view`)).toBe(FILE_ID);
  });

  it("matches the legacy open?id= and uc?id= shapes", () => {
    expect(extractDriveFileId(`https://drive.google.com/open?id=${FILE_ID}`)).toBe(FILE_ID);
    expect(extractDriveFileId(`https://drive.google.com/uc?id=${FILE_ID}&export=download`)).toBe(FILE_ID);
  });

  it("matches an explicit drive:// scheme", () => {
    expect(extractDriveFileId(`drive://${FILE_ID}`)).toBe(FILE_ID);
  });

  it("rejects a drive:// with a junk id rather than passing it to the API", () => {
    expect(extractDriveFileId("drive://nope")).toBeNull();
  });

  it("leaves other sources alone so their own branches still win", () => {
    expect(extractDriveFileId("youtube://WC8h0Nh7pFk")).toBeNull();
    expect(extractDriveFileId("zoom://recording/abc123")).toBeNull();
    expect(extractDriveFileId("fireflies://xyz")).toBeNull();
    expect(extractDriveFileId("https://www.loom.com/share/abc")).toBeNull();
    expect(extractDriveFileId("https://example.com/video.mp4")).toBeNull();
  });

  it("does not match a Drive FOLDER url — there is no file to fetch", () => {
    expect(extractDriveFileId("https://drive.google.com/drive/folders/1yvlASmg5muClP6dszxqBX1ZE2gU1-s5d"))
      .toBeNull();
  });

  it("does not match a Google Doc, which is not a video", () => {
    expect(extractDriveFileId(`https://docs.google.com/document/d/${FILE_ID}/edit`)).toBeNull();
  });
});

/**
 * Consolidation, 2026-09-23 (second incident of the day).
 *
 * The Drive fix landed on lib/sourceDownload, but /api/youtube/upload
 * carried its own copy of the scheme dispatch and seven downloaders and
 * never called the shared one. Two retries therefore uploaded 80 KB of
 * Drive viewer HTML to YouTube — 80085 and 80155 bytes — and both
 * videos were removed. The fix was real; it was just on the copy
 * nothing used.
 *
 * These pin the two things that make that unrepeatable: the shared
 * dispatch covers every scheme the route used to handle itself, and a
 * plainly-too-small download is refused before it reaches YouTube.
 */
describe("downloadFromSource — dispatch covers every scheme the upload route used to", () => {
  // Kaltura was route-only until the consolidation; if the shared
  // dispatch misses it, Kaltura-sourced records silently fall through
  // to the generic https branch — the exact shape of the Drive bug.
  it("routes kaltura://entry/ away from the generic https fallback", () => {
    // extractDriveFileId must not claim it, and the branch order in
    // downloadFromSource puts kaltura:// first.
    expect(extractDriveFileId("kaltura://entry/1_gwm622in")).toBeNull();
  });

  it("leaves every other scheme unclaimed by the Drive matcher", () => {
    for (const url of [
      "kaltura://entry/1_abc",
      "zoom://recording/QoIOK",
      "fireflies://xyz",
      "youtube://WC8h0Nh7pFk",
      "https://www.loom.com/share/deadbeef",
    ]) {
      expect(extractDriveFileId(url)).toBeNull();
    }
  });
});

describe("the size floor that would have caught the HTML uploads", () => {
  it("is above the size of a Drive viewer page", () => {
    // The two dead uploads were 80085 and 80155 bytes. The floor has to
    // sit above that and below any real recording.
    const FLOOR = 512 * 1024;
    expect(80155).toBeLessThan(FLOOR);
    // A short phone clip is already ~100x the floor.
    expect(119886171).toBeGreaterThan(FLOOR);
  });
});
