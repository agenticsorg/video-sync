"use client";

/**
 * ADR-078 — folder mode for the Drive import tab.
 *
 * Pick a registered folder, set a date window, Fetch. Result rows
 * preview-and-select the way the Kaltura and Zoom panels do, so Drive
 * stops being the one source where finding the thing is the operator's
 * problem.
 *
 * Listing is metadata-only (§3). Bytes stream to the FUSE bucket only
 * for files the operator actually imports, through ADR-071's existing
 * /api/drive/ingest — so pointing at a 500-file archive costs a few
 * API calls, not half a terabyte of GCS.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { WasmVideoRecord } from "../lib/wasm";
import { videoStore } from "../lib/store";
import { getDriveSources, listDriveFolder } from "../lib/driveSourcesClient";
import { importStateKey, type DriveSourceFile, type DriveSourceFolder } from "../lib/driveSources";
import { saveSourceCheck } from "../lib/importStateClient";
import HelpTip from "./HelpTip";

interface Props {
  onImported: (imported?: { ids: string[] }) => void;
  onEvent: (event: string, fields?: { video_id?: string }) => void;
}

function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Strip the file extension for the record title — Drive names are
 *  whatever the uploader's recorder produced, extension and all. */
function titleFromName(name: string): string {
  return name.replace(/\.[a-zA-Z0-9]{2,5}$/, "");
}

export default function DriveFolderImport({ onImported, onEvent }: Props) {
  const [folders, setFolders] = useState<DriveSourceFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [files, setFiles] = useState<DriveSourceFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"idle" | "fetching" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDriveSources().then(snap => {
      if (cancelled) return;
      const enabled = snap.folders.filter(f => f.enabled);
      setFolders(enabled);
      if (enabled.length > 0) setFolderId(prev => prev || enabled[0].folder_id);
    });
    return () => { cancelled = true; };
  }, []);

  const folder = useMemo(
    () => folders.find(f => f.folder_id === folderId) ?? null,
    [folders, folderId],
  );

  /** Rows the operator can act on — indexed ones are shown but never
   *  selectable, so a re-list after a partial import reads as "here is
   *  what's left" rather than offering duplicates. */
  const importable = useMemo(
    () => (files ?? []).filter(f => !f.already_indexed),
    [files],
  );

  const fetchFiles = useCallback(async () => {
    if (!folder) return;
    setStatus("fetching");
    setError(null);
    setNote(null);
    setFiles(null);
    setSelected(new Set());
    try {
      const res = await listDriveFolder(folder.folder_id, dateFrom || undefined, dateTo || undefined);
      setFiles(res.files);
      setTruncated(res.truncated);
      // ADR-078 §7 — this folder now has a "last checked" range, so an
      // empty day on the Overview reads as "checked" rather than
      // ambiguous silence.
      if (dateFrom && dateTo) {
        void saveSourceCheck(importStateKey(folder), dateFrom, dateTo);
      }
      const already = res.files.length - res.files.filter(f => !f.already_indexed).length;
      if (res.files.length === 0) {
        setNote("No videos in that folder for this window.");
      } else if (already > 0) {
        setNote(`${already} of ${res.files.length} already in the catalog.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }, [folder, dateFrom, dateTo]);

  function toggle(fileId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev =>
      prev.size === importable.length ? new Set() : new Set(importable.map(f => f.file_id)),
    );
  }

  async function importSelected() {
    if (!folder || selected.size === 0) return;
    setStatus("importing");
    setError(null);
    const ids: string[] = [];
    try {
      for (const file of importable) {
        if (!selected.has(file.file_id)) continue;

        const extra: Record<string, string> = {
          drive_file_id: file.file_id,
          drive_mime_type: file.mime_type,
          drive_web_view_link: file.web_view_link ?? `https://drive.google.com/file/d/${file.file_id}/view`,
          // ADR-078 §1 — which registry entry this came from, so a bad
          // folder→series guess is identifiable by one key rather than
          // by inference.
          drive_source_folder: folder.id,
        };
        if (file.owner_email) extra.drive_original_owner_email = file.owner_email;
        if (file.size_bytes != null) extra.drive_size_bytes = String(file.size_bytes);
        // ADR-078 §4 — content hash, so a re-upload under a fresh Drive
        // id is detectable on a later listing.
        if (file.md5_checksum) extra.drive_md5 = file.md5_checksum;

        const cmd = {
          source_id: `drive-${file.file_id}`,
          source_platform: "GoogleDrive",
          title: titleFromName(file.name),
          description: undefined,
          duration_seconds: Math.max(0, Math.round(file.duration_seconds ?? 0)),
          participants: [],
          download_url: file.web_view_link ?? `https://drive.google.com/file/d/${file.file_id}/view`,
          thumbnail_url: file.thumbnail_link ?? undefined,
          // The folder's series is a hint (ADR-078 §1): it rides as a
          // tag that title alignment can act on, and never overwrites
          // a title the matchers resolve from stronger evidence.
          tags: folder.series_name
            ? ["google-drive-import", `series:${folder.series_name}`]
            : ["google-drive-import"],
          recorded_at: file.created_time ?? file.modified_time ?? undefined,
          metadata_extra: extra,
        };

        const record = new WasmVideoRecord(JSON.stringify(cmd));
        videoStore.add(record);
        const recordId = record.id();
        ids.push(recordId);

        // Bytes copy here, not at listing (§3). Fire-and-forget; the
        // card polls /api/drive/status for progress.
        void fetch("/api/drive/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: file.file_id, record_id: recordId, auth: "service_account" }),
        }).catch(() => { /* status endpoint owns the progress story */ });

        onEvent(
          `VideoIndexed: "${cmd.title}" (Drive folder "${folder.label}" — ingest queued)`,
          { video_id: recordId },
        );
      }

      onImported({ ids });
      setNote(`Imported ${ids.length} file${ids.length === 1 ? "" : "s"}; byte copy queued.`);
      setSelected(new Set());
      // Re-mark the imported rows without a round trip.
      setFiles(prev =>
        (prev ?? []).map(f => (ids.length && selected.has(f.file_id) ? { ...f, already_indexed: true } : f)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }

  if (folders.length === 0) {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "8px 0" }}>
        No Drive source folders registered yet. An Admin adds them in{" "}
        <strong>Config → Drive source folders</strong>; the folder has to be shared with this
        deployment&apos;s service account first.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem" }}>
          Folder
          <select
            value={folderId}
            onChange={e => { setFolderId(e.target.value); setFiles(null); setSelected(new Set()); }}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem", minWidth: 200 }}
          >
            {folders.map(f => (
              <option key={f.folder_id} value={f.folder_id}>
                {f.label}{f.series_name ? ` · ${f.series_name}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem" }}>
          From
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem" }}>
          To
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: "4px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }} />
        </label>
        <button className="btn btn-sm btn-primary" onClick={fetchFiles} disabled={status !== "idle" || !folder}>
          {status === "fetching" ? "Fetching…" : "🔄 Fetch"}
        </button>
        <HelpTip>
          Lists videos in the selected folder. Metadata only — the file itself is copied when you
          import it. Subfolders are not scanned (ADR-078).
        </HelpTip>
      </div>

      {error && (
        <div style={{ fontSize: "0.8rem", color: "var(--red)", marginBottom: 8 }}>{error}</div>
      )}
      {note && !error && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 8 }}>{note}</div>
      )}
      {truncated && (
        <div style={{ fontSize: "0.78rem", color: "#fbbf24", marginBottom: 8 }}>
          Showing the first 500 files. Narrow the date window to see the rest.
        </div>
      )}

      {files && files.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: "0.8rem" }}>
            <button className="btn btn-sm" onClick={toggleAll} disabled={importable.length === 0}>
              {selected.size === importable.length && importable.length > 0 ? "Clear" : "Select all"}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={importSelected}
              disabled={selected.size === 0 || status !== "idle"}
            >
              {status === "importing" ? "Importing…" : `Import ${selected.size} selected`}
            </button>
            <span style={{ color: "var(--text-muted)" }}>
              {files.length} file{files.length === 1 ? "" : "s"} · {importable.length} importable
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {files.map(f => {
              const disabled = f.already_indexed;
              return (
                <label
                  key={f.file_id}
                  style={{
                    display: "flex", gap: 8, alignItems: "center", padding: "6px 8px",
                    border: "1px solid var(--border)", borderRadius: 6,
                    background: "var(--bg-card, transparent)",
                    opacity: disabled ? 0.5 : 1,
                    cursor: disabled ? "default" : "pointer",
                    fontSize: "0.82rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.file_id)}
                    onChange={() => toggle(f.file_id)}
                    disabled={disabled}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {titleFromName(f.name)}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                    {f.created_time ? f.created_time.slice(0, 10) : "—"} · {fmtDuration(f.duration_seconds)} · {fmtSize(f.size_bytes)}
                  </span>
                  {f.already_indexed && (
                    <span title="Already in the catalog" style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                      indexed
                    </span>
                  )}
                  {f.duplicate_of && !f.already_indexed && (
                    <span
                      title={`Identical bytes to record ${f.duplicate_of} — probably a re-upload under a new Drive id. Import anyway if you mean to.`}
                      style={{ fontSize: "0.7rem", color: "#fbbf24" }}
                    >
                      dup?
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
