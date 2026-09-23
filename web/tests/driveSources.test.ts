/**
 * ADR-078 — Drive folder-as-source.
 *
 * Covers the three rules that decide what a folder listing offers an
 * operator (§4 already_indexed, §4 duplicate_of, §5 own-output
 * exclusion), plus folder-id parsing and the Drive query builder.
 */

import { describe, it, expect } from "vitest";
import {
  classifyDriveLink,
  wrongLinkKindMessage,
  detectFolderId,
  importStateKey,
  collectDriveFacts,
  classifyDriveFile,
  DRIVE_LIST_MAX_FILES,
  type DriveSourceFile,
} from "../src/lib/driveSources";
import { buildQuery } from "../src/app/api/drive/sources/list/route";

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

function listedFile(
  overrides: Partial<Omit<DriveSourceFile, "already_indexed" | "duplicate_of">> = {},
): Omit<DriveSourceFile, "already_indexed" | "duplicate_of"> {
  return {
    file_id: FILE_ID,
    name: "Friday Hackerspace.mp4",
    mime_type: "video/mp4",
    size_bytes: 1024,
    duration_seconds: 3600,
    created_time: "2026-09-18T14:00:00Z",
    modified_time: "2026-09-18T14:00:00Z",
    thumbnail_link: null,
    web_view_link: null,
    owner_email: null,
    md5_checksum: null,
    ...overrides,
  };
}

interface FactsRecord {
  id: string;
  source_platform: string;
  source_id: string;
  metadata_extra?: Record<string, unknown> | null;
  locations?: Array<{ platform: string; role: string; external_id: string }>;
}

function record(overrides: Partial<FactsRecord> = {}): FactsRecord {
  return {
    id: "rec-1",
    source_platform: "Zoom",
    source_id: "zoom-1",
    metadata_extra: null,
    locations: [],
    ...overrides,
  };
}

describe("detectFolderId", () => {
  it("reads a folder URL", () => {
    expect(detectFolderId(`https://drive.google.com/drive/folders/${FILE_ID}`)).toBe(FILE_ID);
  });

  it("reads a folder URL with query junk and an account prefix", () => {
    expect(detectFolderId(`https://drive.google.com/drive/u/2/folders/${FILE_ID}?usp=sharing`)).toBe(FILE_ID);
  });

  it("reads a legacy open?id= link", () => {
    expect(detectFolderId(`https://drive.google.com/open?id=${FILE_ID}`)).toBe(FILE_ID);
  });

  it("accepts a bare id", () => {
    expect(detectFolderId(`  ${FILE_ID}  `)).toBe(FILE_ID);
  });

  it("rejects a FILE link — that is ADR-071's paste box, not a folder", () => {
    expect(detectFolderId(`https://drive.google.com/file/d/${FILE_ID}/view`)).toBeNull();
  });

  it("rejects empty and obviously-not-an-id input", () => {
    expect(detectFolderId("")).toBeNull();
    expect(detectFolderId("   ")).toBeNull();
    expect(detectFolderId("not a folder")).toBeNull();
    expect(detectFolderId("short")).toBeNull();
  });
});

describe("importStateKey", () => {
  it("namespaces the folder label so Overview can group it", () => {
    expect(importStateKey({ label: "Toronto uploads" })).toBe("GoogleDrive:Toronto uploads");
  });
});

describe("buildQuery", () => {
  it("scopes to the folder, videos only, untrashed", () => {
    const q = buildQuery(FILE_ID);
    expect(q).toContain(`'${FILE_ID}' in parents`);
    expect(q).toContain("mimeType contains 'video/'");
    expect(q).toContain("trashed = false");
  });

  it("omits date clauses when no window is given", () => {
    expect(buildQuery(FILE_ID)).not.toContain("createdTime");
  });

  it("covers the whole of the `to` day", () => {
    // A bare YYYY-MM-DD would mean midnight, silently excluding
    // everything recorded during the final day of the window.
    const q = buildQuery(FILE_ID, "2026-09-01", "2026-09-30");
    expect(q).toContain("createdTime >= '2026-09-01T00:00:00'");
    expect(q).toContain("createdTime <= '2026-09-30T23:59:59'");
  });

  it("escapes a quote in the folder id rather than breaking the query", () => {
    expect(buildQuery("ab'cd")).toContain("'ab\\'cd' in parents");
  });
});

describe("collectDriveFacts", () => {
  it("indexes GoogleDrive source ids and ignores other platforms", () => {
    const facts = collectDriveFacts([
      record({ id: "r1", source_platform: "GoogleDrive", source_id: `drive-${FILE_ID}` }),
      record({ id: "r2", source_platform: "Zoom", source_id: "zoom-9" }),
    ]);
    expect(facts.indexedSourceIds.has(`drive-${FILE_ID}`)).toBe(true);
    expect(facts.indexedSourceIds.has("zoom-9")).toBe(false);
  });

  it("maps a content hash to the first record holding it", () => {
    const facts = collectDriveFacts([
      record({ id: "older", metadata_extra: { drive_md5: "abc123" } }),
      record({ id: "newer", metadata_extra: { drive_md5: "abc123" } }),
    ]);
    expect(facts.md5ToRecord.get("abc123")).toBe("older");
  });

  it("collects only GoogleDrive Destination locations as published output", () => {
    const facts = collectDriveFacts([
      record({ locations: [{ platform: "GoogleDrive", role: "Destination", external_id: "published-1" }] }),
      record({ locations: [{ platform: "GoogleDrive", role: "Origin", external_id: "origin-1" }] }),
      record({ locations: [{ platform: "YouTube", role: "Destination", external_id: "yt-1" }] }),
    ]);
    expect(facts.publishedFileIds.has("published-1")).toBe(true);
    expect(facts.publishedFileIds.has("origin-1")).toBe(false);
    expect(facts.publishedFileIds.has("yt-1")).toBe(false);
  });

  it("survives records with no metadata_extra or locations", () => {
    expect(() => collectDriveFacts([record({ metadata_extra: null, locations: undefined })])).not.toThrow();
  });
});

describe("classifyDriveFile — §5, never offer our own published output", () => {
  it("drops a file this app published into the folder", () => {
    const facts = collectDriveFacts([
      record({ locations: [{ platform: "GoogleDrive", role: "Destination", external_id: FILE_ID }] }),
    ]);
    expect(classifyDriveFile(listedFile(), facts)).toBeNull();
  });

  it("keeps a file that merely SITS beside our output", () => {
    const facts = collectDriveFacts([
      record({ locations: [{ platform: "GoogleDrive", role: "Destination", external_id: "some-other-file" }] }),
    ]);
    expect(classifyDriveFile(listedFile(), facts)).not.toBeNull();
  });

  it("drops our output even when the record also looks like a duplicate", () => {
    // Exclusion outranks the advisory flag: a published file must never
    // be offered, however it scores on the other rules.
    const facts = collectDriveFacts([
      record({
        id: "ours",
        metadata_extra: { drive_md5: "same-bytes" },
        locations: [{ platform: "GoogleDrive", role: "Destination", external_id: FILE_ID }],
      }),
    ]);
    expect(classifyDriveFile(listedFile({ md5_checksum: "same-bytes" }), facts)).toBeNull();
  });
});

describe("classifyDriveFile — §4, dedupe", () => {
  it("marks a file already in the catalog", () => {
    const facts = collectDriveFacts([
      record({ id: "r1", source_platform: "GoogleDrive", source_id: `drive-${FILE_ID}` }),
    ]);
    expect(classifyDriveFile(listedFile(), facts)?.already_indexed).toBe(true);
  });

  it("leaves an unseen file selectable", () => {
    const row = classifyDriveFile(listedFile(), collectDriveFacts([]));
    expect(row?.already_indexed).toBe(false);
    expect(row?.duplicate_of).toBeUndefined();
  });

  it("flags a re-upload under a fresh Drive id by its content hash", () => {
    // The whole point of recording md5: a new file_id passes the id
    // check, but the bytes are ones we already hold.
    const facts = collectDriveFacts([
      record({ id: "original", source_platform: "GoogleDrive", source_id: "drive-OLD_ID", metadata_extra: { drive_md5: "deadbeef" } }),
    ]);
    const row = classifyDriveFile(listedFile({ md5_checksum: "deadbeef" }), facts);
    expect(row?.already_indexed).toBe(false);
    expect(row?.duplicate_of).toBe("original");
  });

  it("does not add a duplicate hint to a row that is already the record", () => {
    const facts = collectDriveFacts([
      record({ id: "r1", source_platform: "GoogleDrive", source_id: `drive-${FILE_ID}`, metadata_extra: { drive_md5: "deadbeef" } }),
    ]);
    const row = classifyDriveFile(listedFile({ md5_checksum: "deadbeef" }), facts);
    expect(row?.already_indexed).toBe(true);
    expect(row?.duplicate_of).toBeUndefined();
  });

  it("adds no hint when Drive gave us no hash", () => {
    const facts = collectDriveFacts([
      record({ id: "original", metadata_extra: { drive_md5: "deadbeef" } }),
    ]);
    expect(classifyDriveFile(listedFile({ md5_checksum: null }), facts)?.duplicate_of).toBeUndefined();
  });

  it("flags rather than blocks — a duplicate is still importable", () => {
    // Advisory, never auto-merged: identical bytes can legitimately
    // warrant a second record (a re-upload replacing a corrupt one).
    const facts = collectDriveFacts([
      record({ id: "original", metadata_extra: { drive_md5: "deadbeef" } }),
    ]);
    const row = classifyDriveFile(listedFile({ md5_checksum: "deadbeef" }), facts);
    expect(row).not.toBeNull();
    expect(row?.already_indexed).toBe(false);
  });
});

describe("listing caps", () => {
  it("caps a single listing at 500 files", () => {
    expect(DRIVE_LIST_MAX_FILES).toBe(500);
  });
});

/**
 * The file-vs-folder trap, hit twice in one session on 2026-09-23:
 * a file link pasted into the folder field (rejected with advice about
 * folders), then a folder link pasted into the file box (rejected with
 * advice about files). Both inputs sit on the same screen and a Drive
 * link is valid for exactly one of them, so "paste the other kind" is
 * true and useless — the message has to name what you pasted and where
 * it belongs.
 */
describe("classifyDriveLink", () => {
  const FOLDER = "1yvlASmg5muClP6dszxqBX1ZE2gU1-s5d";

  it("recognises a file link", () => {
    expect(classifyDriveLink(`https://drive.google.com/file/d/${FILE_ID}/view?usp=drive_link`))
      .toEqual({ kind: "file", id: FILE_ID });
  });

  it("recognises a folder link, including an account-scoped one", () => {
    expect(classifyDriveLink(`https://drive.google.com/drive/folders/${FOLDER}`).kind).toBe("folder");
    expect(classifyDriveLink(`https://drive.google.com/drive/u/2/folders/${FOLDER}?usp=sharing`).kind).toBe("folder");
  });

  it("recognises a Google-native doc, which is never a video", () => {
    expect(classifyDriveLink(`https://docs.google.com/document/d/${FILE_ID}/edit`).kind).toBe("google-doc");
  });

  it("stays honest about open?id= — Drive uses it for both", () => {
    const g = classifyDriveLink(`https://drive.google.com/open?id=${FILE_ID}`);
    expect(g.kind).toBe("unknown");
    expect(g.id).toBe(FILE_ID);   // still usable, just not classifiable
  });

  it("stays honest about a bare id", () => {
    expect(classifyDriveLink(FILE_ID)).toEqual({ kind: "unknown", id: FILE_ID });
  });

  it("returns nothing for input that isn't a Drive reference", () => {
    expect(classifyDriveLink("https://youtube.com/watch?v=abc")).toEqual({ kind: "unknown", id: null });
    expect(classifyDriveLink("")).toEqual({ kind: "unknown", id: null });
  });
});

describe("wrongLinkKindMessage", () => {
  const FOLDER = "1yvlASmg5muClP6dszxqBX1ZE2gU1-s5d";
  const fileUrl = `https://drive.google.com/file/d/${FILE_ID}/view`;
  const folderUrl = `https://drive.google.com/drive/folders/${FOLDER}`;

  it("tells a folder field that it got a file, and where files go", () => {
    const msg = wrongLinkKindMessage(fileUrl, "folder")!;
    expect(msg).toContain("single file");
    expect(msg).toContain("/drive/folders/");     // how to get the right link
    expect(msg).toContain("single file link");    // where this one belongs
  });

  it("tells a file box that it got a folder, and where folders go", () => {
    const msg = wrongLinkKindMessage(folderUrl, "file")!;
    expect(msg).toContain("folder");
    expect(msg).toContain("Drive source folders");  // names the actual screen
  });

  it("calls out a Google Doc whichever field it lands in", () => {
    const docUrl = `https://docs.google.com/document/d/${FILE_ID}/edit`;
    expect(wrongLinkKindMessage(docUrl, "file")).toContain("not a video");
    expect(wrongLinkKindMessage(docUrl, "folder")).toContain("not a video");
  });

  it("says nothing when the link is the RIGHT kind — caller handles it", () => {
    expect(wrongLinkKindMessage(fileUrl, "file")).toBeNull();
    expect(wrongLinkKindMessage(folderUrl, "folder")).toBeNull();
  });

  it("says nothing for unclassifiable input, so the generic message shows", () => {
    expect(wrongLinkKindMessage("total nonsense", "folder")).toBeNull();
    expect(wrongLinkKindMessage(FILE_ID, "folder")).toBeNull();
  });
});
