# ADR-079: Advance to Published — One Pipeline for Card, Bulk, and Agent

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-09-23 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Completes** | ADR-047 (catch-up — its publish stages were deferred to "slice 2" and never built) |
| **Related** | ADR-005 (operator-triggered source integration), ADR-013 (ingestion rules), ADR-016 (quota-aware backfill orchestrator), ADR-035 (persistence topology), ADR-046 (Show Notes), ADR-055/056 (title alignment), ADR-064/067 (description strategy), ADR-066 (MCP server), ADR-075 (series-driven destinations), ADR-077 (per-destination outcomes), ADR-078 §9 (the deferred sweep stage) |

---

## Context

Take a real record — `c3b00165-24ea-4ef6-8041-c38dd45bc52d`, "Agentics Live Vibe - Coding - 3 Sep 2026", a two-hour Zoom recording:

```
status              Discovered
transcript          (empty)
summary_doc_id      None
description         (empty)
destination_outcomes []
locations           [Zoom · Origin]
```

Getting that to *Published on every destination, with an aligned title and a Show-Notes-driven description* takes an operator through roughly eight separate affordances across three pages. **154 of the catalog's 199 records are in exactly this state.** That is not a backlog to grind through by hand; it is the normal condition of the catalog, and the per-record cost of clearing it is the thing that keeps it there.

### What already exists, and what it can't reach

Most of the individual steps are built and good. The problem is that nothing composes them.

| Step | Exists as | Reachable from a pipeline? |
|---|---|---|
| Fetch transcript | `/api/zoom/transcript`, `/api/kaltura/captions`, inline at import | **Partly** — catch-up's `hydrate_transcript` covers Kaltura *only*. `c3b00165` is a Zoom record with no transcript, and no stage will fetch it. |
| Show Notes | `tryEnsureSummary` | **Yes** — clean, React-free, already driven by two callers |
| Description | `ensureDescription` | **Yes** — extracted 2026-09-23 |
| Aligned title | `resolveAlignedTitle`, `runYouTubeTitleAlignBackfill` | **No** — exists only as a separate bulk maintenance action, not a stage |
| Curation advance | ingestion rules (`auto_approve`), else manual | **Conditional** — only if a rule matches |
| Publish to all destinations | `executePublish` + ADR-075 resolution + ADR-077 outcomes | **No** — the orchestration lives inside `VideoCard` |

ADR-047 built the sweep and explicitly deferred the last row:

> Deferred to slice 2: publish stages — require extracting publish logic from `VideoCard`; orchestrator just counts ready-to-publish records for now.

That deferral is still in force two ADRs later, and it is the single thing standing between the current sweep and a record that actually ships.

### Why this is "essential prep" for agent-driven maintenance

The stated goal is a maintenance agent. Three things block that today, and only the first is about convenience:

1. **The publish orchestration is trapped in a React component.** `executePublish` is shared, but everything around it — attribute resolution, the provenance footer, the grant pre-flight, outcome recording, post-processing rules, the event-log lines — lives in `VideoCard.tsx`. This is the same shape as the description bug fixed on 2026-09-23, where policy lived in a 115-line closure and nothing else could call it. The fix is the same: extract it.

2. **The whole pipeline runs in a browser.** `catchupOrchestrator` is `"use client"`, reads the client-side `videoStore`, and builds commands from React context via `actorCommand`. Every "background" loop in this app is a browser timer (`useRuleRunner` at 60s, `BackfillPanel` at 5 min, the audit poll at 8s). An agent cannot drive any of it, and neither can cron.

3. **The MCP surface is read-only.** All eleven tools — `search_records`, `get_show_notes`, `get_transcript`, `get_description`, `get_provenance`, and the rest — read. There is no tool that *does* anything. An agent can see that 154 records need work and has no way to act.

So "one-click or bulk to published" and "agent-driven maintenance" are not two features. They are the same pipeline with three callers, and the work is making the pipeline exist somewhere all three can reach it.

---

## Decision

### 1. Extract the publish orchestration — `lib/publish/advance.ts`

The prerequisite for everything else, and deliberately the same move that `ensureDescription` made:

```ts
export async function ensurePublished(
  record: VideoRecordJSON,
  opts: AdvanceOptions,
): Promise<{ published: boolean; reason?: SkipReason; outcomes: DestinationOutcome[] }>
```

Record in, structured result out, no React. It takes what `VideoCard` currently assembles inline — resolved destinations (ADR-075), processing-rule attributes (ADR-014), the provenance footer (ADR-022), the YouTube grant pre-flight, per-destination outcome recording (ADR-077) — and owns it. `VideoCard`'s handler becomes a thin wrapper supplying UI state, exactly as it now does for descriptions.

Nothing about publish *policy* changes here. This is a move, and it should be reviewable as one.

### 2. One stage list, defined once

```
  fetch_transcript      ← extended beyond Kaltura: Zoom, Fireflies, borrowed (ADR-053)
  link_siblings         ← unchanged
  ensure_summary        ← unchanged
  ensure_description    ← unchanged
  align_title           ← new stage; wraps resolveAlignedTitle
  advance_curation      ← new stage; Discovered → InScope → Approved, policy in §4
  ensure_published      ← new stage; §1's extraction
```

Every stage keeps the contract the existing ones already honour: skip-if-done, report a reason, never abort a peer. That is what makes the pipeline idempotent and therefore safe to re-run, which is what makes it safe to give to an agent.

`fetch_transcript` is called out because it is a real hole rather than a rename. `hydrate_transcript` handles Kaltura captions only; `c3b00165` is a Zoom record with an empty transcript and today no stage will fill it. Without a transcript there are no Show Notes, without Show Notes no description — so the hole at the front of the pipeline is why the other 153 records are stuck too.

### 3. Three callers, one implementation

| Caller | Entry | Scope |
|---|---|---|
| **Card** | "Advance to Published" button | One record. An operator watching one record *is* consent; runs the full stage list including publish. |
| **Bulk** | The existing Catch-Up panel, extended | The window the sweep already walks, subject to §4's gate, §5's quota, and the bulk-automation kill switch. |
| **Agent** | New MCP tool `advance_record` | One record per call, same pipeline, same guards. §6. |

They differ only in what they pass, not in what runs. A divergence between the card's behaviour and the sweep's is the class of bug that produced the 2026-09-23 half-publish.

### 4. The curation gate — where consent lives

Publishing is irreversible in a way no other stage is: it puts a video in front of an audience under the org's name. The gate is therefore explicit rather than inherited.

- **Per-record (card, agent-with-a-named-record)** — the caller named this record. That is consent. `advance_curation` may take `Discovered → InScope → Approved`, and `ensure_published` may run.
- **Bulk sweep** — `advance_curation` may take `Discovered → InScope` freely, but `InScope → Approved` **only when an ingestion rule with `auto_approve` matched** (ADR-013). Records that reach `InScope` without such a rule stop there and are reported as `needs_review`.

This keeps ADR-047's rule — *"never auto-approve into Published without operator consent"* — while letting an operator grant that consent once, per series, by writing an `auto_approve` rule, rather than once per record forever.

`ensure_published` additionally refuses any record outside ADR-078's active-consideration set, so a `Skipped` or `Abandoned` record cannot be published by a sweep whatever its rules say.

### 5. Quota is a first-class stage input, not an error

A YouTube upload costs 1,600 units against a 10,000/day quota: **six uploads per day**, total, across everything. "Bulk to published" over 154 records is therefore a multi-week operation whatever we build, and a pipeline that discovers this by failing the seventh upload is worse than useless — it burns the record's LLM spend and leaves it half-advanced.

`ensure_published` consults the ADR-016 quota state (`/api/backfill/tick`, `uploads_today`, `max_uploads_per_day`) **before** attempting a YouTube push, and reports `skipped: quota_exhausted` rather than failing. The record keeps everything the earlier stages produced — transcript, Show Notes, description, aligned title — and is publish-ready the moment quota resets.

The corollary matters for sequencing: **the expensive-but-unlimited stages should run ahead of the scarce one.** A sweep can bring all 154 records to "Approved, fully prepared, waiting on quota" in one pass, then drip six a day. That is a far better shape than advancing six records end-to-end and leaving 148 untouched.

### 6. The headless path, and where the pipeline actually runs

This is the load-bearing decision, and the one that makes the rest reusable.

**The pipeline moves server-side.** `lib/pipeline/advance.ts` runs in the Next.js server runtime, reads and writes the catalog through `catalogStore`, and drives the WASM aggregate directly. The browser keeps its store and its optimistic UI, but stops being the only place the pipeline can execute.

Two facts make this less speculative than it sounds:

- **Server-side WASM already works.** Driving the aggregate from Node via a `--target nodejs` build was used on 2026-09-23 to repair record `294ceec4` — load the record JSON, apply a command, serialise back, with every invariant intact. The technique is proven, not hypothetical.
- **The server already owns the catalog.** `readCatalog`/`writeCatalog` are the source of truth (ADR-035 Level 2); the browser syncs against them. Running the pipeline where the data lives removes a round trip rather than adding one.

The API surface:

```
POST /api/records/{id}/advance        → run the pipeline for one record (SSE progress)
POST /api/records/advance-bulk        → run it over a window (SSE, kill-switch gated)
GET  /api/records/{id}/advance-status → what a previous run did, and why it stopped
```

The MCP tool `advance_record` is a thin wrapper over the first. It is the **first mutating MCP tool**, which deserves saying out loud: everything the agent surface has done until now is read. The tool inherits the bearer token's actor (ADR-066 §4), so an agent acts as a real, audited identity with a real role — a Contributor's token cannot publish, because `record_destination_result` requires Admin-or-Publisher.

### 7. Credentials — the one thing the server cannot simply inherit

YouTube is per-operator by design (ADR-042: brand-account attribution, so YouTube records the actual human). Today the browser reads the refresh token from `localStorage` and forwards it in `x-youtube-*` headers. **A headless caller has no browser and therefore no token.**

This is the sharpest constraint on agent-driven publishing, and it is an auth decision rather than an engineering one. Three options, none free:

| Option | Cost |
|---|---|
| A shared org YouTube credential in Secret Manager for agent runs | Loses per-operator attribution — every agent-published video is uploaded by "the app", which is precisely what ADR-042 §YouTube rejected |
| Operator grants a durable delegated token for unattended use | Preserves identity; needs a consent UI and a revocation story |
| Agent runs advance the pipeline to **Approved** and stop; a human publishes | No auth change at all; loses the last click, which is also the irreversible one |

**Recommended: option C first.** It delivers the bulk of the value — 154 records prepared, titled, summarised, described, publish-ready — against zero new credential surface, and it leaves the irreversible step with a human while the pipeline earns trust. A/B can follow once there is a reason beyond convenience.

Kaltura and Drive are unaffected: both already resolve org-shared credentials server-side (ADR-042), so a headless run can publish to them today.

---

## Consequences

### Positive

- One record goes from `Discovered` to published-everywhere in a single action, with the title and description the series says it should have. That is the actual ask, and it is the same code path in all three callers.
- The 154-record backlog becomes a scheduling problem rather than a labour problem — prepared in bulk, published at whatever rate quota allows.
- Extracting publish from `VideoCard` removes the last big piece of policy trapped in that component, and closes ADR-047's deferral.
- The pipeline becomes testable. Stage guards are pure functions over a record; today the publish half can only be exercised by rendering a React component.
- An agent gets a real action surface with a real audited identity, rather than read-only visibility into work it cannot do.

### Negative / risks

- **`VideoCard` publish extraction is the riskiest change in this ADR.** It touches the path that ships video to the public, and that path has produced two incidents this month already. It should land alone, behind its own deploy, with the card's behaviour unchanged and verifiable before any new caller is wired up.
- **Server-side execution is a genuine architectural shift.** Every mutation today flows browser → API; this inverts that for one pipeline. The two will coexist, and a record being advanced server-side while its card is open in a browser is a concurrency case that does not exist today. The catalog's last-writer-wins merge (ADR-035) is the only arbiter, and it is per-instance (as the 2026-09-23 truncation showed).
- **Cost concentration.** Show Notes for a three-hour session can reach $0.50 (ADR-047). A sweep over 154 records is real money and must respect a cap, with the estimate shown before the run — as the Catch-Up panel already does.
- **A pipeline that publishes is a pipeline that can publish the wrong thing.** Everything upstream — title alignment, the description LLM, destination resolution — now feeds an irreversible action without a human reading the output. §4's gate is the mitigation and it is a policy, not a guarantee.
- **The kill switch becomes more load-bearing.** `/api/admin/automation` currently gates bulk mutation; it would now gate bulk *publishing*. Default-off remains right.

### Neutral

- No aggregate change. Every state transition this pipeline performs already exists as a WASM command; ADR-077's per-destination outcomes already model partial success.
- No new persistence. Stage results are derivable from the record.

---

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Keep the pipeline client-side; agent drives a headless browser** | Turns a data-processing job into UI automation, and inherits every flake in the rendering path. The pipeline has no business needing a DOM. |
| **Publish stage in the sweep only, no per-record button** | The per-record case is the one an operator actually asks for ("get *this* one out"), and it is where consent is unambiguous. Bulk without it forces a rule to be written for a one-off. |
| **Per-record button only, no bulk** | Leaves the 154-record backlog exactly where it is. The per-record affordance is the easy half. |
| **Auto-approve everything the sweep touches** | Publishes records no human has ever looked at, on the strength of a title regex. ADR-047 ruled this out and nothing has changed. |
| **A new orchestration service (Cloud Tasks / Workflows)** | Real infrastructure for a queue that is six items deep per day. ADR-047 rejected the same idea for the same reason; the quota ceiling means scale is not the problem. |
| **Ship a shared YouTube credential so agents can publish immediately** | Discards ADR-042's per-operator attribution for convenience. §7 option C gets most of the value while that decision is made properly. |

---

## Deferred / follow-ups

1. **Unattended scheduling.** This ADR makes the pipeline callable headlessly; it does not add a cron. ADR-078 §9 and ADR-058 both circle the same unresolved question — whether the app may act without an operator present — and it should be settled once, on its own terms, not inherited from this.
2. **Delegated YouTube credentials for agent publishing** (§7 options A/B).
3. **Mutating MCP surface beyond `advance_record`.** Approve, skip, retry-destination and edit-title are all plausible agent actions. One tool first; a policy for the rest before a second.
4. **Cross-instance coordination.** Two instances advancing the same record is a race the per-instance lock cannot see. Currently mitigated by there being one operator; not a durable answer.

---

## Open questions

1. **Does `align_title` mutate the record, or only the publish payload?** Today's backfill rewrites `title`. A pipeline that also rewrites it makes the operator's own edit vulnerable to a later sweep — the same "generated vs hand-written" problem that `description_source` solved for descriptions. Leaning: the record needs `title_source` before a sweep may touch titles.
2. **Should the per-record button run stages that cost money without asking?** A two-hour session's Show Notes is not free, and "Advance to Published" does not obviously read as "spend $0.50". Leaning: show the estimate in the button's confirm, as the Catch-Up panel does.
3. **What does the sweep do with a record whose publish partially fails?** ADR-077 says Published-with-outcomes. In bulk, one operator reading 40 partial results is not review. Leaning: surface a "needs attention" count rather than per-record banners.

---

## References

- ADR-047: automated catch-up — the sweep this completes, and the publish deferral it left open
- ADR-016: quota-aware backfill uploader — §5's quota state
- ADR-042: server-side credentials — §7's constraint
- ADR-066: MCP server — §6's first mutating tool
- ADR-075 / ADR-077: destination resolution and per-destination outcomes — what `ensure_published` records
- ADR-078 §9: the catch-up sweep stage deferred pending exactly this decision
- `web/src/lib/catchupOrchestrator.ts`: the existing stage loop
- `web/src/lib/descriptionGenerate.ts`: the extraction pattern §1 follows
- `web/src/components/VideoCard.tsx`: where the publish orchestration currently lives
