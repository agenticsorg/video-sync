# ADR-082: Catalog Writes Must Not Lose Server State

| Field | Value |
|-------|-------|
| **Status** | Accepted — implemented 2026-10-03 |
| **Date** | 2026-10-03 |
| **Deciders** | Engineering |
| **Supersedes** | — |
| **Amends** | ADR-035 (persistence topology) — narrows its last-writer-wins rule |
| **Related** | ADR-041 (audit), ADR-049 (location dedupe), ADR-071 §Addendum (bucket versioning, which is the only reason the lost data was recoverable), ADR-074 (artifact bag), ADR-080 / ADR-081 (the backfills that exposed this) |

---

## Context

ADR-035 makes the browser authoritative for catalog state: the client holds records in a WASM store, mutations happen locally, and `POST /api/catalog` persists them with last-writer-wins.

Two data-loss incidents four days apart show that rule is too coarse. Both were caused by ordinary mutations from a browser tab whose copy of a record was older than the server's.

### What happened

**2026-09-29** — running the Kaltura origin backfill destroyed four `metadata_extra` keys (`kaltura_original_title`, `player_url`, `title_aligned_source`, `title_aligned_matched_series`) on the two records that had any, and truncated one description from 1246 characters to 300. Recovered from bucket generations `1790709694686195` → `1790724730490401`.

**2026-10-03** — after a fix intended to prevent exactly that, the same run destroyed the same keys on three records and truncated two descriptions, one from 4466 characters to 300.

Neither write was malformed, unauthorised, or erroneous on its own terms. Each pushed a complete, valid record. The records were simply missing things the server already had.

### The mechanism

Three behaviours compose into silent loss:

1. **`syncWithServer` adopts the server's copy only when `serverTime > localTime`, and it runs at boot** (`bootStore`). A tab open for days never re-syncs, so its records are frozen at whenever it last loaded.

2. **`mutate()` calls `touch(id)`**, setting the record's local `lastModified` to now. A stale copy therefore becomes the newest copy by the act of touching it — regardless of how much it is missing.

3. **`pushRecordsBatch` sends `record.to_json()` wholesale, and `POST /api/catalog` stores it with `current.records[v.id] = v.json`.** No field-level merge exists anywhere in the path.

So any mutation from a stale tab overwrites every improvement that tab never observed. The second incident makes this concrete: `954cbc2f` was imported with a 300-character Kaltura description, enriched to 4466 characters somewhere the tab did not see, and pushed back at 300.

### Why the client-side fix failed

The 2026-10-03 fix had the backfill restate the record's existing `metadata_extra` in its patch, and verify afterwards that no key had been dropped. Both halves read `videoStore.getAll()` — the **client's** copy. The data at risk exists only on the **server**:

```
client before : 7 keys (stale)        server before : 11 keys
merged patch  : 7 keys + new          server after  : 7 keys
client after  : 7 keys + new
droppedKeys() : []   ← nothing lost, as measured
```

The guard was looking at the side that could not be wrong. This is worth recording because it is a repeating shape in this codebase, not a one-off: a check that confirms the code did what the code does, on data the failing case never produces.

### Why this is not a backfill bug

The backfills were the first thing to touch many records at once, which is why they surfaced it. Every mutation path has the same exposure: a card edit, a status transition, a title realign, all from a long-lived tab. Fixing the backfill fixes nothing.

---

## Decision

**`POST /api/catalog` stops replacing a record wholesale and starts merging the fields where loss is silent and unrecoverable.**

The protection moves to the boundary every write already passes through, rather than to each caller. Two client-side attempts have now failed, both because they relied on the writer knowing what it might be about to destroy.

### §1 `metadata_extra` merges key-wise

The incoming record's `metadata_extra` is merged over the stored one rather than replacing it. A key present on the server and absent from the push is **kept**.

This makes key removal impossible through the normal path. That is the correct default: every key in this map was written by something that had a reason, and no current caller legitimately needs to remove one.

**Correction (2026-10-03, during implementation).** This section originally claimed a caller could still delete a key via the aggregate's explicit-null convention, "which survives the merge because `null` is a present value". That is wrong. `apply_metadata_edits` removes the key *in the browser*, so the pushed record simply lacks it — indistinguishable from a stale push, and the merge restores it. Deletion through the push path is genuinely impossible now. Nothing needs it today; a caller that comes to need one will add an explicit per-record opt-out, as §2 has for descriptions.

### §2 A description may not shrink silently

A push whose `description` is materially shorter than the stored one — and is a prefix of it, the signature of truncation rather than a rewrite — is **rejected for that field**: the stored description is kept and the rest of the record is written.

Both incidents truncated to exactly 300 characters, which is the length Kaltura's `media.list` returns. The loss was always a stale import-time value overwriting enriched text, never a deliberate shortening.

An operator genuinely shortening a description produces an edit that is not a prefix of the original, so the common case is unaffected. A caller that must replace a description with a shorter prefix passes an explicit flag.

### §3 Everything else keeps last-writer-wins

Status, title, tags, locations, upstream links and the rest are unchanged. They are either operator intent, where last-writer-wins is correct, or already guarded elsewhere (ADR-049 dedupes locations by normalised external id).

This ADR deliberately does not attempt a general three-way merge. The two fields above are where loss has actually occurred, is silent, and destroys work that cannot be regenerated from the platforms.

### §4 The server says when it refused

A merge that preserved a key, or a rejected truncation, emits a structured log line (`component: "api:catalog"`, `msg: "write-protected"`) naming the record, the field and what was kept.

Silence is what let both incidents run unnoticed. Without this the protection works and nobody learns that a stale tab is pushing — which is still a bug, just a non-destructive one.

### §5 Staleness is reduced, not relied upon

`syncWithServer` is additionally called when the tab regains focus after a threshold, so a long-lived tab refreshes rather than drifting indefinitely.

This is a mitigation, not the fix. It narrows the window; §1–§2 close the consequence. Ordering matters: a timing fix alone would have made both incidents rarer and harder to diagnose, which is worse than the loss being reproducible.

---

## Consequences

**Good.** The loss becomes structurally impossible rather than avoided by discipline. The protection covers every current and future writer, including the ADR-081 sweep. `metadata_extra` becomes genuinely additive, which several features already assume.

**Costs and risks.**

- **A deliberate `metadata_extra` key removal now needs the explicit-null convention.** No current caller does this, so nothing breaks today, but it is a contract change worth stating in ADR-035.
- **The prefix heuristic in §2 can be fooled.** A legitimate edit that happens to be a strict prefix of the original is rejected. Judged acceptable: the operator sees the value unchanged and can re-edit, whereas the failure in the other direction destroyed 946 and 4166 characters of generated text.
- **Merging makes the write path slower and more stateful.** It already reads the store under a lock, so the additional cost is per-record field comparison.
- **It masks staleness rather than curing it.** §4 exists so the masking is observable, and §5 reduces the incidence; neither makes the client correct. A client-authoritative design with long-lived sessions will keep producing variants of this.

---

## Alternatives considered

**Force a sync before mutating.** The backfill — or `mutate()` generally — re-reads from the server first. Rejected as the primary fix: it is the same shape as the two attempts that already failed, requiring each caller to remember. Worth doing as defence in depth, which is §5.

**Make the client less stale (sync on focus / poll).** Narrows the window without closing it, and a rarer bug with the same consequence is harder to find. Kept as §5, not as the fix.

**Compare-and-swap on `lastModified`.** The client sends the version it based its edit on; the server rejects the write if it has moved. Correct, and the standard answer. Rejected for now because every rejection needs a client-side merge-and-retry that does not exist, and the failure mode while that is missing is a lost mutation — trading silent data loss for silent edit loss. Revisit if the field-level merge proves insufficient.

**Stop treating the browser as authoritative.** The real fix, and a rewrite of ADR-035. Out of scope.

---

## Related ADRs

- **ADR-035**: the last-writer-wins rule this narrows. Its "single-browser constraint" is exactly the assumption being violated — the constraint was never enforced, and nothing tells an operator their second tab is dangerous.
- **ADR-071 §Addendum**: bucket versioning, enabled 2026-09-23. The only reason both incidents were recoverable; without it the data was gone.
- **ADR-080 / ADR-081**: the backfills that exposed this. Neither is the cause.
