/**
 * GET /api/youtube/video-info?videoId=VIDEO_ID
 * Fetches public metadata for a YouTube video via the Data API v3 videos.list.
 * No user OAuth required for public videos — uses server-side API key.
 * ADR-027: YouTube Source Ingestion
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging } from "../../../../lib/serverLogger";
import { getSharedCredential } from "../../../../lib/sharedCredentials";

export interface YouTubeVideoInfo {
  videoId: string;
  title: string;
  description: string | null;
  channelTitle: string;
  publishedAt: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  privacyStatus: string;
  liveBroadcastContent: string;
  /** From liveStreamingDetails — null on an ordinary upload.
   *  actualStartTime is when the broadcast BEGAN, which is the only
   *  timestamp that lines up with the source recording. */
  actualStartTime: string | null;
  scheduledStartTime: string | null;
  actualEndTime: string | null;
}

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

async function handler(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Valid 11-character videoId required" }, { status: 400 });
  }

  // ADR-054 fallback chain — per-operator query-param key wins, then
  // the org-wide shared default (Secret Manager), then the legacy
  // env-var path. The shared default is what Admin sets via
  // Connections → YouTube → "Set as shared default".
  const sharedYouTube = await getSharedCredential("youtube").catch(() => null);
  const apiKey =
    req.nextUrl.searchParams.get("apiKey") ||
    (sharedYouTube as { googleApiKey?: string } | null)?.googleApiKey ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "No Google API key configured. Ask an Admin to set the shared default in Connections → YouTube → Set as shared default, or add a personal override in Connections → YouTube → Override locally → Google API Key." },
      { status: 500 },
    );
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  // liveStreamingDetails carries actualStartTime — when the broadcast
  // actually began. snippet.publishedAt is when the VOD was published,
  // which for a livestream is after it ends and can be most of a day
  // later. ADR-048 §Addendum: sibling matching is a date-proximity
  // gate, so the wrong timestamp means the pair is never considered.
  url.searchParams.set("part", "snippet,contentDetails,status,liveStreamingDetails");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    return NextResponse.json({ error: `YouTube API request failed: ${String(err)}` }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `YouTube API error (${res.status}): ${text.slice(0, 300)}` },
      { status: 502 },
    );
  }

  const data = await res.json();
  const item = data.items?.[0];
  if (!item) {
    return NextResponse.json(
      { error: "Video not found. It may be private, deleted, or the ID is incorrect." },
      { status: 404 },
    );
  }

  const snippet = item.snippet ?? {};
  const live = (item.liveStreamingDetails ?? {}) as {
    actualStartTime?: string; scheduledStartTime?: string; actualEndTime?: string;
  };
  const contentDetails = item.contentDetails ?? {};
  const status = item.status ?? {};

  const thumbnails = snippet.thumbnails ?? {};
  const thumbnailUrl: string | null =
    thumbnails.maxres?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;

  const info: YouTubeVideoInfo = {
    videoId,
    title: snippet.title ?? "",
    description: snippet.description || null,
    channelTitle: snippet.channelTitle ?? "",
    publishedAt: snippet.publishedAt ?? new Date().toISOString(),
    durationSeconds: parseDuration(contentDetails.duration ?? ""),
    thumbnailUrl,
    privacyStatus: status.privacyStatus ?? "unknown",
    liveBroadcastContent: snippet.liveBroadcastContent ?? "none",
    // Present only on a livestream. Absent on an ordinary upload,
    // which is how callers tell the two apart.
    actualStartTime: live.actualStartTime ?? null,
    scheduledStartTime: live.scheduledStartTime ?? null,
    actualEndTime: live.actualEndTime ?? null,
  };

  return NextResponse.json(info);
}

export const GET = withRequestLogging("api:youtube/video-info", handler);
