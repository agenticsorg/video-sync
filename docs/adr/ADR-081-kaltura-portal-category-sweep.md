# ADR-081: Kaltura Portal Category Sweep — Schedule-Derived Series Assignment

| Field | Value |
|-------|-------|
| **Status** | Phases 1–4 implemented 2026-10-03; Phase 4 ships plan-only by default |
| **Date** | 2026-10-03 |
| **Deciders** | Engineering, Content Operations |
| **Supersedes** | — |
| **Narrows** | ADR-080, whose Phase 3 assumed the Kaltura-side problem was a catalog-side one |
| **Related** | ADR-037 (Kaltura client; its 2026-09-29 addendum on `disableentitlement`), ADR-044 (presence sweep), ADR-055/056 (title alignment), ADR-060 (scheduled show windows), ADR-065 (contributor scope), ADR-075 (series-driven destinations), ADR-077 (per-destination outcomes), ADR-080 (catalog-side category reconcile) |

---

## Context

Kaltura ingests from Zoom automatically, on notification, via the Zoom–Kaltura connector. The Kaltura account is therefore current within about an hour of any recording finishing, with no operator action and no involvement from this app.

The connector does not apply the org's portal categories. A survey of partner 5896392 on 2026-10-03 (`category.list` + `media.list`, admin session with `disableentitlement`):

| Measure | Value |
|---|---|
| Categories on the partner | 163 (all returned; not truncated) |
| Entries created since 2026-06-01 | 127 (`totalCount` 127) |
| Entries carrying a Zoom-connector `referenceId` | 118 (92%) |
| Entries in `@zoomCategory@` only | 121 |
| Entries with no category at all | 6 |
| **Entries in any `mediaspace_*` portal channel or gallery** | **0** |
| Kaltura entries represented in our catalog | 14 (~11%) |

Every recording since June is invisible in the MediaSpace portal. This is not drift to be repaired once; it is the steady state, reproducing itself weekly.

### Why ADR-080 does not solve it

ADR-080 reconciles the Kaltura entries our catalog holds records for. The catalog holds 14 of 127. A catalog-driven backfill reaches roughly a ninth of the problem and only grows that share when someone imports more.

### Why title matching does not solve it

Kaltura enriches on ingest — it rewrites entry names with AI-generated titles, and adds topical tags. Cross-checking entry ids against our catalog:

| Kaltura's name | Our catalog's title |
|---|---|
| "Dream Machines and Adaptive Harnesses…" (`1_xk376nnl`) | Agentics Live Vibe - Coding – 13 Aug |
| "Building the Future of AI: Latent Mesh…" (`1_sbhiqdmf`) | Agentics Live Vibe - Coding – 20 Aug |
| "Building Autonomous AI Systems: From MCPs…" (`1_bqguo3um`) | Friday Hackerspace Live Events – 18 Sep |
| "Mobile Hackerspace on Wheels…" (`1_b8kw2g8u`) | Friday Hackerspace Live Events – 25 Sep |

The registry's patterns are `^.*Hackerspace.*` and `^.*Vibe.*`. They match **11 of 127** entries, and the single Hackerspace hit survived only because the AI happened to keep the word. Series assignment in this app has been working by luck of keyword retention, and the luck does not hold on the Kaltura side.

### What does identify the shows

The connector's `referenceId` carries the Zoom meeting UUID and the **true recording start**:

```
Zoom_B7JsLl3USqCiZtsrC0FvKw==2026-09-25T15:45:02Z
```

Resolved to `America/New_York`, recordings cluster exactly:

- **Thu 11:45–11:50** — 8 recordings over 8 distinct days → *Agentics Live Vibe - Coding*
- **Fri 11:45–11:50** — 8 recordings over 8 distinct days → *Friday Hackerspace Live Events*

Both confirmed against catalog ground truth, not inferred. The 11:45 start is the **pre-show** for a 12:00 show, which matches the registry's declared `12:00–13:30` window; the matcher must expect recording start to precede show start, not treat the 15 minutes as a discrepancy.

### The constraint that shapes everything

**The same Zoom and Kaltura account carries private internal meetings.** In the same time band:

| Slot (EDT) | Content |
|---|---|
| Mon 11:58 | Agentics Foundation Committee Meeting · Management Team Meeting |
| Tue 11:41–11:54 | Agentics Marketing · Website - Agentics |
| Wed 11:55–11:58 | Google Analytics Implementation · Migrating Discord to Talent Marketplace |
| Thu 11:45 | the public show |
| Fri 11:45 | the public show |

Internal meetings run **ten minutes either side of the public shows**. A time-only rule would publish the Committee Meeting to the portal. Weekday is the only thing separating public from private, and "no collision observed across four months" is not an adequate safety argument for a write that changes who can see a recording.

Moving the private meetings to a separate Zoom account has been suggested to the organisers. It would not help the back catalogue, and it would not remove the need for the safeguards below — the sweep must be safe regardless of what shares the account.

---

## Decision

### §1 The sweep runs against Kaltura, not against the catalog

Entries are enumerated with `media.list`; a catalog record is not required and is not consulted for eligibility. This is what makes the remaining 89% reachable.

ADR-080's catalog-side reconcile stays as it is, for entries this app published. The two are complementary: ADR-080 finishes a job this app started, ADR-081 categorises content this app never touched.

### §2 Series assignment is schedule-derived, and weekday is mandatory

For each entry: parse `referenceId` → true recording start (UTC) → convert to the series' IANA timezone via `zoneinfo`, never a fixed offset → match on **weekday** and a window around the declared show start.

A fixed offset is not acceptable even though every surveyed entry is EDT. The survey spans 2026-06-11 to 2026-10-02, entirely within DST; a sweep crossing the November boundary with a hardcoded `-4` would be 60 minutes out, which at a 10-minute public/private margin puts Friday's show inside Monday's slot.

The match window is `[show_start − 30min, show_start + 15min]`, which accommodates the 15-minute pre-show and the observed 11:45–11:50 jitter without reaching the 11:55+ internal meetings.

An entry whose `referenceId` is not a Zoom-connector value has no reliable recording time and is **not** matched. That includes entries this app published, whose `referenceId` is the catalog UUID (ADR-044) — those are ADR-080's responsibility.

### §3 Allowlist only; the default is to do nothing

A series is eligible only when it declares **all** of: `scheduled_days`, `scheduled_start_local`, `scheduled_end_local`, `scheduled_timezone`, and a Kaltura destination with `category_ids`. Anything short of that is skipped.

There is no inference step. "Uncategorised, in the right time band, looks like a talk" is not a rule and must never become one. Five of the seven series in the registry have no weekday and will remain ineligible until someone deliberately fills one in — which is the correct default when the cost of a false positive is publishing a management meeting.

### §4 Dry-run is the default; writing requires a reviewed list

The sweep's first output is a list: entry id, true local start, Kaltura's name, matched series, and the exact categories it would add. Nothing is written until an operator approves that list.

This is a stronger gate than ADR-080's one-click card, and deliberately so. ADR-080 writes to entries we published, against categories their series declares; the blast radius is a wrong category on our own content. Here a mistake makes a private meeting visible to the portal.

### §5 `scheduled_days` is added to the series registry

```ts
interface SeriesRegistryEntry {
  // …
  /** IANA weekday abbreviations the show runs on, e.g. ["Thu"].
   *  Required for ADR-081 eligibility. Absent means ineligible. */
  scheduled_days?: string[];
}
```

Seeded as `["Thu"]` for *Agentics Live Vibe - Coding* and `["Fri"]` for *Friday Hackerspace Live Events*. This makes the discriminator configuration rather than code, so adding a show is a registry edit and so the rule that caused any given categorisation is inspectable.

### §6 What this explicitly does not do

- **Never removes a category.** `categoryEntry.add` only, reusing ADR-080's reconciler and its guarantee that a KMC administrator's manual work survives.
- **Never creates a category.** An unresolvable declared name is reported.
- **Never matches on title.** Keyword matching is what this ADR exists to replace; reintroducing it as a fallback would reintroduce the failure on an account carrying private content.
- **Does not touch entries outside a declared window**, including the ten Thursday-afternoon entries literally titled "Agentics Live Vibe - Coding" (14:10–21:15). They would raise Vibe's count from 8 to 18, and including them means trusting a keyword on a shared account. If they are genuinely in scope, the answer is a second declared window, not an escape hatch.
- **Does not change entry visibility or access-control profiles.** Category membership only. The declared `visibility: members` on both series remains unapplied pending ADR-077 §5.

---

## Phased implementation

| Phase | Content | Blocked on |
|---|---|---|
| 1 | **Shipped.** `scheduled_days` on the registry + editor; pure matcher, tested against the real 127-entry survey | — |
| 2 | **Shipped.** `/api/kaltura/sweep`, `apply` defaulting to false; plan table on the Maintain card | — |
| 3 | **Shipped.** Apply behind the reviewed plan; per-entry outcomes logged | — |
| 4 | **Shipped plan-only.** `scripts/kaltura-sweep-schedule.sh` (Cloud Scheduler, Thu+Fri 16:00 ET). `--apply` is opt-in | Review of a few scheduled plans before enabling `--apply` |

Phase 4 is the one that matters long-term: the connector produces new uncategorised entries every weekday, so a one-off sweep returns the library to invisibility within a week.

---

## Consequences

**Good.** Reaches the ~89% of Kaltura content the catalog does not know about. Series assignment stops depending on whether an AI-written title retained a keyword. The matcher is inspectable, and the rule that categorised any entry can be named.

**Costs and risks.**

- **A false positive publishes a private meeting.** This is the dominant risk and the reason for §3 and §4. The mitigation is procedural as much as technical: the dry-run list must actually be read.
- **Schedule drift breaks matching silently.** If a show moves, entries stop matching and quietly stay invisible — the same failure mode as today, with no error. The dry-run report should state how many entries in the window went unmatched, so a drop is visible.
- **One session can produce several entries.** "Asia Management Meeting" appears at 19:30, 20:00, 20:30 and 21:00 on the same dates; Vibe shows the same pattern. All segments of a matched session are categorised, which is probably right, but it means entry counts exceed session counts.
- **The 15-minute pre-show is an observation, not a contract.** It held across 16 recordings. A show that starts recording earlier one week falls outside the window.

---

## Alternatives considered

**Keyword matching on the title.** What the system does today. Rejected on measurement: 11 of 127, and it cannot be improved without loosening patterns on an account that carries private meetings — precisely the wrong direction.

**Match on the Zoom meeting ID.** A recurring Zoom meeting keeps one meeting ID across occurrences, which would be an exact series identity rather than a schedule inference. The connector's `referenceId` carries the per-occurrence UUID, not the meeting ID, so this needs a Zoom API lookup per entry to resolve UUID → meeting ID. Stronger than §2 and worth revisiting; deferred because it adds a second platform dependency to a sweep that the schedule rule already handles for the two series in scope.

**Import everything into the catalog first, then use ADR-080.** Turns 127 Kaltura entries into 127 catalog records, most of which are private internal meetings nobody wants curated. Rejected: the catalog is a curation surface, and filling it with management calls to reach a categorisation tool is backwards.

**Have the connector apply categories.** The right fix if the Zoom–Kaltura integration supports per-meeting category mapping. Worth asking the Kaltura administrator, because it would make this ADR unnecessary for future recordings and leave only a back-catalogue sweep. Not pursued here because it does not help the existing 127 and is outside engineering's control.

---

## Related ADRs

- **ADR-037** and its `disableentitlement` addendum: without that fix this sweep sees 28 of 163 categories and reports the portal channels as nonexistent.
- **ADR-044**: the presence sweep, which had the same entitlement defect and the same "Kaltura knows something the catalog doesn't" shape.
- **ADR-060**: the scheduled show windows this ADR reuses, and extends with `scheduled_days`.
- **ADR-075**: where `category_ids` is declared.
- **ADR-080**: the catalog-side reconcile whose reconciler this reuses, and whose Phase 3 this supersedes.


---

## Addendum: Phase 4 Ships Plan-Only (2026-10-03)

**Addendum to**: the Phase 4 row, and its tension with §4.

Phase 4 says "run on a schedule, so new recordings are categorised within hours". §4 says nothing is written until an operator reads the plan. Those pull in opposite directions and the table did not say which wins.

**§4 wins, for now.** `scripts/kaltura-sweep-schedule.sh` creates a Cloud Scheduler job that runs the sweep in **plan mode**; `--apply` is an explicit opt-in.

The reasoning is the same one that shaped §3: a false positive makes a private meeting visible on the public portal, and the Monday Committee Meeting runs ten minutes either side of the Friday show. The allowlist makes an unattended apply defensible — the sweep can only touch a series an operator explicitly gave `scheduled_days` — but defensible is not verified, and nothing has yet run unattended.

A plan-only job still delivers most of Phase 4's value. The summary lands in Cloud Logging under `ext:kaltura-sweep` within hours of a recording appearing, so the drift is **visible** rather than discovered a month later. What it does not do is close the loop without a human.

Switch to `--apply` once several scheduled plans have been reviewed and were right every time. That is a judgement about accumulated evidence, not a code change.

### One honest limitation

The `from` date is baked into the job's message body when the script runs, because Cloud Scheduler bodies are static. A job created today looks back 14 days from today, forever. Options, none yet taken: re-run the script periodically, or give the route a `lookback_days` parameter it resolves at request time. The second is better and is a small change; it is called out here rather than left as a surprise.
