# ADR-048: Date-Distance Gates in Cross-Source Matchers

**Status**: Accepted (implemented 2026-06-03; sibling gate superseded by the 2026-09-09 Addendum below)
**Date**: 2026-06-03
**Deciders**: Architecture Team
**Related**: ADR-016 (backfill uploader), ADR-033 (multi-origin dedupe / sibling matcher), ADR-046 (prompt-driven summaries — surfaces matcher results), ADR-047 (automated catch-up — consumes matcher results)

---

## Context

The catalog runs two candidate-matching algorithms that look superficially similar — both compute a 0-to-1 score combining title overlap and date proximity — but live in separate files and have drifted in important ways:

| Matcher | File | What it matches | Used by |
|---|---|---|---|
| **Sibling matcher** | `web/src/lib/siblingMatcher.ts` (`rankSiblingCandidates`) | A catalog record vs. other catalog records, looking for the same underlying event captured by a different source platform (Zoom ↔ Fireflies, etc.) | "Possibly same event" banner on cards; `link_upstream` auto-link in catch-up (ADR-047) |
| **Recover-from-YouTube matcher** | `web/src/lib/youtubeUploadsCache.ts` (`rankCandidates`) | A catalog record vs. uploads on the operator's YouTube channel, looking for "is this already on YouTube?" | "Recover from YouTube" panel; "Possible YouTube match" auto-suggestion banner on cards |

Both were producing **high-confidence false positives for recurring meetings**. The class of bug: a record named "Friday Hackerspace Live Events" can match against every other instance of the same recurring session, since participant lists and title token sets are near-identical. The date is the distinguishing signal — but both algorithms either weighted date too weakly (sibling: a 48-hour delta still contributed 0.2) or decayed too gently (recover-from-YouTube: linear decay from 1.0 to 0.0 over 180 days, so a 30-day gap still added a +0.15 boost on top of a perfect title's 0.7 contribution).

Concretely, two scoring trips:

- **Sibling**: participant overlap 1.0 × 0.4 + title overlap 1.0 × 0.3 + (48h time score = 0.2) × 0.3 = **0.76**. Above the 0.6 review threshold; close to the 0.85 auto-link bar after weight redistribution when participants were missing.
- **Recover-from-YouTube**: title overlap 1.0 × 0.7 + (30-day decay = 0.15 boost) = **0.85**. Triggered the auto-suggest banner ("Possible YouTube match") at near-perfect confidence even though the YouTube upload was a month older than the catalog record's `recorded_at`.

Both produced the same operator experience — confident "this is a match" suggestions that were wrong.

## Decision

Apply **date-distance gates** in both matchers. A date gap that exceeds a plausibility bound is treated as a *strong NOT-match signal* that overrides other features — candidates past the bound are dropped before scoring, never appearing in the ranked output, never reaching review or auto-link thresholds.

The two matchers compare semantically different timestamps, so the bounds differ:

| Matcher | Compares | Plausibility bound | Constant |
|---|---|---|---|
| Sibling | `recorded_at` vs `recorded_at` (both are the *event* time) | 30 hours *(superseded 2026-09-09 → same-day)* | `MAX_PLAUSIBLE_TIME_DELTA_MIN = 30 * 60` |
| Recover-from-YouTube | `recorded_at` vs YouTube `publishedAt` (event vs. upload) | 90 days | `MAX_PLAUSIBLE_PUBLISH_LAG_DAYS = 90` |

### Sibling matcher — 30-hour gate

> **Superseded 2026-09-09.** The 30-hour bound below was too loose — it
> spans two calendar days. See the [Addendum](#addendum-sibling-gate-is-same-day-not-30-hour-2026-09-09)
> for the rule now in force. The reasoning here is retained because the
> addendum builds on it.

The maximum real-world timezone offset is UTC+14 to UTC-12 = 26h, plus slack for DST transitions and Zoom-vs-Fireflies start/end-of-call timestamp drift on long sessions. Round to 30h. Beyond that, two recordings are on genuinely different days — recurring meetings would otherwise false-positive against every other instance of themselves.

`rankSiblingCandidates` hard-filters before scoring:

```ts
if (time_delta_minutes !== null && time_delta_minutes > MAX_PLAUSIBLE_TIME_DELTA_MIN) {
  continue;  // drop the candidate, never scored, never returned
}
```

`timeScore` keeps a residual `≤ 30h → 0.2` tier so diagnostic callers outside `rankSiblingCandidates` still degrade gracefully, but the gate makes that branch unreachable in the normal flow.

### Recover-from-YouTube matcher — sharper tiered boost + 90-day hard drop

YouTube uploads happen after recording — the gap is asymmetric and naturally larger than the sibling case. Operators legitimately upload days, sometimes weeks, after a recording (the ADR-016 backfill orchestrator can stretch this to a month). Past 90 days though, the upload almost certainly belongs to a different instance of the same recurring meeting.

Tier table replaces the linear-decay-over-180-days formula:

```ts
function dateBoost(deltaDays: number): number {
  if (deltaDays <= 1)   return  0.30;
  if (deltaDays <= 7)   return  0.20;
  if (deltaDays <= 30)  return  0.10;
  // 30-90 days: negative — within plausibility but past typical
  // publish-lag. Suppresses auto-suggest; remains discoverable in
  // manual "Recover from YouTube" lookups.
  return -0.15;
}
```

Combined with the existing `titleScore × 0.7`:

| Title | Date delta | Old score | New score | Effect |
|---|---|---|---|---|
| 1.0 | 0 days | 1.00 | 1.00 | Unchanged |
| 1.0 | 7 days | 0.90 | 0.90 | Unchanged |
| 1.0 | 30 days | 0.85 | 0.80 | Slightly lower |
| 1.0 | 60 days | 0.78 | 0.55 | Below auto-suggest (0.7) — recurring-meeting false positives suppressed |
| 1.0 | 120 days | 0.70 | (dropped) | Hard-removed |

The clamp `Math.max(0, Math.min(1, …))` keeps the result in `[0, 1]` so a strongly-penalised candidate doesn't go negative and break downstream `score > 0` filters.

## Why two thresholds, not one

The two matchers' inputs have different physical meanings. Forcing both to the same threshold would either be too strict for the YouTube-publish case (operators would lose legitimate manual-recovery options) or too loose for the sibling case (recurring meetings would still false-positive). The bounds reflect operator workflow:

- Two captures of the *same event* shouldn't be more than a TZ-offset apart. 30 hours. *(Addendum 2026-09-09: they shouldn't be on different dates at all — same UTC day, plus a 6-hour midnight-straddle allowance. The principle is unchanged; the bound is tighter.)*
- A recording's eventual *publish* to YouTube can lag by weeks. 90 days.

The shared principle is "a date gap past the workflow-defined bound is a strong NOT-match signal" — and that principle is what's documented here so future matchers can adopt the pattern without re-deriving it.

---

## Addendum: Sibling Gate Is Same-Day, Not 30-Hour (2026-09-09)

**Addendum to**: the sibling half of the Decision above. The recover-from-YouTube half is unchanged.
**Status**: Accepted (implemented 2026-09-09)

### What the original gate got wrong

30 hours is a *plausibility* bound — "could these two timestamps describe the same instant, allowing for the worst timezone skew?" — and the derivation above (UTC+14 to UTC−12 = 26h, plus slack, round to 30h) is sound for that question.

But that is not the question the matcher needs answered. Thirty hours **spans two calendar days**, so the gate admitted pairs that are plainly different meetings:

| Target | Candidate | Delta | Old gate | Correct answer |
|---|---|---|---|---|
| Mon 09:00 UTC | Tue 14:00 UTC | 29h | admitted | different days — reject |
| Mon 14:00 UTC | Tue 14:00 UTC | 24h | admitted | different days — reject |
| Mon 22:00 UTC | Tue 01:30 UTC | 3.5h | admitted | same call across midnight — **admit** |

The original ADR's own prose asserted the opposite of what the code did — "Beyond that, two recordings are on genuinely different days" — but 30 hours is precisely the range in which that stops being true. The recurring-meeting false positive the ADR set out to kill survived at one-day spacing: a daily standup still matched yesterday's instance, since participants and title tokens are identical and only the date differs.

### The rule now in force

A candidate is admitted when it shares a UTC calendar day with the target, **or** when the gap is small enough that the midnight boundary explains it.

```ts
export const MIDNIGHT_STRADDLE_MAX_DELTA_MIN = 6 * 60;

export function isSameEventDay(
  target: string | null,
  candidate: string | null,
  deltaMin: number | null,
): boolean {
  if (deltaMin === null) return true;                    // no date signal either way
  if (sameCalendarDay(target, candidate)) return true;
  return deltaMin <= MIDNIGHT_STRADDLE_MAX_DELTA_MIN;
}
```

`rankSiblingCandidates` hard-filters on it before scoring, in the slot the 30-hour check used to occupy:

```ts
if (!isSameEventDay(targetRecorded, candidateRecorded, time_delta_minutes)) {
  continue;  // drop the candidate, never scored, never returned
}
```

### Why not simply "must share a calendar day"

Because it would break a real case in the other direction. A call running 22:00–01:30 legitimately yields a Zoom start-time on one date and a Fireflies end-of-call on the next — 3.5 hours apart, different UTC calendar days, unambiguously the same event. A flat calendar-day equality test would refuse to link it.

So the calendar day is the rule and the straddle window is the exception, sized to the only thing that can legitimately push one session across midnight: start-vs-end timestamp drift. Six hours covers a long session with room to spare while rejecting any pair that is genuinely a day apart. It is deliberately *not* sized for timezone skew — see the risk below.

### What did not change

- **`MAX_PLAUSIBLE_TIME_DELTA_MIN` still exists**, but no longer gates anything. It now bounds only `timeScore`'s residual `≤ 30h → 0.2` tier, which serves diagnostic callers that score a pair without going through `rankSiblingCandidates`. Open Question 1 below is unaffected — that branch was already unreachable from the ranked path, and the tighter gate keeps it so.
- **`timeScore`'s tiers are untouched.** Gating and scoring stay separate concerns: the gate decides what is offered, the score orders what survives.
- **The recover-from-YouTube matcher keeps its 90-day window.** It compares event time against *upload* time, where a large gap is expected publish lag rather than evidence of a different date. The "why two thresholds, not one" reasoning above applies with more force after this addendum, not less — the two bounds are now further apart because they answer genuinely different questions.
- **Both consumers inherit the change** with no edit: the "Possibly same event" banner and ADR-047's auto-link stage both route through `rankSiblingCandidates`.

### Consequences of the addendum

**Positive**
- Daily and near-daily recurring meetings stop matching the adjacent day's instance — the last surviving case of the false positive this ADR was written to eliminate.
- The gate now means what the original prose claimed it meant.
- `web/tests/siblingMatcher.test.ts` is new; the matcher previously had no test file at all, so neither the original 30-hour gate nor the tiers were covered. Reverting to the 30-hour gate fails three of its cases.

**Negative / risks**
- **A source that reports local time as if it were UTC loses its auto-match.** The 30-hour bound was partly slack for that data-quality failure; six hours across midnight is not. If a platform is found mis-stamping timestamps by more than that, the fix belongs at ingest — normalise the timestamp — rather than by widening this gate back out, which would re-admit the different-day false positives.
- **A session longer than six hours that also crosses midnight** would no longer auto-link its two captures. Rare, and the manual link affordance still covers it. If it shows up in practice, the principled fix is to scale the straddle window by the record's `duration_seconds` rather than to raise the constant.

## Consequences

**Positive**
- Recurring meetings (same hosts, same Zoom room, same agenda template) no longer false-positive against every other instance of themselves.
- The auto-suggest banner stops showing month-old YouTube uploads as "high % match" for unrelated newer recordings.
- Catch-up's auto-link stage (ADR-047) is safer — the hard gate runs upstream of every consumer of these matchers, so silent linking to wrong-date candidates can't happen.

**Negative**
- Operators who deliberately tag a recording with a wildly different `recorded_at` (e.g. backfilling historical content with placeholder dates) lose the auto-match path; they'll need the manual "Recover from YouTube" lookup with the explicit URL/video-id entry, which already exists for this case.
- The 30-day → -0.15 boost in recover-from-YouTube is a parameter that may need tuning if operator workflows shift; surface for adjustment via constant.

**Risks**
- A genuine 35-day-old YouTube upload of a recording (uncommon but possible — e.g. a deferred publish) would now score below the auto-suggest threshold. Operators retain the manual recovery flow with explicit URL entry, so this is a degraded auto-suggest, not a lost capability.

## Alternatives considered

| Option | Rejected reason |
|---|---|
| **Unify into a single matcher** | Forces a single threshold across semantically different cases (event-vs-event vs. event-vs-publish). Would either over-suppress the recover case or under-suppress the sibling case. |
| **Soft penalty (negative score allowed)** instead of hard drop | Candidates with score=0 are filtered by the existing `score > 0` downstream guard, but candidates that go *negative* would still appear if a future caller relaxed that filter. Hard drop at the gate is unambiguous. |
| **Per-record opt-out** | Adds a UX dimension (toggle on every card) for an edge case (deliberate wildly different `recorded_at`). The manual recovery panel already covers it. |
| **Dynamic threshold from operator history** | Tempting but premature — we don't have enough data on operator publish-lag distributions to tune adaptively. Constant + comment is clearer for now. |

## Open Questions

1. **Should the sibling matcher's `≤ 30h → 0.4` and `≤ 48h → 0.2` tiers be tightened?** Now that >30h is hard-gated, the residual 0.2 branch is unreachable from `rankSiblingCandidates`. We left it for diagnostic callers but could remove if no such callers materialise. *(Still open after the 2026-09-09 addendum, which made the gate tighter still — no such caller has materialised, so removing the tier and `MAX_PLAUSIBLE_TIME_DELTA_MIN` with it is now the likelier resolution.)*
2. **Should `MAX_PLAUSIBLE_PUBLISH_LAG_DAYS` be a per-org setting?** Operators with very different publish cadences (real-time live → upload within minutes; vs. quarterly retrospective publishing) might want different bounds. Defer until we see real demand.
3. **A unified `candidateMatching.ts` lib** that hosts the policy doc and both matchers? Possible refactor — would consolidate the parallel "principle + value" comments. Punted to a later cleanup.

## References

- ADR-016: Backfill uploader — establishes the typical recording-to-publish lag patterns
- ADR-033: Multi-origin dedupe / sibling matcher — original scoring rationale; this ADR tightens the time component
- ADR-046: Prompt-driven summaries — surfaces sibling matches in the catch-up + summary flows
- ADR-047: Automated catch-up — its auto-link stage runs through `rankSiblingCandidates`, so this ADR's gate flows transitively through every catch-up run
- `web/src/lib/siblingMatcher.ts`: implementation of the sibling gate — `isSameEventDay` / `MIDNIGHT_STRADDLE_MAX_DELTA_MIN` since the 2026-09-09 addendum; `MAX_PLAUSIBLE_TIME_DELTA_MIN` before it
- `web/tests/siblingMatcher.test.ts`: coverage for the date gate, added with the 2026-09-09 addendum
- `web/src/lib/youtubeUploadsCache.ts`: implementation of the 90d gate + sharper tiered boost
- `memory/feedback_dedupe_threshold.md`: recorded preference for manual bulk-accept in the mid-confidence band — this ADR is the upstream complement that prevents bad candidates from reaching the threshold in the first place
