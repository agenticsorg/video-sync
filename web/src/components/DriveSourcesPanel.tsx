"use client";

/**
 * ADR-078 §8 — Config panel for the Drive source-folder registry.
 *
 * Add / rename / enable / remove folders. Two server-side refusals
 * surface here verbatim rather than being pre-empted in the client,
 * because both depend on state the browser doesn't hold:
 *
 *   §6 — the folder must be visible to the runtime service account.
 *        The save fails with the address to share it with.
 *   §5 — a folder that is already a publish destination for a series
 *        is refused outright.
 */

import { useEffect, useState } from "react";
import {
  getDriveSources,
  saveDriveSources,
  refreshDriveSources,
} from "../lib/driveSourcesClient";
import { detectFolderId, type DriveSourceFolder } from "../lib/driveSources";
import { getSeriesRegistry } from "../lib/seriesRegistryClient";
import HelpTip from "./HelpTip";

export default function DriveSourcesPanel() {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<DriveSourceFolder[]>([]);
  const [serviceAccount, setServiceAccount] = useState<string | null>(null);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSeries, setNewSeries] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getDriveSources().then(snap => {
      if (cancelled) return;
      setFolders(snap.folders);
      setServiceAccount(snap.service_account ?? null);
    });
    getSeriesRegistry().then(entries => {
      if (!cancelled) setSeriesNames(entries.map(e => e.series_name));
    }).catch(() => { /* series linking is optional */ });
    return () => { cancelled = true; };
  }, [open]);

  async function persist(next: DriveSourceFolder[], successMessage: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await saveDriveSources(next);
      setFolders(result);
      setSaved(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A refused save leaves the server authoritative — re-read so the
      // panel never shows a folder that wasn't actually stored.
      refreshDriveSources();
      const snap = await getDriveSources();
      setFolders(snap.folders);
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    const folderId = detectFolderId(newUrl);
    if (!folderId) {
      setError("Paste a Drive folder link (drive.google.com/drive/folders/…) or a raw folder id.");
      return;
    }
    const label = newLabel.trim() || `Folder ${folders.length + 1}`;
    if (folders.some(f => f.folder_id === folderId)) {
      setError(`That folder is already registered as "${folders.find(f => f.folder_id === folderId)!.label}".`);
      return;
    }
    const next: DriveSourceFolder[] = [
      ...folders,
      {
        id: crypto.randomUUID(),
        folder_id: folderId,
        label,
        enabled: true,
        ...(newSeries ? { series_name: newSeries } : {}),
        added_by: "",
        added_at: new Date().toISOString(),
      },
    ];
    await persist(next, `Added "${label}".`);
    setNewUrl("");
    setNewLabel("");
    setNewSeries("");
  }

  function patch(folderId: string, changes: Partial<DriveSourceFolder>) {
    setFolders(prev => prev.map(f => (f.folder_id === folderId ? { ...f, ...changes } : f)));
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
        onClick={() => setOpen(v => !v)}
      >
        <h2 style={{ fontSize: "1rem", margin: 0 }}>📂 Drive source folders</h2>
        <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
          {open ? "▾" : "▸"} {folders.length} registered
        </span>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
            Folders listed here can be browsed from <strong>Import → Drive</strong> over a date window,
            the way Zoom and Kaltura are. Listing reads metadata only; a file&apos;s bytes are copied when
            you import it.{" "}
            {serviceAccount && (
              <>Share each folder with <code>{serviceAccount}</code> (Viewer) before adding it.</>
            )}
            <HelpTip>
              Subfolders are not scanned — register each one, or wait for recursion
              (ADR-078 Deferred #1). A folder that is already a publish destination for a
              series is refused.
            </HelpTip>
          </div>

          {/* Add */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem", flex: 2, minWidth: 260 }}>
              Folder link or id
              <input
                type="text"
                value={newUrl}
                onChange={e => { setNewUrl(e.target.value); setError(null); }}
                placeholder="https://drive.google.com/drive/folders/…"
                style={{ padding: "5px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem", flex: 1, minWidth: 150 }}>
              Label
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="Toronto chapter uploads"
                style={{ padding: "5px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem", minWidth: 160 }}>
              Series (optional)
              <select
                value={newSeries}
                onChange={e => setNewSeries(e.target.value)}
                title="A hint for title alignment, not an assignment — the matchers can still resolve a different series from the record itself."
                style={{ padding: "5px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: "0.8rem" }}
              >
                <option value="">— none —</option>
                {seriesNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn btn-sm btn-primary" onClick={addFolder} disabled={busy}>
              {busy ? "Checking…" : "Add folder"}
            </button>
          </div>

          {error && (
            <div style={{ fontSize: "0.8rem", color: "var(--red)", marginBottom: 10, whiteSpace: "pre-wrap" }}>
              {error}
            </div>
          )}
          {saved && !error && (
            <div style={{ fontSize: "0.8rem", color: "var(--green)", marginBottom: 10 }}>{saved}</div>
          )}

          {/* List */}
          {folders.length === 0 ? (
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>None registered yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {folders.map(f => (
                <div
                  key={f.folder_id}
                  style={{
                    display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                    padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6,
                    fontSize: "0.82rem", opacity: f.enabled ? 1 : 0.55,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={e => patch(f.folder_id, { enabled: e.target.checked })}
                    title="Enabled folders appear in the Import → Drive picker"
                  />
                  <input
                    type="text"
                    value={f.label}
                    onChange={e => patch(f.folder_id, { label: e.target.value })}
                    style={{ flex: 1, minWidth: 140, padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.8rem" }}
                  />
                  <select
                    value={f.series_name ?? ""}
                    onChange={e => patch(f.folder_id, { series_name: e.target.value || undefined })}
                    style={{ padding: "3px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: "0.78rem" }}
                  >
                    <option value="">— no series —</option>
                    {seriesNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <code style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{f.folder_id.slice(0, 12)}…</code>
                  <a
                    href={`https://drive.google.com/drive/folders/${f.folder_id}`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: "0.72rem" }}
                  >
                    open
                  </a>
                  <button
                    className="btn btn-sm"
                    onClick={() => persist(folders.filter(x => x.folder_id !== f.folder_id), `Removed "${f.label}".`)}
                    disabled={busy}
                    title="Remove from the registry. Records already imported from it are untouched."
                    style={{ fontSize: "0.72rem" }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => persist(folders, "Saved.")}
                  disabled={busy}
                  style={{ marginTop: 4 }}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
