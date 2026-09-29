# ADR-080: Kaltura Category Backfill in Maintain

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-09-29 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Completes** | The per-card "Fix Kaltura categories" action shipped 2026-09-29 (`9d725d3`…`8daebd5`), which was explicitly scoped to one record at a time |
| **Related** | ADR-037 (Kaltura publish integration — and its 2026-09-29 addendum on `disableentitlement`), ADR-044 (Kaltura presence sweep), ADR-047 (catch-up orchestrator), ADR-049 (location dedupe), ADR-052 (summary badge backfill — the pattern this follows), ADR-075 (series-driven destinations — the `category_ids` declaration), ADR-077 (per-destination outcomes; §5 read-back, §6 conformance deferred), ADR-079 (advance-to-published pipeline) |

---

## Context

ADR-075 gave each series a `DestinationSpec[]`, and the Kaltura variant carries `category_ids`. Until 2026-09-29 those values had never reached Kaltura: the adapter coerced each with `Number()` and dropped the NaNs, and the registry holds category *names*, so the array emptied on every publish. The upload route then skipped the field because it was empty. No error, at any step.

That is now fixed in three places — the adapter applies categories after upload, a per-card action repairs an existing entry, and every Kaltura session mints with `disableentitlement` (ADR-037 addendum, without which two thirds of the partner's category tree is invisible).

What remains is the accumulated debt. The per-card action was deliberately scoped to one record because the mechanism was unproven; it is now proven against the live 163-category listing on partner 5896392. This ADR covers doing the rest in bulk from **Maintain**.

### The population

19 Kaltura locations exist across the catalog, in two roles:

| Role | Count | Series declares categories | Meaning |
|---|---|---|---|
| `Destination` | 8 | 8 | We published this entry |
| `Origin` | 11 | 8 | We ingested the record *from* this entry |

The 8 Destinations break down as 3 × *Agentics Live Vibe – Coding* (4 declared), 2 × *Friday Hackerspace Live Events* (4 declared), 3 × *Agentics Foundation Retreat – Fall 2026* (1 declared — `@zoomCategory@` only, which the Zoom connector already applies, so those three are likely no-ops).

This is a small population. The value of the batch is not throughput; it is **not having to remember which records are behind**, and having somewhere that says so.

---

## Decision

### §1 Scope: Destinations in Phase 1, Origins behind an explicit opt-in

Phase 1 covers `role: "Destination"` only — exactly the set the per-card action already operates on. Phase 2 may extend to `Origin`.

The distinction matters. A Destination entry is one this app created; categorising it finishes a job the app started. An Origin entry is one that already existed on the partner and which the app merely indexed — writing to it is a change to content the app does not own, even though it is the same org's account and the write is additive.

The argument for including Origins is real: the goal is that *the account reflects the series taxonomy*, not that *things we uploaded are tidy*. A Friday Hackerspace recording uploaded by hand last year belongs in the same channels as one published through this tool. But that is a content-operations decision with a wider blast radius, it doubles the affected population, and nothing forces it to be made now. Phase 1 is strictly a catch-up on work this app failed to do.

Records whose series declares no Kaltura categories are out of scope in both phases. There is nothing to reconcile against.

### §2 The scanner cannot determine compliance, and must not pretend to

Every other Maintain backfill reads the catalog and knows the answer. `findRecordsNeedingSummaryBadge` compares `summary_prompt_version` against the current prompt; `findOrphanClips` inspects links; `findDuplicateClusters` compares records. All pure, all offline, all exact.

**Category compliance is not in the catalog.** Nothing records which Kaltura categories an entry belongs to. Determining it requires a `categoryEntry.list` per entry.

Two honest options:

1. **Candidates, not diagnoses.** The scanner returns records with a Kaltura entry and declared categories. The driver reconciles each; reconciliation is additive and idempotent, so an already-compliant entry costs one read and zero writes. The count shown on the card is *"8 records to check"*, never *"8 records non-compliant"*.
2. **Persist a read-back** so the scanner can filter offline.

**Phase 1 takes option 1.** It is correct today, needs no schema change, and the population is 8. Option 2 is §5.

The naming must carry this. `findRecordsNeedingKalturaCategories` would be a lie — it cannot know. The function is `findKalturaCategoryCandidates`, and the card says *"Check"*, not *"Fix N broken"*. This ADR is explicit about it because the temptation to show a confident number on a dashboard is exactly how the original bug reported four real categories as `not_found`.

### §3 The driver follows the established shape

```ts
// web/src/lib/kalturaCategoryBackfill.ts

export interface KalturaCategoryCandidate {
  record_id: string;
  title: string;
  entry_id: string;
  series_name: string;
  declared: string[];
}

/** Pure. Returns candidates to CHECK — not records known to be wrong. */
export function findKalturaCategoryCandidates(
  allRecords: VideoRecordJSON[],
  registry: SeriesRegistryEntry[],
  rules: ProcessingRules,
): KalturaCategoryCandidate[];

export interface KalturaCategoryProgressEvent {
  type: "started" | "item_done" | "complete";
  index?: number;
  total: number;
  title?: string;
  outcome?:
    | { kind: "applied"; added: string[] }
    | { kind: "already_compliant" }
    | { kind: "incomplete"; detail: string }   // resolved partially
    | { kind: "error"; error: string };
  totals?: { applied: number; already: number; incomplete: number; errors: number };
}

export async function runKalturaCategoryBackfill(
  onEvent: (ev: KalturaCategoryProgressEvent) => void,
  log?: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<{ applied: number; already: number; incomplete: number; errors: number }>;
```

Sequential, one record at a time, per `runOrphanClipsRepair` and `runCatalogDedupe`. An error on one record is recorded and the loop continues. The card lives in `CatchUpPanel.tsx` with the same vocabulary as its neighbours.

`incomplete` is a distinct outcome from `error`, not a sub-case of success. A record whose four declared categories resolve to three is neither fixed nor failed, and collapsing that into either is how the original problem stayed invisible.

### §4 The category listing is read once per run, not once per record

`/api/kaltura/categories` currently does, per call: mint KS → `category.list` (163 categories, paged) → `categoryEntry.list` → N × `categoryEntry.add`. Eight records means eight identical full listings.

Add a short-TTL server-side memo of the resolved listing, keyed by partner id, in `lib/kalturaApi.ts` — the same pattern and rationale as `sharedCredentials.ts`'s 5-minute cache. This also speeds the per-card action when an operator works through several records by hand.

The TTL must be short (≤5 minutes) and the cache must not be consulted when a resolution *fails*: a name that misses against a cached listing should re-read once before being reported `not_found`, because a stale cache reproducing the original bug — confidently reporting a category absent — is the specific failure worth spending a request to avoid.

A batch `entryIds: string[]` mode on the route was considered and rejected for Phase 1: it moves loop control server-side, where it cannot report per-item progress to the panel, for a population of 8.

### §5 Follow-up: persist what was observed

ADR-077 §5 gave `DestinationOutcome` `observed_visibility` and `observed_at`, with a `recordObservedVisibility` command; §6 (declared-vs-observed conformance) is deferred. Categories are the natural second axis, and the same deferral applies.

Adding `observed_categories: Option<Vec<String>>` and `categories_observed_at` to `src/catalog/value_objects.rs` would let §2's scanner filter offline, make the Overview able to state a real compliance figure, and let ADR-077 §6 evaluate both axes at once. Every field there is `#[serde(default)]`, so records on disk deserialise unchanged.

It is deliberately **not** in Phase 1: it needs a Rust schema change plus a WASM rebuild to `web/pkg`, and the batch is useful without it. It is the right next step once the batch has run at least once and we know what the real compliance rate is.

### §6 What this explicitly does not do

- **Never removes a category.** `categoryEntry.add` only. A KMC administrator's manual categorisation must survive the backfill; a repair tool that quietly destroys manual work is worse than no repair tool.
- **Never creates a category.** A declared name that does not exist is reported with near-matches and the partner's own naming, for a human to resolve in the registry or the KMC.
- **Never guesses an ambiguous name.** `vod_sources` matches 11 categories on partner 5896392 — one per per-event root. The reconciler names the competitors and requires a full path.
- **Does not touch visibility.** `appliesDeclaredVisibility("Kaltura")` remains false pending ADR-077 §5's access-control mapping, which needs the KMC administrator. Categories and visibility are the same round trip and should eventually be one "reconcile this entry against its series" action, but that is blocked and this is not.

---

## Phased implementation

| Phase | Content | Blocked on |
|---|---|---|
| 1 | Scanner + driver + `CatchUpPanel` card, Destinations only; listing memo in `kalturaApi.ts` | — |
| 2 | `observed_categories` on `DestinationOutcome`; scanner filters offline; Overview shows a real figure | Rust + WASM rebuild |
| 3 | Origin-role entries, behind an explicit opt-in | A content-operations decision (§1) |
| 4 | Fold categories and visibility into one reconcile action | ADR-077 §5 access-control mapping (KMC administrator) |

---

## Consequences

**Good.** The remaining debt clears in one operator action instead of eight. The mechanism is already built and proven — this ADR mostly adds a loop and a card. The listing memo speeds the per-card path too. `incomplete` as a first-class outcome means a partial reconcile is visible rather than rounded to success.

**Costs and risks.**

- The card's count is *candidates*, not *defects*. It will read "8 to check" even when all 8 are compliant, which is less satisfying than a number that goes to zero. §5 fixes this properly; anything sooner would be a guess dressed as a figure.
- The backfill writes to Kaltura. It is additive and idempotent, but it is still a bulk write to a production media account triggered by one button. The card must state what it will do and against how many entries before it does it.
- Kaltura rate-limits an admin KS. Sequential execution plus the shared listing keeps a run to roughly 8 reads and a bounded number of writes; a much larger population would need throttling, which Phase 1 does not implement.
- Phase 1 leaves 8 Origin-role entries uncategorised. That is a deliberate deferral, not an oversight, and the card should say so rather than implying the account is complete.

---

## Alternatives considered

**Extend the catch-up orchestrator instead of adding a Maintain card.** `catchupOrchestrator.ts` already has staged per-record work and would give this for free on newly-published records. Rejected for the backfill: catch-up runs per record on ingest, and this is a one-off sweep over history. The orchestrator is the right home for *keeping* records compliant — which the adapter fix already handles at publish time — not for clearing accumulated debt.

**Do nothing; let operators use the per-card button.** Viable at 8 records, and genuinely cheaper. Rejected because nothing tells an operator *which* 8, and the answer is not derivable from the catalog (§2). The value is the list, not the loop.

**Make the scanner network-aware so the count is exact.** A pure scanner is what makes the other backfills testable and fast, and `CatchUpPanel` renders several counts on mount; a network read per candidate on every render is the wrong trade. §5 gets exactness the right way, by persisting what a run observed.

---

## Related ADRs

- **ADR-037** + its 2026-09-29 addendum: the Kaltura client, and why every session needs `disableentitlement`. Without that fix this backfill would confidently report every declared category as missing.
- **ADR-044**: the presence sweep, which shares the "read Kaltura, compare to catalog" shape and had the same entitlement defect.
- **ADR-052**: the summary-badge backfill, whose scanner/driver/card structure this follows.
- **ADR-075**: where `category_ids` is declared and edited.
- **ADR-077**: per-destination outcomes; §5 is where §5 above extends, §6 is where conformance eventually lands.
- **ADR-079**: the advance-to-published pipeline, which the adapter's category step now runs inside.

---

## Addendum: The Origin-Role Rationale Was Wrong (2026-09-29)

**Addendum to**: §1's deferral of `Origin`-role entries, and the Phase 3 row.

§1 defers the 11 `Origin`-role Kaltura entries on the grounds that *"an Origin entry is one that already existed on the partner and which the app merely indexed — writing to it is a change to content the app does not own."*

That reasoning does not survive contact with the data. The KMC shows entry `1_b8kw2g8u` carrying:

```
Reference ID: Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
```

Kaltura's Zoom connector stamps every entry it ingests with the Zoom meeting UUID and the recording start. These are not third-party uploads — they are **the org's own Zoom recordings**, which reached Kaltura by the connector rather than by this tool. There is no ownership question to defer on.

### What was actually wrong

Not the deferral, but the model underneath it. A Kaltura-imported record is stored with `role: Origin`, which asserts Kaltura is where the content originated. For a connector-ingested entry that is false, and it produced a second catalog record for an event the catalog may already hold as a Zoom row.

Two consequences, neither previously recorded:

1. **`recorded_at` was Kaltura's `createdAt`** — the ingest time. `1_b8kw2g8u` is stored as `2026-09-25T18:13:49Z` for a recording that started at `15:45:02Z`, two and a half hours out. ADR-048's date gates, ADR-060's show windows and the Overview all read that field.

2. **The ADR-044 presence sweep reported these entries `absent`.** It matches `filter[referenceIdIn]` against our catalog UUIDs, then falls back to the ADR-022 description footer. A connector-created entry has neither, so the card invited a publish of a recording Kaltura demonstrably already held — the catalog record had been *built from that entry*. ADR-044 §Context item 2 predicted this shape; the cause was not what it guessed.

### Resolved

ADR-044 deferred origin matching for such entries to *"fuzzy title + recorded-at match"*. No fuzzy match is needed and none should be used while the reference id is present: our Zoom records are keyed `source_id: "zoom-<UUID>"` on exactly the base64 form the connector writes, so the pairing is **identity**.

Shipped 2026-09-29:

- `lib/kalturaZoomOrigin.ts` parses the reference id and classifies it `ours` (a catalog UUID, ADR-044) / `zoom` / `foreign` / `absent`. The parser anchors on the trailing ISO instant rather than splitting on `==`, which is base64 padding — real UUIDs in the catalog contain `/` and `+`.
- `/api/kaltura/list` captures `referenceId`, `adminTags` and `categoriesIds`, which it had been receiving from `media.list` and discarding, and gained an `entryIds` mode so specific entries can be fetched in one batched call.
- `lib/kalturaOriginMerge.ts` + a Maintain card: **step 1** recovers the provenance and corrects `recorded_at`; **step 2** attaches the entry to the Zoom record as a `Destination` and retires the duplicate row.
- Presence resolution now treats **any** Kaltura location as proof of presence, not only `Destination` — `lib/backfill.ts` and the card's `alreadyOnKaltura`.

**Merge, not link,** on the operator's decision. One record per event, with every platform holding a copy listed as a location, is the correct end state; linking would have left two rows asserting the same event. The driver adds the location *before* retiring the row, so a failure leaves a recoverable duplicate rather than losing the only record naming the entry, and it refuses to retire anything in `Approved` / `Publishing` / `ToRetry` / `Published` — those report `location_only` and wait for a human.

### What this changes about Phase 3

Phase 3 is no longer "should we write to content we don't own". The remaining question is narrower and empirical: **after the merge, which Kaltura entries still lack their series' categories?** Some will need nothing — the connector already files its entries into `@zoomCategory@` and the per-event roots. The Phase 3 row should be read as *"apply §1's category reconcile to entries that arrived via the connector"*, and it cannot be sized until step 1 has run.

The §1 paragraph beginning "The distinction matters" is superseded by this addendum.
