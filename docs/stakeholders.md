# Video Bridge: Stakeholder Documentation

## Roles as the system actually enforces them

Four roles exist in code, derived from Cloud Identity group membership (ADR-036) and enforced on every request:

| Role | Group | Can |
|------|-------|-----|
| **Admin** | `video-sync-key-admins@<domain>` | Everything, including shared credentials, automation settings and Drive source folders |
| **Publisher** | `video-sync-operators@<domain>` | Curate and publish the whole catalog |
| **Contributor** | `video-sync-contributors@<domain>` | See and write only their own submissions (ADR-065) |
| **Viewer** | `video-sync-viewers@<domain>` | Read the catalog; every mutation is refused |

A user in no group is denied and redirected to the project wiki (ADR-045).

> **Caveat — `Contributor` is enforced at the API boundary only.** The role lattice above lives in `web/src/lib/auth.ts`: group derivation, role ordering and per-request catalog scoping all know four roles. The Rust domain aggregate does not — `UserRole` in `src/catalog/value_objects.rs` has `Admin`, `Publisher` and `Viewer`, with no `Contributor` variant and no serde alias. Submitting a recording works (the `IndexVideo` command carries no actor), but the 23 aggregate commands that *do* carry one reject `"Contributor"` as an unknown variant. Adding the variant is a Rust change plus a WASM rebuild, and it has not been made. Treat anything below that implies a Contributor can mutate their own record after submission as describing intent, not behaviour.

The stakeholder map below is deliberately wider than this table — a Content Owner or an auditor may hold no seat at all, and the system still exists for them.

## Stakeholder Map

### Primary Stakeholders

#### Video Curator / Operator

The day-to-day user of Video Bridge. Responsible for importing recordings, reviewing and approving content, configuring rules, and monitoring the publication pipeline.

**Needs:**
- Single dashboard showing all video across platforms and statuses
- Batch operations (bulk approve, backfill orchestration) to handle large libraries
- Rules engine to automate repetitive triage decisions
- Clear visibility into what published, what failed, and why
- Confidence that no recording was missed or published without review

**Touchpoints:** Dashboard, ImportPanel, RulesPanel, BackfillPanel, EventLog

---

#### Community Contributor

A chapter organiser or guest presenter who submits recordings but does not curate the catalog. Introduced by ADR-065 and live in the role lattice (`video-sync-contributors@<domain>`), with its own page at `/contribute`.

The distinguishing property is scope, not seniority: `GET /api/catalog` returns **only** records whose `contributor_email` matches theirs, and `POST` refuses any record carrying someone else's attribution. A Contributor cannot see, still less publish, the wider catalog.

**Needs:**
- Somewhere to submit a recording that isn't a Discord message a curator has to action by hand
- To see what happened to their submission — ADR-071 §2 keeps a privately-shared Drive file visible at `Discovered` with a pending-curator flag, rather than silently dropping it
- Attribution that survives publication (`contributor_email`, `contributor_chapter`)
- To supply a transcript when the source has none, since Drive and phone recordings arrive without captions

**Touchpoints:** `/contribute`, the URL import box, "Your contributions"

**Not to be confused with** the Viewer role below, or with the Content Owner above — a Content Owner may never touch the app at all, whereas a Contributor is an authenticated user with a (narrow) seat.

---

#### Content Owner / Producer

The person or team that creates the video content (records Zoom meetings, produces webinars, delivers training sessions). May not use Video Bridge directly but relies on it for publication.

**Needs:**
- Assurance that their recordings reach the intended audience (YouTube channel, internal portal)
- Correct metadata: title, description, tags, and participant attribution
- Notification when their content is published (via post-processing webhook or email)
- Ability to request edits to metadata before publication

**Touchpoints:** Indirect — through the curator or via post-processing email notifications (ADR-024)

---

#### Platform Administrator

Manages the external platform accounts (YouTube channel, Zoom account, Fireflies workspace) that Video Bridge connects to.

**Needs:**
- Control over which credentials are used and what scopes are granted
- Visibility into API quota consumption. YouTube allows **six uploads a day** (10,000 units at 1,600 each) and this is now shown on the Overview summary bar beside the completion estimate, counted at the upload route so every publish path is included — backfill, card publish, side-publish and retry. Note this is a different ceiling from a backfill profile's `max_uploads_per_day`, which is self-imposed pacing.
- For Drive folder sources (ADR-078): sharing each folder with the Cloud Run **runtime service account** as Viewer. The app reads Drive as that identity, not as the operator, so a folder nobody has shared with it simply appears empty. Registration probes the folder and names the address to share with rather than failing silently.
- Assurance that credentials are handled securely. Shared platform credentials (Zoom, Fireflies, Kaltura, OpenRouter, OpusClip) live in Google Secret Manager and are managed by Admins (ADR-042). Per-operator YouTube OAuth stays in localStorage by design so brand-account uploads carry the actual operator's identity (ADR-042 §"YouTube brand account"). Every credential write is audited end-to-end via ADR-041.
- Ability to revoke access without disrupting other integrations

**Touchpoints:** ConnectionsPanel, OAuth consent screens, platform admin consoles

---

#### Infrastructure / DevOps Engineer

Deploys and maintains the Video Bridge instance on Google Cloud.

**Needs:**
- Reproducible deployments via `./deploy.sh`. The image builds **remotely** on Cloud Build (`cloudbuild-image.yaml`) — local `docker build` was abandoned because the Next.js + Rust/WASM build wants 6+ GiB and the devcontainer OOMs. `.github/workflows/deploy.yml` is checked in but disabled (push trigger commented out) pending Workload Identity Federation, because the org enforces `constraints/iam.disableServiceAccountKeyCreation`.
- A credential that expires roughly daily. `scripts/login-gcloud.sh` logs in only when needed, and `deploy.sh` runs its `--check` first — an expired token now fails in a second instead of part-way through a six-minute build.
- Observable system: structured logs in Cloud Logging, memory pressure alerts (ADR-032), health endpoint
- Clear resource boundaries: memory limits, instance scaling, quota caps
- Security: no credentials in code, Secret Manager for server-side keys

**Touchpoints:** `./deploy.sh`, `scripts/` (login-gcloud.sh, gcs-fuse-setup.sh, iap-setup.sh, iap-status.sh, check-cloud-identity.sh, gen-adr-index.sh, validate-catalog.sh, mcp-consumer-contract-test.sh, prune-build-artifacts.sh), Cloud Run console, Cloud Logging (audit + request logs per ADR-041, plus `component="ext:youtube-upload"` for publish traces), `/api/health`

**Worth knowing:** the data bucket is the single point of failure for catalog state. It now has Object Versioning enabled with a count-based retention floor (50 noncurrent versions or 14 days, whichever is longer; `videos/` 3 or 7 days; `staging/` expires after 1 day). A time-only rule was rejected — it would delete every version during any quiet period, which is exactly when an old one is most likely to be wanted.

---

### Secondary Stakeholders

#### Compliance / Legal

May need to verify that video content is published with proper attribution, licensing, and data handling.

**Needs:**
- Provenance trail: where did each video originate, who approved it, when was it published
- YouTube description footer with catalog ID, source platform, and parent ID (ADR-022)
- Audit log: structured event log with correlation IDs (ADR-017)

**Touchpoints:** ProvenanceGraph, EventLog (structured view), YouTube video descriptions

---

#### Viewer (in-app role)

Read-only access to the catalog, granted via `video-sync-viewers@<domain>`. Distinct from the audience below despite the shared word — a Viewer is an authenticated colleague who can look at records and is refused every mutation (`POST /api/catalog` returns 403 "Contributor+ required to write records").

**Needs:** to check what has been published and what is queued, without the ability to change it.

**Touchpoints:** Catalog, Overview — every action affordance is absent or disabled.

---

#### Audience

The end consumers of published video content on YouTube or other platforms. Not users of this system.

**Needs:**
- Correctly titled and described videos
- Consistent publishing cadence (backfill orchestrator enables predictable schedules)
- Short-form clips for discoverability (Shorts generation via ADR-029)

**Touchpoints:** YouTube channel, published Shorts

---

#### Downstream Consumers (MCP clients, chapter websites)

Neither operators nor audience: software and LLM clients that read the catalog's artifacts. The MCP server (ADR-066) exposes Show Notes, transcripts, descriptions and provenance as resources and eleven read-only tools; ADR-076 (Proposed) formalises the contract for external sites such as agentics.org rendering the same content.

They matter to this map because they consume the *same* artifacts operators curate, on a contract the catalog must not break casually.

**Needs:**
- A stable shape for Show Notes and descriptions — a rename is a downstream breakage, not just a refactor
- Access scoped to the caller's real role: an MCP bearer token carries a frozen actor (ADR-066 §4), so a Contributor's token sees a Contributor's catalog
- Honest absence — `description-full.md` returns an explanatory error when it hasn't been generated, rather than an empty string that reads as "no content"

**Touchpoints:** `/api/mcp/*`, `vsync://records/…` resources, `scripts/mcp-consumer-contract-test.sh`

**Prospective:** ADR-079 (Proposed) would add a *maintenance agent* as an actor here — the first that acts rather than reads. It is deliberately not in the matrices below, because nothing has been built and an actor with write access deserves its own review when it is.

---

## Stakeholder Concerns Matrix

| Concern | Curator | Contributor | Content Owner | Platform Admin | DevOps | Compliance |
|---------|---------|-------------|--------------|----------------|--------|------------|
| Video discovery & import | Primary | Secondary | - | - | - | - |
| Metadata accuracy | Primary | Secondary | Primary | - | - | Secondary |
| Publication approval | Primary | - | Informed | - | - | Informed |
| Credential security | - | - | - | Primary | Primary | Primary |
| API quota management | Secondary | - | - | Primary | Secondary | - |
| System reliability | Secondary | - | - | - | Primary | - |
| Audit trail | Secondary | - | - | - | - | Primary |
| Provenance tracking | Primary | Informed | Secondary | - | - | Primary |
| Cost management | - | - | - | Secondary | Primary | - |
| Attribution of submissions | Secondary | Primary | Secondary | - | - | Secondary |
| Artifact contract stability | Secondary | - | - | - | Secondary | - |

Contributors hold no column in the concerns that require catalog-wide sight — they cannot see it. Downstream consumers are omitted as a column because their only concern is the last row, and they are not people to be consulted.

## RACI for Key Workflows

| Activity | Curator | Contributor | Content Owner | Platform Admin | DevOps |
|----------|---------|-------------|--------------|----------------|--------|
| Configure platform connections | R | - | - | A/C | I |
| Submit a recording for review | C | R | I | - | - |
| Register a Drive source folder | C | - | - | R/A | C |
| Import video recordings | R/A | - | I | - | - |
| Define ingestion rules | R/A | - | C | - | - |
| Review and approve videos | R/A | I | C | - | - |
| Configure processing rules | R/A | - | C | - | - |
| Run backfill orchestrator | R/A | - | I | C | - |
| Monitor publication health | R | - | - | - | A |
| Deploy new version | I | - | - | - | R/A |
| Rotate credentials | I | - | - | R/A | C |
| Manage role group membership | I | I | R/A | C | - |
| Investigate failures | R | - | - | C | A |

*R = Responsible, A = Accountable, C = Consulted, I = Informed*
