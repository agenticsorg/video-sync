import { NextRequest, NextResponse } from "next/server";
import { serverLog } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";
import { downloadFromSource, formatProgress, formatBytes } from "../../../../lib/sourceDownload";
import { recordUpload } from "../../../../lib/uploadQuota";
import { stagedPath, discardStaged } from "../../../../lib/mediaStaging";

/** Smallest plausible recording. A Drive viewer page is ~80 KB; the two
 *  videos killed on 2026-09-23 were 80085 and 80155 bytes. */
const MIN_PLAUSIBLE_MEDIA_BYTES = 512 * 1024;
import { execFile } from "child_process";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { join } from "path";
import { Readable } from "stream";

interface UploadRequest {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  title: string;
  description?: string;
  tags?: string[];
  downloadUrl: string;
  privacyStatus?: "private" | "unlisted" | "public";
  recordedAt?: string;
  trimStartSeconds?: number;
  // Zoom credentials (needed when downloadUrl is zoom://recording/...)
  zoomAccountId?: string;
  zoomClientId?: string;
  zoomClientSecret?: string;
  // Fireflies credentials (needed when downloadUrl is fireflies://...)
  firefliesApiKey?: string;
  // Kaltura credentials (needed when downloadUrl is kaltura://entry/...).
  // Usually resolved server-side from Secret Manager; body fields are an
  // optional operator override.
  kalturaPartnerId?: string;
  kalturaAdminSecret?: string;
  // YouTube cookies in Netscape format (needed to bypass bot detection)
  ytCookies?: string;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseEvent(type: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Main upload handler (SSE streaming) ──────────────────────────────────────
// Returns a text/event-stream response so the full upload lifecycle runs in a
// single HTTP connection — no cross-instance job-store lookup, no polling.
// Events: progress { phase }, complete { videoId, videoUrl }, error { message }

async function handler(req: NextRequest) {
  let body: UploadRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const refreshToken = body.refreshToken || process.env.YOUTUBE_REFRESH_TOKEN;
  const clientId = body.clientId || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = body.clientSecret || process.env.YOUTUBE_CLIENT_SECRET;

  // Source credentials. The client only forwards local overrides; per
  // ADR-042 Zoom/Fireflies/Kaltura live shared in Secret Manager. Resolve
  // the shared copy for whichever scheme this download uses so a
  // cross-platform re-publish (e.g. Kaltura entry → YouTube) works without
  // the operator pasting platform creds locally.
  const dl = body.downloadUrl ?? "";
  let zoomAccountId = body.zoomAccountId || process.env.ZOOM_ACCOUNT_ID;
  let zoomClientId = body.zoomClientId || process.env.ZOOM_CLIENT_ID;
  let zoomClientSecret = body.zoomClientSecret || process.env.ZOOM_CLIENT_SECRET;
  let firefliesApiKey = body.firefliesApiKey || process.env.FIREFLIES_API_KEY;
  let kalturaPartnerId = body.kalturaPartnerId || process.env.KALTURA_PARTNER_ID;
  let kalturaAdminSecret = body.kalturaAdminSecret || process.env.KALTURA_ADMIN_SECRET;

  if (dl.startsWith("zoom://") && (!zoomAccountId || !zoomClientId || !zoomClientSecret)) {
    const s = (await getSharedCredential("zoom")) as { accountId?: string; clientId?: string; clientSecret?: string } | null;
    if (s) { zoomAccountId ||= s.accountId; zoomClientId ||= s.clientId; zoomClientSecret ||= s.clientSecret; }
  }
  if (dl.startsWith("fireflies://") && !firefliesApiKey) {
    const s = (await getSharedCredential("fireflies")) as { apiKey?: string } | null;
    if (s?.apiKey) firefliesApiKey = s.apiKey;
  }
  if (dl.startsWith("kaltura://") && (!kalturaPartnerId || !kalturaAdminSecret)) {
    const s = (await getSharedCredential("kaltura")) as { partnerId?: string; adminSecret?: string; apiKey?: string } | null;
    if (s) { kalturaPartnerId ||= s.partnerId; kalturaAdminSecret ||= s.adminSecret || s.apiKey; }
  }

  if (!refreshToken || !clientId || !clientSecret || !body.title || !body.downloadUrl) {
    return NextResponse.json(
      { error: "refreshToken, clientId, clientSecret, title, and downloadUrl are required" },
      { status: 400 },
    );
  }

  const { title, description = "", tags = [], downloadUrl, privacyStatus = "unlisted", recordedAt } = body;

  const stream = new ReadableStream({
    async start(controller) {
      let tmpPath: string | null = null;

      const send = (type: string, data: Record<string, unknown>) => {
        try { controller.enqueue(sseEvent(type, data)); } catch { /* client disconnected */ }
      };

      try {
        // Step 1: Refresh YouTube token
        send("progress", { phase: "Refreshing YouTube token…" });
        serverLog("info", "ext:youtube-upload", "token-refresh-start", { title });
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId!,
            client_secret: clientSecret!,
            refresh_token: refreshToken!,
            grant_type: "refresh_token",
          }),
        });
        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          throw new Error(`YouTube token refresh failed (${tokenRes.status}): ${text}`);
        }
        const { access_token: ytAccessToken } = await tokenRes.json();
        serverLog("info", "ext:youtube-upload", "token-refresh-ok", { title });

        // Step 2: Download source to temp file
        // Stage on the FUSE bucket, not /tmp. /tmp is RAM on Cloud Run,
        // and these recordings run to several GB — a 4.86 GB download
        // OOM-killed an 8 GiB instance on 2026-09-24. gcsfuse streams
        // writes through a 32 MB block budget, so the same file costs
        // megabytes of memory instead of gigabytes.
        const staged = await stagedPath("video-upload");
        tmpPath = staged.path;
        serverLog("info", "ext:youtube-upload", "staging", {
          title, onFuse: staged.onFuse, path: tmpPath,
        });
        send("progress", { phase: "Downloading source video…" });
        serverLog("info", "ext:youtube-upload", "download-start", { title, downloadUrl });

        // ADR-079 follow-up — one downloader for every publish path.
        //
        // This route used to carry its own copy of the scheme dispatch
        // and seven downloaders. On 2026-09-23 the Drive fix landed on
        // lib/sourceDownload and this route never called it, so two
        // retries uploaded 80 KB of Drive viewer HTML to YouTube and
        // both videos were removed. Duplication is why the fix missed.
        await downloadFromSource(downloadUrl, {
          zoomAccountId, zoomClientId, zoomClientSecret,
          firefliesApiKey,
          ytCookies: body.ytCookies,
          kalturaPartnerId, kalturaAdminSecret,
        }, tmpPath, (p) => {
          // A 4.86 GB pull sits on one phase string for nearly three
          // minutes. Without bytes moving on screen it is
          // indistinguishable from a hang — which is precisely how the
          // 2026-09-24 OOM looked to the operator before it died.
          send("progress", { phase: `Downloading source video… ${formatProgress(p)}` });
        });

        // Size is the cheapest possible sanity check, and the one that
        // would have caught the HTML uploads immediately: 80 KB is not a
        // recording. Logged unconditionally so a bad publish is legible
        // in Cloud Logging without reconstructing it from the catalog.
        const downloadedBytes = (await fs.stat(tmpPath)).size;
        serverLog("info", "ext:youtube-upload", "download-bytes", { title, downloadedBytes, downloadUrl });
        send("progress", { phase: `Downloaded ${formatBytes(downloadedBytes)} — preparing upload…` });
        if (downloadedBytes < MIN_PLAUSIBLE_MEDIA_BYTES) {
          throw new Error(
            `Source download produced only ${downloadedBytes} bytes — too small to be a recording. ` +
            `Refusing to upload. Source: ${downloadUrl.slice(0, 80)}`,
          );
        }
        serverLog("info", "ext:youtube-upload", "download-ok", { title });

        // Step 2b: Trim if requested
        if (body.trimStartSeconds && body.trimStartSeconds > 0) {
          send("progress", { phase: `Trimming first ${body.trimStartSeconds}s…` });
          serverLog("info", "ext:youtube-upload", "trim-start", { title, trimStartSeconds: body.trimStartSeconds });
          // Same reasoning as the download: the trimmed copy is the
          // same order of magnitude, and for a moment BOTH exist.
          const trimmedPath = (await stagedPath("video-trimmed")).path;
          await new Promise<void>((resolve, reject) => {
            execFile(
              "ffmpeg",
              ["-ss", String(body.trimStartSeconds), "-i", tmpPath!, "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-y", trimmedPath],
              { timeout: 300000 },
              (err, _stdout, stderr) => {
                if (err) reject(new Error(`ffmpeg trim failed: ${(stderr || err.message).slice(0, 300)}`));
                else resolve();
              },
            );
          });
          await discardStaged(tmpPath);
          tmpPath = trimmedPath;
          serverLog("info", "ext:youtube-upload", "trim-ok", { title });
        }

        // Step 3: Initiate resumable upload
        send("progress", { phase: "Initiating YouTube upload…" });
        serverLog("info", "ext:youtube-upload", "upload-init-start", { title });
        const videoSize = (await fs.stat(tmpPath)).size;
        const metadata: Record<string, unknown> = {
          snippet: { title, description, tags },
          status: { privacyStatus, selfDeclaredMadeForKids: false },
        };
        const parts = ["snippet", "status"];
        if (recordedAt) { metadata.recordingDetails = { recordingDate: recordedAt }; parts.push("recordingDetails"); }

        const initRes = await fetch(
          `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts.join(",")}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ytAccessToken}`,
              "Content-Type": "application/json",
              "X-Upload-Content-Length": videoSize.toString(),
              "X-Upload-Content-Type": "video/mp4",
            },
            body: JSON.stringify(metadata),
          },
        );
        if (!initRes.ok) {
          const text = await initRes.text();
          throw new Error(`YouTube upload init failed (${initRes.status}): ${text}`);
        }
        const uploadUrl = initRes.headers.get("Location");
        if (!uploadUrl) throw new Error("YouTube did not return an upload URL");
        serverLog("info", "ext:youtube-upload", "upload-init-ok", { title, videoSize });

        // Step 4: Stream video to YouTube
        send("progress", { phase: "Uploading to YouTube…" });
        serverLog("info", "ext:youtube-upload", "upload-stream-start", { title, videoSize });
        // Same again for the push. The upload half is the slower of the
        // two for a large file and was equally silent.
        let sentBytes = 0;
        let lastUploadReport = 0;
        const fileStream = createReadStream(tmpPath);
        fileStream.on("data", (chunk) => {
          sentBytes += chunk.length;
          const now = Date.now();
          if (now - lastUploadReport >= 2000) {
            lastUploadReport = now;
            send("progress", {
              phase: `Uploading to YouTube… ${formatProgress({ bytes: sentBytes, total: videoSize })}`,
            });
          }
        });
        const nodeReadable = Readable.toWeb(fileStream) as ReadableStream;
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": videoSize.toString() },
          body: nodeReadable,
          // @ts-expect-error duplex required for streaming body in Node fetch
          duplex: "half",
        });
        if (!uploadRes.ok) {
          const text = await uploadRes.text();
          throw new Error(`YouTube upload failed (${uploadRes.status}): ${text}`);
        }

        const result = await uploadRes.json();
        const videoId = result.id as string;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        serverLog("info", "ext:youtube-upload", "published", { title, videoId, videoUrl });

        // Count the 1,600 units here — the one place every publish path
        // reaches. Until 2026-09-24 only BackfillPanel's orchestrator
        // incremented, so card publishes, side-publishes and retries
        // spent quota invisibly. Non-fatal: the upload succeeded, and
        // failing the response over bookkeeping would be worse than a
        // miscount.
        try {
          const q = await recordUpload();
          send("complete", { videoId, videoUrl, uploadsToday: q.uploads_today, uploadsRemaining: q.remaining });
        } catch (qerr) {
          serverLog("warn", "ext:youtube-upload", "quota-count-failed", {
            videoId, error: qerr instanceof Error ? qerr.message : String(qerr),
          });
          send("complete", { videoId, videoUrl });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        serverLog("error", "ext:youtube-upload", "failed", { title, error: message });
        send("error", { message });
      } finally {
        await discardStaged(tmpPath);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// Cloud Run: --timeout=3600 in cloudbuild.yaml.
export const maxDuration = 3600;

// withRequestLogging wraps in NextResponse which isn't compatible with the plain
// Response(stream) needed for SSE — log manually inside the handler instead.
export async function POST(req: NextRequest) {
  const rid = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  serverLog("info", "api:youtube/upload", "req", { method: "POST", path: new URL(req.url).pathname, rid });
  const res = await handler(req);
  const headers = new Headers(res.headers);
  headers.set("x-request-id", rid);
  return new Response(res.body, { status: res.status, headers });
}
