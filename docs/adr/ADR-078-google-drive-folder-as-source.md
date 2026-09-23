# ADR-078: Google Drive Folder as a Source

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-09-22 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Extends** | ADR-071 (Drive video ingest — per-file) |
| **Related** | ADR-005 (source integration — operator-triggered by design), ADR-031 (server-side persistence pattern), ADR-035 (persistence topology), ADR-039 (Drive artifact storage / runtime SA), ADR-042 (shared credential vault), ADR-047 (automated catch-up), ADR-058 (source discovery and pre-import awareness), ADR-065 (contributor role), ADR-075 (series-driven destinations — Drive folder as a *destination*) |

---

## Context

ADR-071 shipped Drive ingest and it works: `SourcePlatform::GoogleDrive`, `/api/drive/metadata`, `/api/drive/ingest`, `/api/drive/status`, `DriveImport`, `DrivePendingPullPanel`. A contributor pastes a public share link; a Publisher pulls a private file with the runtime service account; the bytes stream to the FUSE bucket and the record is durable against the share being revoked.

Every one of those paths takes **one file id**. The operator has to already know the identity of the thing they want. That is the gap.

Compare the other four sources. Zoom, Fireflies, YouTube and Kaltura are all *queryable*: hand them a date window and they answer with a list of what exists, which the operator previews and selects from (`POST /api/kaltura/list` is the canonical shape). Drive is the only source where discovery is the operator's problem — they open Drive in another tab, find the file, copy its link, paste it back. For a team that drops recordings into a shared folder as a matter of routine, that is per-file manual labour for something the folder already knows.

Two further pressures:

- **ADR-058** catalogued this exact class of problem — "empty because we checked" vs "empty because we never looked" — and shipped per-source `last_checked` bookkeeping for the four queryable sources. Drive can't participate, because there is nothing to check.
- **ADR-075** already made a Drive folder a first-class publish *destination* (`{ platform: "GoogleDrive", folder_id, share_scope }` in the series registry). Folder-as-source is the exact mirror of something the codebase already models — and that symmetry carries a hazard that has to be named before it bites (§5).

### What "as a source" has to mean here

ADR-005 established that source integration is **operator-triggered by design**, and ADR-058 explored automatic polling across six options without resolving it. This ADR does not resolve it either. It makes a Drive folder queryable on the same terms as every other source, and leaves unattended scanning as a documented follow-up (§9) rather than smuggling it in.

---

## Decision

### 1. A standalone folder registry

New `data/drive-sources.json`, following the ADR-031 whole-list-replace pattern (`data/backfill-profiles.json` is the closest precedent), behind `GET`/`POST /api/drive/sources`. Admin-only writes, matching `/api/series-registry`.

```ts
interface DriveSourceFolder {
  /** Our uuid, stable across folder renames. */
  id: string;
  /** Drive folder id. Accepts a full folder URL on input; stored bare. */
  folder_id: string;
  /** Operator-facing name. Also the import-state source key (§7). */
  label: string;
  /** Off excludes the folder from listing and from any future sweep. */
  enabled: boolean;
  /** Optional bridge to the series registry, when the folder holds
   *  one show. A hint, not an authority — see below. */
  series_name?: string;
  added_by: string;
  added_at: string;
}
```

**Why standalone rather than a field on the series registry.** Not every source folder is a series. The motivating cases include a pre-video-sync archive dump and a chapter's catch-all upload folder, neither of which has a show name, a schedule, or a destination. Hanging `source_folder_id` off a series entry would force us to invent a fake series for those, which then pollutes title alignment (ADR-055/056) and destination resolution (ADR-075) with entries that exist only to hold a folder id. The optional `series_name` gives folders that *are* a show the link, without making it compulsory for the ones that aren't.

**`series_name` is a hint, not an assignment.** A folder saying "this is Friday Hackerspace" is good evidence, and it is often better evidence than a filename — Drive filenames are whatever the uploader's screen recorder produced. But ADR-055/056's title alignment already resolves a series from the record's own content, and a folder that is *mostly* one show will eventually contain something that isn't. So the folder's series feeds the existing matchers as an input; it does not bypass them.

Concretely, a record ingested from a folder with `series_name` set:

- is **renamed per that series** — the series' title convention applies, exactly as it would for a record the matchers had resolved themselves, so folder-sourced records arrive with the same titles as their siblings from other platforms;
- carries `metadata_extra.drive_source_folder = "<registry entry id>"`, so where the series attribution came from is auditable after the fact;
- can still be overridden by a stronger signal — a paired canonical title (ADR-055's `paired_canonical` source) outranks it, as it already outranks a registry pattern match.

Recording the provenance is the part that makes this safe to get wrong: if a folder's series turns out to be a bad guess, the affected records are identifiable by that one `metadata_extra` key rather than by inference.

### 2. Listing — `POST /api/drive/sources/list`

Deliberately the same contract shape as `/api/kaltura/list`, so `DriveImport` can reuse the preview-and-select UI the other source panels already have.

Request `{ folder_id, from?, to? }` → response `{ files: DriveSourceFile[], total, truncated: boolean }`.

The Drive query, via the `drive.readonly` client (§6):

```
q: "'<folder_id>' in parents
    and mimeType contains 'video/'
    and trashed = false
    and createdTime >= '<from>' and createdTime <= '<to>'"
fields: "nextPageToken, files(id,name,mimeType,size,createdTime,modifiedTime,
         videoMediaMetadata(durationMillis),thumbnailLink,webViewLink,
         owners(emailAddress),md5Checksum)"
orderBy: "createdTime desc"
pageSize: 100
supportsAllDrives: true
includeItemsFromAllDrives: true
```

`mimeType contains 'video/'` does at the query layer what ADR-071 §1's mimeType guard does per-file — Docs, Sheets, images and PDFs never enter the result set, so the operator never sees a row that would fail on import.

**One folder, no recursion.** A listing covers the named folder's immediate children and nothing below it. Drive has no recursive query — each subfolder level is another `files.list` round trip — so recursion is not a flag we can set but a crawl we would have to write, bound, and reason about. It is deferred (§Deferred #1); a `2026/09/` tree is registered as several folders, or waits.

Within the one folder, results page at `pageSize: 100` via `nextPageToken` up to a **total cap of 500 files**, returning `truncated: true` when it bites. The cap exists so a pathological folder can't turn one Fetch into a long sequence of API calls; the flag makes the limit visible rather than silently short-changing the operator, who can narrow the date window to see the rest.

### 3. Listing is metadata-only; bytes copy on import

A list call reads metadata and nothing else. Bytes stream to `gs://…/videos/<record-id>.<ext>` only when the operator imports a specific file, through the existing `POST /api/drive/ingest` — unchanged from ADR-071 §3.

This is the load-bearing choice for cost. Pointing the app at a 500-file archive costs a handful of `files.list` calls; it does not pull half a terabyte into GCS on the strength of someone pasting a folder id. It also leaves ADR-071's durability guarantee exactly where that ADR put it — at import, for records we have actually decided to keep — rather than weakening it (reference-only records that break when a share is revoked) or over-applying it (copying an archive nobody has triaged).

The consequence to accept: a file listed today and imported next week could have been deleted from Drive in between. The import fails with a legible 404 rather than silently producing an empty record.

### 4. Dedupe against the catalog

Two mechanisms, at different strengths.

**By file id — authoritative, drives the UI.** `source_id` is `drive-<file-id>` (ADR-071 §3). Each listed row is marked `already_indexed: true` when a catalog record carries that `source_platform` + `source_id` — the same check `youtubeIngest.ts:150` makes for YouTube rows. Indexed rows render greyed and are excluded from select-all, so re-listing a folder after a partial import shows exactly what is left.

**By content hash — advisory, surfaced not enforced.** This ADR answers ADR-071's third open question: yes, record `md5Checksum`. It lands in `metadata_extra.drive_md5` at import. A file re-uploaded to Drive under a fresh id — which happens when someone re-shares a recording rather than moving it — is a *different* `file_id` and so passes the id check, but its hash matches bytes we already hold. The list route flags those rows `duplicate_of: "<record-id>"`.

Flagged, not blocked, and never auto-merged: identical bytes can legitimately warrant a second record (a re-upload replacing a corrupt original), and ADR-033's sibling-matching is the machinery for deciding that two records are the same thing. This is a hint to the operator, not a decision made for them.

### 5. Breaking the source ↔ destination feedback loop

A folder registered as a source may also be an ADR-075 `GoogleDrive` **destination**. If it is, it contains files this app put there — and listing it would offer to ingest, as a new source record, the video we published from an existing record. A duplicate of ourselves, with reversed provenance.

This is not hypothetical: a folder that collects a show's output is exactly the kind of folder someone would also point the importer at. Two guards:

1. **At list time** — exclude any file whose Drive id appears in some catalog record's `locations[]` as a `GoogleDrive` Destination. Authoritative and automatic; the publish path already records that location.
2. **At registration time** — if the folder id matches any `destinations[].folder_id` in the series registry, **refuse the registration**. Not a warning with a confirm: a folder that is both where we publish and where we look for new work is a configuration we have no use case for, and the confirm dialog would exist only to let someone click past a question they had no basis to answer.

Guard 1 still holds the line at list time, as defence in depth — a folder can become a destination *after* it was registered as a source, and guard 2 cannot see the future. If a legitimate both-ways folder ever turns up (say, one that receives our output *and* collects externally-contributed recordings), that is the moment to design for it deliberately, with the two roles distinguished by something better than "the operator confirmed once".

### 6. Access: the runtime service account must be able to see the folder

The app holds two Drive clients with different scopes, and the difference matters here:

| Client | Scope | Can it list an arbitrary folder? |
|---|---|---|
| `lib/drive.ts` `getDrive()` (ADR-039 artifact writes) | `drive.file` | **No** — `drive.file` grants access only to files the app itself created |
| ADR-071's ingest/metadata clients | `drive.readonly` | Yes, for anything the SA can already see |

Folder listing therefore uses the `drive.readonly` client, not `getDrive()`. But `drive.readonly` is not a skeleton key: it grants read over what the service account's own identity can reach. The SA must be a member of the Shared Drive, or the folder must be shared with it directly.

That prerequisite is an operational step someone will forget, so it gets a first-class failure path rather than a stack trace. **Registering a folder runs a probe** — `files.get` on the folder id with `supportsAllDrives=true` — and on `403`/`404` the UI says:

> Can't see that folder. Share it with `<runtime service-account address>` as a Viewer, then retry.

with the actual address filled in from the running service's identity. Registration is refused until the probe passes, so a folder in the registry is always one we can actually read.

### 7. Import-state integration (ADR-058)

Each enabled folder reports as its own source key in `data/import-state.json`, namespaced `GoogleDrive:<label>`. A successful list calls `saveSourceCheck(key, from, to)` exactly as the other panels do, so the Overview's "Last checked" banner covers Drive folders alongside Zoom / Fireflies / YouTube / Kaltura and an empty day in a Drive folder becomes "checked 2h ago" rather than ambiguous silence.

This requires one small change outside Drive: `SOURCES` in `SyncStatusPanel.tsx` is currently a hardcoded four-element tuple, and must become dynamic — the union of the four fixed platforms and the registered folder keys.

### 8. UI surfaces

- **`/import` → Drive tab** — gains a folder mode above the existing paste box: pick a registered folder, set a date window, Fetch. Result rows reuse the preview-and-select component the Kaltura and Zoom panels use, with the `already_indexed` and `duplicate_of` affordances from §4.
- **`/config` → Drive source folders** — a panel beside Series Registry: add / edit / enable / remove, with the §6 probe on save and the §5 destination-collision warning. Admin-only, matching the registry's write gate.
- **Video card provenance** — unchanged. ADR-071 already renders the `GoogleDrive` origin location; a folder-sourced record is the same shape with the same `metadata_extra.drive_web_view_link`.

### 9. Deferred: the catch-up stage

A registered folder is a standing declaration that its contents are wanted, which makes it the natural input to an unattended sweep. That is a follow-up, not part of this ADR:

> A `fetch_sources` stage ahead of `hydrate_transcript` in `runCatchUp`, walking enabled folders over the sweep's window and creating `Discovered` records for unindexed files — behind the bulk-automation kill switch (`/api/admin/automation`) like every other unattended mutation, and reporting per-folder stage events the way the existing stages do.

Two reasons to hold it back. First, it relaxes ADR-005's operator-triggered principle, which deserves an explicit decision rather than arriving as a side effect of a Drive feature. Second, the guards in §4 and §5 should be proven against real folders under an operator's eye before anything runs them unattended — a dedupe bug that creates one duplicate per manual fetch is a nuisance; the same bug on a timer is a mess.

The registry shape in §1 is designed so that stage needs no schema change when it lands: `enabled` already means what it would need it to mean.

---

## Consequences

### Positive

- Drive becomes queryable on the same terms as every other source. The operator stops leaving the app to find out what exists, and the preview-and-select flow is the one they already know from Kaltura and Zoom.
- Registering a folder is a one-time act that keeps paying — every later fetch shows only what is new, because §4 greys out what is already indexed.
- Drive joins ADR-058's "last checked" bookkeeping, closing the one source that could never answer the question that ADR was written for.
- The archive-import case ADR-071 named in its Context ("an archive Drive folder full of pre-video-sync recordings") becomes a date-windowed sweep instead of hundreds of pasted links.
- Metadata-only listing means the feature's cost scales with *attention*, not with folder size.

### Negative

- **A third Drive surface to keep coherent.** Contributor paste (ADR-071 §1), Publisher pull (ADR-071 §1), and now folder listing. They share `/api/drive/ingest` for the byte copy, but the discovery halves are three different shapes. Worth a consolidation pass if a fourth appears.
- **Folder access is an operational prerequisite that will bite.** Sharing a folder with a service account is not an obvious act. §6's probe converts the failure from a confusing empty list into an instruction, but it cannot remove the step.
- **No recursion means a foldered archive is several registrations.** Anyone whose Drive is organised as `2026/09/` has to register each month, or wait for Deferred #1. This is the sharpest limitation of v1 and the most likely thing to be asked for first.
- **The 500-file cap will feel arbitrary to whoever first hits it.** It is a guess. The `truncated` flag makes the limit visible and narrowing the date window works around it, but a genuinely flat folder of thousands of recordings is awkward until the constant is revisited.
- **A listed file can vanish before import.** Metadata-only listing means the catalog's view of a folder is a snapshot, not a lock. Import fails cleanly, but it fails.
- **`drive.readonly` remains broader than "this folder".** Same posture, and same accepted trade-off, as ADR-071 §Negative — Google offers no per-folder read scope. The narrowing is behavioural: the list route only ever queries folder ids present in the registry, and refuses arbitrary folder ids from the client.

### Neutral

- `SourcePlatform::GoogleDrive` already exists; folder-sourced records are indistinguishable from ADR-071's per-file ones once imported. No Rust change, no WASM rebuild, no catalog migration.
- `data/drive-sources.json` is the sixteenth file under `data/`, all on the same FUSE mount with the same last-writer-wins semantics (ADR-035). No new persistence story.

---

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Copy every file at discovery** (uniform ADR-071 §3 durability) | Registering a folder would pull its entire contents into GCS before anyone had triaged a single record. An archive folder is precisely the motivating case and precisely the worst case. Durability is worth paying for on records we have decided to keep, not on everything we can see. |
| **Reference-only records; copy at Approved or first publish** | Cheapest storage, but it moves the copy to the latest possible moment — the one where a revoked share or a deleted original breaks a record an operator has already curated. Discards the guarantee ADR-071 was explicit about wanting. |
| **Folder id on the series registry entry** | Forces every source folder to be a series. Archive dumps and catch-all folders aren't, and inventing series entries for them pollutes title alignment (ADR-055/056) and destination resolution (ADR-075) with rows that exist only to carry a folder id. `series_name` on the standalone registry gets the benefit without the coupling. |
| **Single `DRIVE_SOURCE_FOLDER_ID` env var** | One folder, and changing it is a redeploy. Several teams with several folders is the actual shape of the request. |
| **Automatic polling from the start** | The most literal reading of "treat it as a source", and where this should probably end up — but it relaxes ADR-005's operator-triggered principle and would run §4/§5's untested dedupe guards unattended. §9 sequences it deliberately instead. |
| **Drive `changes.watch` push notifications** | Drive can push change notifications to a webhook, which would beat polling on both latency and quota. It needs a publicly reachable endpoint (Cloud Run is behind IAP — ADR-036/045), channel renewal every ~7 days, and an unauthenticated route carved out of the IAP gate. Real option for the §9 follow-up; far too much new surface to attach to on-demand listing. |
| **Google Picker SDK for folder browsing** | Still deferred, as in ADR-071 §Deferred #4. Picker authenticates as the *operator*, not the service account, so a folder picked through it might be one the SA cannot subsequently read — actively misleading given §6. Paste-the-folder-link plus the probe is both simpler and more honest. |

---

## Deferred / follow-ups

1. **Recursion into subfolders.** Deliberately out of v1 (§2). When it lands it needs a bounded breadth-first crawl, a depth cap, and a decision on the question that made it interesting in the first place: a `2026/09/` tree carries a date the file's own `createdTime` may contradict (a file uploaded months after it was recorded). Deriving `recorded_at` from the folder path is tempting and probably wrong; using it as a *fallback* when `createdTime` looks implausible might not be. Re-adds a `recurse` field to the §1 registry.
2. **The catch-up `fetch_sources` stage** (§9) — the substantive follow-up, and the one that needs ADR-005's operator-triggered principle revisited on its own terms.
3. **Per-folder exclusion patterns** — a filename glob to skip (`*-raw.mp4`, `draft-*`). Nobody has asked yet. When someone does, check whether ADR-043's exclusions are already the right home before adding a per-folder field.
4. **Google Picker SDK for folder selection** — still deferred, and see the Alternatives table for why it is worse than it looks here, not merely unbuilt.

## Open questions

None outstanding. The four questions this ADR opened were resolved on 2026-09-23: no recursion (§2, Deferred #1); `series_name` is a hint that drives renaming, with folder provenance recorded in `metadata_extra.drive_source_folder` (§1); destination-collision registration is refused outright (§5); exclusion patterns deferred (Deferred #3).

---

## References

- ADR-005: source integration strategy — the operator-triggered principle §9 defers relaxing
- ADR-031: server-side rule persistence — the whole-list-replace registry pattern §1 follows
- ADR-039: Drive artifact storage — origin of `lib/drive.ts` and its `drive.file` scope
- ADR-042: shared credential vault — the OAuth posture §6 inherits
- ADR-047: automated catch-up — the sweep §9 would extend, and its kill switch
- ADR-058: source discovery and pre-import awareness — the `last_checked` bookkeeping §7 joins
- ADR-071: Drive video ingest — this ADR extends it from file to folder; §3 byte copy and §4 `md5Checksum` open question both resolved here
- ADR-075: series-driven destinations — the `GoogleDrive` destination §5 guards against
- `web/src/app/api/kaltura/list/route.ts`: the list-a-window contract §2 mirrors
- `web/src/lib/youtubeIngest.ts:150`: the already-indexed check §4 reuses
