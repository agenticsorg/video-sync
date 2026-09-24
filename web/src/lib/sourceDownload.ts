/**
 * Server-side helpers for downloading source media to a temp file.
 * Shared between /api/youtube/upload and /api/kaltura/upload (ADR-037).
 *
 * Server-only: do not import from client components.
 */

import { execFile } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface SourceCreds {
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  firefliesApiKey?: string;
  ytCookies?: string;
  kalturaPartnerId?: string;
  kalturaAdminSecret?: string;
}

/** Bytes transferred so far, and the total when the server declared one. */
export interface TransferProgress {
  bytes: number;
  total: number | null;
}

export type ProgressFn = (p: TransferProgress) => void;

/** How often to report. A 4.86 GB download takes minutes; without
 *  something every couple of seconds the UI is indistinguishable from a
 *  hang, which is exactly how 2026-09-24's OOM looked to the operator. */
const PROGRESS_INTERVAL_MS = 2000;

/** Human bytes. 5217991781 reads as "4.86 GB". */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** "1.20 GB / 4.86 GB (24%)", or just the running total when the size
 *  is unknown — a progress bar that invents a denominator is worse than
 *  one that admits it doesn't have it. */
export function formatProgress(p: TransferProgress): string {
  if (p.total && p.total > 0) {
    const pct = Math.min(100, Math.round((p.bytes / p.total) * 100));
    return `${formatBytes(p.bytes)} / ${formatBytes(p.total)} (${pct}%)`;
  }
  return formatBytes(p.bytes);
}

/** A pass-through that counts bytes and reports on a timer. */
function progressCounter(total: number | null, onProgress?: ProgressFn): Transform {
  let seen = 0;
  let lastReport = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onProgress({ bytes: seen, total });
      }
      cb(null, chunk);
    },
    flush(cb) {
      onProgress?.({ bytes: seen, total });
      cb();
    },
  });
}

/** Stream a fetch response body to a file on disk. */
async function streamToFile(
  response: Response,
  filePath: string,
  onProgress?: ProgressFn,
): Promise<void> {
  if (!response.body) throw new Error("Response has no body");
  const webStream = response.body as ReadableStream<Uint8Array>;
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const declared = Number(response.headers.get("content-length") ?? "");
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  await pipeline(nodeStream, progressCounter(total, onProgress), createWriteStream(filePath));
}

/**
 * Refuse a response that is plainly a web page rather than media.
 *
 * Incident 2026-09-23: a Drive-sourced record's `download_url` is a
 * Drive *viewer* URL, which fell through to the generic https branch
 * below. Drive answers it with `200 OK` and 80 KB of HTML, so the
 * `!res.ok` guard never fired — the viewer page was streamed to disk
 * and uploaded to YouTube as the video. YouTube allocated an id, failed
 * processing, and removed it. Every Drive record ever published this
 * way produced a dead video, and nothing anywhere said so.
 *
 * A 200 is not evidence that a body is media. This is the cheap check
 * that turns that silent corruption into an error.
 */
function rejectNonMediaBody(res: Response, downloadUrl: string): void {
  const contentType = res.headers.get("content-type") ?? "";
  // application/xml comes from Kaltura's error responses; its own
  // downloader has rejected it since before this guard existed, and the
  // reason was never Kaltura-specific.
  if (/^\s*(text\/html|application\/xml)/i.test(contentType)) {
    throw new Error(
      `Source URL returned an HTML page, not media (content-type: ${contentType}). ` +
      `This usually means the URL points at a viewer page rather than the file itself: ${downloadUrl.slice(0, 80)}`,
    );
  }
}

/** Drive file id out of any of the URL shapes we store, or null. */
export function extractDriveFileId(downloadUrl: string): string | null {
  if (downloadUrl.startsWith("drive://")) {
    const id = downloadUrl.slice("drive://".length).trim();
    return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
  }
  let m = downloadUrl.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/i);
  if (m) return m[1];
  m = downloadUrl.match(/drive\.google\.com\/(?:open|uc)\?[^"']*id=([A-Za-z0-9_-]{10,})/i);
  if (m) return m[1];
  return null;
}

/**
 * Download a Drive file through the API, which is the only way to get
 * the bytes — the `/view` URL a record stores is a viewer page.
 *
 * Authenticates as the Cloud Run runtime service account at
 * `drive.readonly`, the same identity ADR-071's ingest uses, so
 * anything the app could import it can also publish.
 */
async function downloadDriveToFile(fileId: string, outPath: string, onProgress?: ProgressFn): Promise<void> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error("Could not mint a Drive token for the service account");

  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
            + `?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Drive download failed (${res.status}) for file ${fileId}`
      + (res.status === 403 || res.status === 404
        ? " — the runtime service account can't read it. Share the file or its folder with the service account."
        : `: ${detail.slice(0, 200)}`),
    );
  }
  // Belt and braces: an auth redirect or interstitial would be HTML.
  rejectNonMediaBody(res, `drive://${fileId}`);
  await streamToFile(res, outPath, onProgress);
}

/**
 * Download a Kaltura entry via an admin session.
 *
 * Moved here from /api/youtube/upload, which carried its own copy of
 * this and six other downloaders. That duplication is why the Drive fix
 * of 2026-09-23 missed the YouTube publish path entirely: the fix
 * landed on this module and the upload route never called it.
 */
async function downloadKalturaToFile(entryId: string, creds: SourceCreds, outPath: string): Promise<void> {
  const { kalturaPartnerId: partnerId, kalturaAdminSecret: adminSecret } = creds;
  if (!partnerId || !adminSecret) {
    throw new Error("Kaltura credentials required for kaltura:// download");
  }
  // Mint an admin Kaltura Session (KS) so the download URL is authorized.
  const sessForm = new URLSearchParams();
  sessForm.set("format", "1"); // JSON
  sessForm.set("partnerId", partnerId);
  sessForm.set("secret", adminSecret);
  sessForm.set("type", "2"); // ADMIN
  sessForm.set("userId", "video-sync");
  sessForm.set("expiry", "3600");
  const sessRes = await fetch("https://www.kaltura.com/api_v3/?service=session&action=start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: sessForm,
  });
  if (!sessRes.ok) throw new Error(`Kaltura session.start HTTP ${sessRes.status}`);
  const sessJson = await sessRes.json();
  const ks: string = typeof sessJson === "string" ? sessJson : (sessJson?.result ?? "");
  if (!ks || ks.length < 10) {
    throw new Error(`Kaltura session.start returned no usable KS: ${JSON.stringify(sessJson).slice(0, 120)}`);
  }

  // playManifest "format/download" serves the source/highest flavor as a
  // direct file. The KS authorizes access to the entry.
  const url = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/ks/${ks}`;
  const dlRes = await fetch(url, { redirect: "follow" });
  if (!dlRes.ok) throw new Error(`Kaltura download failed (${dlRes.status}) for entry ${entryId}`);
  rejectNonMediaBody(dlRes, `kaltura://entry/${entryId}`);
  await streamToFile(dlRes, outPath);
}

async function getZoomAccessToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Zoom token error (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function downloadZoomToFile(meetingUuid: string, creds: SourceCreds, outPath: string): Promise<void> {
  if (!creds.zoomAccountId || !creds.zoomClientId || !creds.zoomClientSecret) {
    throw new Error("Zoom credentials required for zoom:// download");
  }
  const zoomToken = await getZoomAccessToken(creds.zoomAccountId, creds.zoomClientId, creds.zoomClientSecret);
  const encodedUuid = meetingUuid.includes("/") ? encodeURIComponent(encodeURIComponent(meetingUuid)) : encodeURIComponent(meetingUuid);
  const recRes = await fetch(`https://api.zoom.us/v2/meetings/${encodedUuid}/recordings`, {
    headers: { Authorization: `Bearer ${zoomToken}` },
  });
  if (!recRes.ok) throw new Error(`Zoom recordings API error (${recRes.status}): ${await recRes.text()}`);
  const recData = await recRes.json();
  const mp4 = (recData.recording_files ?? []).find(
    (f: { file_type: string; status: string }) => f.file_type === "MP4" && f.status === "completed",
  );
  if (!mp4?.download_url) throw new Error("No completed MP4 recording file found for this meeting");
  const dlRes = await fetch(`${mp4.download_url}?access_token=${zoomToken}`);
  if (!dlRes.ok) throw new Error(`Zoom video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

async function downloadFirefliesToFile(transcriptId: string, apiKey: string, outPath: string): Promise<void> {
  const query = `query GetTranscript($id: String!) { transcript(id: $id) { video_url audio_url } }`;
  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });
  if (!res.ok) throw new Error(`Fireflies API error (${res.status})`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Fireflies GraphQL error: ${json.errors[0]?.message}`);
  const t = json.data?.transcript;
  const videoUrl: string | null = t?.video_url || t?.audio_url || null;
  if (!videoUrl) throw new Error("Fireflies returned no video/audio URL for this transcript.");
  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) throw new Error(`Fireflies video download failed (${dlRes.status})`);
  await streamToFile(dlRes, outPath);
}

function extractLoomVideoId(url: string): string | null {
  const m = url.match(/loom\.com\/(?:share|v)\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

async function downloadLoomToFile(videoId: string, outPath: string): Promise<void> {
  // Use yt-dlp for Loom — it handles Apollo state extraction reliably.
  const url = `https://www.loom.com/share/${videoId}`;
  await new Promise<void>((resolve, reject) => {
    execFile("yt-dlp", ["--output", outPath, "--no-playlist", "--quiet", "--no-warnings", url], { timeout: 3600000 }, (err, _o, stderr) => {
      if (err) {
        if (err.message.includes("ENOENT")) reject(new Error("yt-dlp not installed."));
        else reject(new Error(`Loom download failed: ${(stderr || err.message).slice(0, 500)}`));
      } else resolve();
    });
  });
}

async function downloadYouTubeToFile(videoId: string, outPath: string, cookies?: string): Promise<void> {
  let cookiesPath: string | null = null;
  if (cookies?.trim()) {
    cookiesPath = join(tmpdir(), `yt-cookies-${Date.now()}.txt`);
    await fs.writeFile(cookiesPath, cookies, "utf8");
  }
  const args = [
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", outPath, "--no-playlist", "--quiet", "--no-warnings",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("yt-dlp", args, { timeout: 3600000 }, (err, _o, stderr) => {
        if (err) {
          if (err.message.includes("ENOENT")) reject(new Error("yt-dlp not installed."));
          else reject(new Error(`yt-dlp failed: ${(stderr || err.message).slice(0, 500)}`));
        } else resolve();
      });
    });
  } finally {
    if (cookiesPath) fs.unlink(cookiesPath).catch(() => {});
  }
  void BROWSER_UA;
}

/**
 * Dispatch by URL scheme. Writes the source media to outPath. Throws with a
 * useful message if creds or scheme don't match.
 */
export async function downloadFromSource(
  downloadUrl: string,
  creds: SourceCreds,
  outPath: string,
  onProgress?: ProgressFn,
): Promise<void> {
  if (downloadUrl.startsWith("zoom://recording/")) {
    return downloadZoomToFile(downloadUrl.slice("zoom://recording/".length), creds, outPath);
  }
  if (downloadUrl.startsWith("fireflies://")) {
    if (!creds.firefliesApiKey) throw new Error("Fireflies API key required for fireflies:// download");
    return downloadFirefliesToFile(downloadUrl.slice("fireflies://".length), creds.firefliesApiKey, outPath);
  }
  if (downloadUrl.startsWith("kaltura://entry/")) {
    return downloadKalturaToFile(downloadUrl.slice("kaltura://entry/".length), creds, outPath);
  }
  if (downloadUrl.startsWith("youtube://")) {
    return downloadYouTubeToFile(downloadUrl.slice("youtube://".length), outPath, creds.ytCookies);
  }
  const loomId = extractLoomVideoId(downloadUrl);
  if (loomId) {
    return downloadLoomToFile(loomId, outPath);
  }
  // Drive must be matched BEFORE the generic https branch: a Drive
  // record's download_url is an ordinary https URL, so the fallback
  // would happily fetch the viewer page. ADR-071 §3 intended
  // download_url to be the ingested copy; it never was, and the
  // mismatch went unnoticed because Drive answers the viewer URL 200.
  const driveId = extractDriveFileId(downloadUrl);
  if (driveId) {
    return downloadDriveToFile(driveId, outPath, onProgress);
  }
  if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) {
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error(`Source download failed (${dlRes.status})`);
    rejectNonMediaBody(dlRes, downloadUrl);
    return streamToFile(dlRes, outPath, onProgress);
  }
  throw new Error(`Unsupported source URL scheme: ${downloadUrl.slice(0, 40)}`);
}
