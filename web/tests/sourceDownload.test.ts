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
