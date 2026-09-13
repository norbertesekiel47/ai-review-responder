# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

> **State map — newest at the top.** Plain-English per-feature summaries of what is
> true now. This is NOT a build log (that's [progresstracking.md](progresstracking.md))
> and NOT a file inventory (that's `.claude/reference/` + [docs/directory.md](directory.md)).
> Older snapshots are archived — see the pointer further down.
> - [progress-archive/currents-history-2026-04-to-05.md](progress-archive/currents-history-2026-04-to-05.md) — pre-2026-05 (the three "Every File In The Project" dumps, April-era feature deep-dives, the stale "What's Left To Build" fossil).
> - [progress-archive/currents-history-2026-05-to-2026-08-14.md](progress-archive/currents-history-2026-05-to-2026-08-14.md) — 2026-05-22 → 2026-08-15 (billing/locations UX through the Architecture pass).

Last updated: 2026-09-13 (Owner Operator T8 merged, #1276; the Operator is ON in staging, off in production).

## Quick summary — Owner Operator T8: LIVE on staging, first live turn fixed, §12.1 checkpoint recorded (2026-09-13, #1276)

`OWNER_OPERATOR_ENABLED=true` on staging on both lanes since 03:04Z (Railway worker + the Vercel `staging` Custom Environment); **production stays off**. Sentry rule 11 (`subsystem:worker_job` AND `queue:agent_turn` → Discord) exists in both projects: staging `3984512`, production `3984518`.

**What the first live turn taught.** It failed `model_output_invalid` on both pinned models: the LLM seam declares no output schema to any provider and validates only after the completion arrives, and the Operator prompt said "the declared schema" without declaring one. Fixed the same hour: the system prompt spells `OperatorModelOutputSchema` (prompt `2026-09-13.1`) and every proposable's `inputShape` rides its `allowedOperations` entry; `prompt.test.ts` and `catalog.test.ts` pin both to the schema. Two open follow-ups in spec §14: hand the schema to the provider per task (`response_format` / tool input) so the shape is a provider guarantee, and give the keyless eval harness one live case per structured task.

**Checkpoint (§12.1, in the spec).** Driven on staging after the fix: a tone Proposal → Apply → accurate Receipt with `businesses.tone` read back; reload resumes the turn, repeat Apply returns the same Receipt, resend returns the same ids; a concurrent settings write → `stale` with Refresh plan, an unknown id → 404, a bumped contract → `contract_changed`. Five completed turns: p50 8.38 s, p95 9.5 s (3 to 5 s of it the outbox poller's claim wait). Constants unchanged with the floors recorded. Waiting on review traffic, a second location and the owner: the next-draft tone check, the secondary-location turn, the COO-roster owner. The auto-approval Apply path is estimated in §13 (14–16 h). Red-team RT-B8 is closed.

**The new shape:** unchanged from Run B, plus `src/lib/agents/operator/__tests__/prompt.test.ts` and the `inputShape` field on every proposable in `catalog.ts`.

## Quick summary — Owner Operator Run B MERGED: Apply, Decline, receipts, the Operator screen — flag still off everywhere (2026-09-13, #1273)

Run B landed on `main` as squash `34857b73b` (02:13Z) after a staging ride at `f96b1a879` proved build and boot with the flag off (Railway worker `/ready` green on Postgres, queue Redis and cache Redis; Vercel staging READY). `staging` was realigned to `main`. No migration, no new dependency, no env var. `OWNER_OPERATOR_ENABLED` is still off in every environment: the server page answers `notFound()`, the routes 404 `operator_disabled` before any write, and the nav entry does not render.

**What an owner gets when the flag turns on.** The **Operator screen** at `/dashboard/operator` (Console/Harbor, inside the authenticated shell). A message posts an **Operator turn** against the location frozen at POST; the screen polls with back-off (2 s → 5 s after 30 s) under an independent 4-minute deadline, and a lost POST response retries the identical submission. Every card is rendered from a STORED row: the **Proposal** card shows the exact before/after of the five voice fields and offers Apply and Not now; `applyProposal` runs one lock-before-check transaction (the `businesses` row, then the proposal; contract version refused before any lock; actor, subscription, offboarding and tier revalidated under the locks; the three-way **Version token** compare text to text) and writes the server-owned **Receipt** in the same transaction — a repeat Apply returns the stored Receipt and executes nothing. A `stale` or `contract_changed` card offers **Refresh plan**, a new turn from the Proposal's original `owner_text`. A **Requested capability** card has no button, by type. The summary panel reads Run A's granular helpers, not the dashboard DTOs (the architecture pass refuted the "reuse" default, H1-D). One `hasImpersonationCookie` and one operator gate (`src/app/api/operator/gate.ts`) serve the three mutation routes; `/api/operator` rides the owner-API AAL2 allowlist.

**The new shape:** `src/lib/agents/operator/{apply,version-token}.ts` · `src/app/api/operator/gate.ts` + `proposals/[id]/{apply,decline}/route.ts` · `src/app/(authenticated)/dashboard/operator/` (page, `OperatorClient`, `ProposalCard`, `ReceiptView`, `SummaryPanel`, `TurnBody`, the hooks `useOperatorConversation` / `useTurnPoll` / `useProposalWrites`, `wording.ts`, `operator.css`) · `src/lib/admin/impersonation/cookie.ts` · glossary terms **Receipt** and **Refresh plan** in `docs/context/owner-operator.md` · e2e `e2e/operator.spec.ts` (self-skips without the auth harness).

**How it was verified.** Plan locked after three Codex rounds; a four-axis review wave (30 findings fixed, 4 rejected with evidence); a red-team run that closed CLEAR and was then preserved as history when two CI fixes (`fallow`, React Doctor) changed production files after the close; a FRESH three-round red-team run over those fixes — 88 rows, 62 killed, one P0 (the Receipt's `before` was unmeasured) and three P1 fixed, two owner authorizations recorded verbatim — CLEAR at `e11aeceda`. Browser evidence at 390 and 1440 for nine states on a throwaway local Supabase stack.

**Still owed before any flag flip (the T8 follow-up PR):** Sentry rule 11 (`subsystem:worker_job` AND `queue:agent_turn` → Discord) in both projects — NOT BUILT; the staging flip through the `flag-flip` skill; p50/p95 of `completed_at - created_at` on staging; the constants tune; spec §12.1 and §15; the open red-team P2 RT-B8 (the refetch on a second message in an adopted conversation has no discriminating test). Spec §14 keeps the two Run A open items (OutboxPoller stranded turn CA1, the predecessor-wait clock CA4).

## Quick summary — Owner Operator Run A MERGED, flag still off everywhere (2026-09-12, #1270)

Run A landed on `main` as squash `d8e3f334f`. Migration 120 is on BOTH Supabase projects (staging 2026-09-12 morning, production at promotion the same day, introspection-verified byte-identical). `staging` was realigned to `main`. `OWNER_OPERATOR_ENABLED` is off in every environment: the routes 404 `operator_disabled`, the `agent_turn` lane fails a dispatched turn with that reason, nothing posts, no executor exists.

**What changed after the review wave.** A fresh red-team run (three rounds) found and closed one real oracle gap — the **Turn claim** lease that stops a second paid model call had no test; the race test now asserts exactly one model call and one billed cost, and a direct `claimTurn` case proves a second claim inside the lease gets nothing — plus two untested branches (`allowedOperations` gate, `budget_exceeded` terminal) and the `agent_turn` alert path: the topic joined `checkFailedOutboxByTopic`'s closed allowlist (the #628 class), the job-failure-sink signal `subsystem:worker_job` + `queue:agent_turn` has runbook rule 11 (**Sentry rule not yet built — required before the flag flips**), and spec §14 states what is and is not alerted. Red-team status CLEAR as a *scope* claim: 237 inventory rows were never mutation-tested and the sidecar says so.

**The new shape (unchanged from the pre-merge summary below):** `supabase/migrations/120_owner_operator.sql` · `src/lib/agents/operator/` · `worker/jobs/agent-turn/` · `src/app/api/operator/{turns,turns/[id],conversation}/route.ts` · `src/lib/responses/voice-settings.ts` · glossary `docs/context/owner-operator.md` · review record `docs/reviews/feat-owner-operator-run-a/` + `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`.

**Owed to Run B's first docs commit:** red-team P2-4 (the runbook triage step reaches the turn through `outbox_id`, not `turn_id`) and the rule-11 Sentry build.

## Quick summary — Owner Operator Run A: the turn pipeline, flag off everywhere (2026-09-11)

The **Owner Operator** — the conversational surface an owner will use to configure RepWorth by talking — exists end to end as a *pipeline*, behind `OWNER_OPERATOR_ENABLED` (server-only, default off, unset in every environment). Spec of record: [`docs/roadmap/2026-09-11-owner-operator/README.md`](roadmap/2026-09-11-owner-operator/README.md); glossary: [`docs/context/owner-operator.md`](context/owner-operator.md).

**What Run A built.** Migration 120's four tables (`agent_conversations`, `agent_turns`, `agent_proposals`, `agent_unsupported_requests`) with deny-all RLS and a hard-delete offboarding disposition. The `agent_turn` outbox topic, queue and typed enqueue helper. A POST route that creates an **Operator turn** and its outbox row in one transaction, plus two account-scoped owner reads. `AgentTurnWorker`, which claims the turn on a 180-second lease, waits for its predecessor with `moveToDelayed` (a wait, not a retry), re-authorizes actor, subscription posture and location from the database, builds a **Context snapshot**, makes one cost-guarded `owner_operator` LLM call, and writes reply segments, **Proposals** and **Requested capabilities** in one **Fenced completion**. The operation catalog registers three reads, four voice proposables and one capture. `src/lib/responses/voice-settings.ts` is now the single transactional writer for a location's voice fields, shared by the settings route and the Operator, with `highlight_facts` in the column map.

**What it deliberately does not do.** Nothing applies. There is no screen, no Apply, no Decline, no receipt, no consequence line, no executor, and none of the three auto-approval operations — so `requires_confirmation` is always false in Run A, because no registered operation widens autonomy. A **Proposal** is a stored row; nothing reaches Google and no `auto_approval_policies` row moves. Those are Run B.

**Two properties worth knowing before touching it.** The snapshot has no *field* that could hold review text, response text or a reviewer name — `sampleResponses` is excluded by type, not by filter — and a pasted review in an owner message is scrubbed on the read path while the stored `owner_text` stays intact. And a zero-row fenced UPDATE means the lease was lost: discard the model output and exit, never retry and never touch the outbox row.

**Flipping it.** Migration 120 must be applied in that environment FIRST — `runContentPurgeStage` names the four tables unconditionally and raises `42P01` at plan time without them — and both lanes read the flag, so it is set in Vercel AND Railway. `agent_turn` is the third flag-gated LLM lane at concurrency 1; ADR 0005's flag-on envelope moved 11 → 12 for it, and a fourth gated lane still forces the global-semaphore conversation.

## Quick summary — Admin home cutover and Overview retirement (#1192 + #1201, candidate)

The configured server-only `ADMIN_APP_URL` supplies the Admin default across login, callback, owner/onboarding redirects, both retained sidebar brand links, and the end-impersonation return. External password-login defaults use full document navigation. MFA keeps its existing local-only `next` rules: the exact `/admin` proxy route relays to the configured home only after the existing session, Admin-role and AAL2 checks, preserving refreshed cookies on the source host. No broad redirect of surviving Admin pages is introduced.

The legacy Overview page/client/tests and their navigation/file pins are removed following the owner's #1225 Page parity approval. All Admin APIs, nav-counts, remaining tranche-4 pages, shared UI and impersonation session behavior remain. The lazy URL accessor validates a configured HTTP(S) origin and never imports server configuration into shared/client auth code. Staging, production rollout authorization and browser limitations are recorded in the [cutover evidence ledger](runbooks/evidence/2026-09-11-admin-home-cutover-staging-evidence.md); this candidate is not a completed rollout.

## Quick summary — legacy business-page retirement (#1202, 2026-09-11)

The legacy business list, detail and new-business pages and their co-located tests are removed after the owner's #1226 Page parity approval and [Admin app PR #10](https://github.com/RepWorth/admin-app/pull/10) merge (`44452f060f78c691cc81188b6bbd05a6d3be82c1`). Navigation, runtime gate tests, file pins and inventory follow the smaller page set. Overview, Jobs and Autonomy preserve business facts and surviving actions while replacing retired business links with plain text and Admin app guidance; no early `ADMIN_APP_URL` read is introduced.

All API routes, shared widgets, impersonation and synthetic audit fixtures remain. The accepted port explicitly substitutes the generated Admin Disconnect endpoint for the legacy cookie endpoint (ADR 0031 D2), and adds the owner's approved exact main-app impersonation link with adjacent account ID. Port screenshots are fixture comparisons; Computer Use remains unavailable and this retirement does not claim live browser verification.

## Quick summary — legacy Security and Runbook retirement (#1200, 2026-09-11)

The legacy `/admin/security` and `/admin/runbook` pages and their page-specific tests are removed after the owner's #1224 Page parity approval and [Admin app PR #3](https://github.com/RepWorth/admin-app/pull/3) merge (`0104047b69aa774e1ebd8a4f70c6f4ef93d82fd2`). The legacy sidebar no longer links to either route. Jobs now directs operators to the runbook in the Admin app in plain text, without reading `ADMIN_APP_URL` before ADR 0029's Overview retirement batch.

The MFA and other Admin APIs, shared enrollment hooks, auth/support pages, and synthetic gate-audit fixtures remain. The unrelated past-replies empty-state assertion survives the runbook hard-pin removal. This is ADR 0031 tranche 1 under the owner's LEAN rule; #1192 and #1203 retain their separate staging and red-team requirements.

## Quick summary — selected editorial landing (2026-09-10)

The local landing route now uses the owner's chosen **F3 composition with F1's Working Atlas roadmap**, between the existing hero and night closing bookend. The courtyard fleet, original CRT agents, five job films, supervision scene and Copilot-left/Autopilot-right lever are retained. Roadmap chapters frame the bright left, darker center and clouded right of the original high-resolution map.

The final polish makes the phone agent index readable below its curved frame, adapts the sticky media to short viewports, keeps agent selection aligned with the visible paragraph, and supplies stills when original media fails. Primary CTAs retain their server-authoritative signup/early-access destination. Comparison controls are absent from `/`.

**The new shape:** `LandingExperience.tsx` composes all nine sections directly; each middle section lives in its own folder (`problem/`, `fleet/`, `personas/`, `jobs/`, `watchdogs/`, `tiers/`, `future/`) with its CSS, and `section-scopes.css` holds the two shared type scopes. Section media lives under `public/fleet/`, `public/jobs/` and `public/tiers/`. The same-day cleanup deleted the `design-*` comparison routes, the exploration component folders, their public assets, and the superseded original middle sections with their helpers (`staged`, `carousel`, `agent-flip-card`, `future-route`); a pixel comparison at eight viewports confirmed `/` unchanged. The [chosen design record](brand-asset-library/collections/2026-09-final/chosen-design.md) owns exact decisions, measurements, verification scripts and limitations. Browser checks use local Chromium and staging; backend lead submission is simulated in the design record's checks.

## Quick summary — job_outbox deny-all RLS, and the staging/prod drift closes (2026-09-07, PR #1175)

`job_outbox` — the Outbox job table, the dispatch spine every async workflow
writes through — was the **only** table of the 54 in schema `public` whose RLS
state differed between the two Supabase projects. Production had it on;
staging had it off, with the public anon key holding all eight privileges.

That was not a disclosure gap alone. `anon` held INSERT, and `OutboxPoller`
dispatches whatever rows it finds to BullMQ without asking who wrote them, so
anyone with the public staging anon key could enqueue an Outbox job of their
choosing. It also held TRUNCATE, which row-level policies do not restrain at
all.

Migration 119 closes it in both lanes: RLS enabled, zero policies,
`REVOKE ALL … FROM anon, authenticated`. The ALTER is guarded on
`relrowsecurity` so the production apply — where the flag was already set —
skipped it rather than taking `ACCESS EXCLUSIVE` on the busiest table in the
schema to write a value it already held.

**The drift is closed for the whole schema, not just this table.** One
identical query over all 54 `public` tables — RLS flags, force flags, ACLs,
policy counts — now returns the same md5 on both projects.

**Provenance.** This is migration 107's deferred half. Production was
provisioned with the Supabase `ensure_rls` DDL event trigger and acquired the
posture for free; staging was created after Supabase dropped it and never did.
107 removed the generator and left its output for a reviewed migration of its
own.

**The new shape**

| File | What it is |
|---|---|
| `supabase/migrations/119_job_outbox_rls.sql` | the migration — guarded ALTER, REVOKE, table comment, one transaction |
| `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` | the boundary's guard. `ci:rls-audit` covers only `TENANT_TABLES`, and `job_outbox` is deliberately not a member, so this suite is the regression guard — the role 117's suite plays for `admin_audit_log` |
| `scripts/ci/live-db-suites-audit.ts` | one line: the suite joins `MIGRATION_SHAPE_FILES`, because it now EXECUTES the migration rather than parsing it |

**Why the test executes the migration.** Five independent red-team passes found
nine P0s — every one in the guard, none in the migration. A regex approximation
of a SQL lexer lost to a new construct each time. The suite now degrades the
table to the pre-119 posture, proves that vulnerable state exists, applies the
checked-in file verbatim, and diffs the catalogue across every `public` table.
PostgreSQL is the parser.

**Not done, tracked as #1176:** 21 production and 20 staging tables still hold
client-role grants behind deny-all RLS, and `anon` holds TRUNCATE on 49 of 50
tables. Inert today for the same reason production's `job_outbox` was inert —
except for TRUNCATE, which that argument does not cover.

## Quick summary — Landing "Where this is going" is a route map (2026-09-06)

Section 5 of the landing page no longer shows four "Planned" cards. It is an
interactive survey chart: a generated dark-green ground, an SVG road, and
fifteen stops — five shipped (run spine, Reply, Solicitor, Review QR, Restraint
tab) lit gold with landmark cutouts; the forward roadmap's locked Phases 1–5
dim on a dashed road; Phases 6–8 plus the two former cards the roadmap does not
name (Social media, Fake review disputes) in fog past a horizon line, on dotted
branches from Phase 5. Each stop is a button that opens a glass card with its
body; below 900px the chart becomes a vertical trail with every body visible.
Honesty devices kept: on-chart "not available yet" legend, `Phase n` / `Later`
markers beside every unbuilt name, future tense on every unbuilt body (pinned
by `FutureSection.test.tsx`). Code: `src/components/sections/landing/future/`;
assets: `public/future/roadmap-ground.jpg`, `public/future/stops/*.webp`;
design contract: `docs/brand-asset-library/design-systems/landing/DESIGN.md` § Future + `measurements.md`.
## Quick summary — Admin MFA events get an audit sink (#468, 2026-09-06; pre-merge)

Admins have `role='admin'` and no `account_id`, and `account_audit_log` requires
one — so every admin MFA event (enrollment, step-up, factor removal) was silently
dropped since the admin enrollment surface shipped (#467). Fixed by a dedicated
sink, not by relaxing the account table.

- **`admin_audit_log`** (migration 117): the admin control-plane actor trail,
  keyed on `actor_user_id`, no account column. Deny-all RLS with zero policies
  AND `REVOKE ALL … FROM anon, authenticated` (RLS filters rows, not table
  privileges). FK with no referential action: deleting a referenced admin
  fails rather than cascading the trail away. Keep forever. Not a
  `TENANT_TABLES` member; `TABLE_DISPOSITIONS` `not_applicable` (the actor is
  always an admin, never an offboarded owner).
- **`writeAdminAuditLog`** joins `writeAccountAuditLog` in `src/lib/audit/log.ts`
  — one writer per sink, both in one file.
- **The MFA route routes by role** through ONE memoised `users` lookup:
  admin → admin sink; owner with account → account sink; anything else →
  Sentry `audit_actor_unroutable`, no row. Best-effort is preserved: an audit
  failure never blocks the MFA action.
- **Enrollment is its own event.** `mfa_factor_enrolled` when the factor was
  `unverified` before `verify` (read from `user.factors`, which `getUser()`
  already returns — no second Supabase call), else `mfa_challenge_succeeded`.
  Every verify payload carries `factor_status_before`. Applies to owners too.
- **Guard:** `ci:rls-audit` only covers `TENANT_TABLES`, so the read-only live
  suite `migration-117-admin-audit-log.integration.test.ts` asserts RLS on,
  zero policies, both client roles denied all four privileges, real-writer
  persistence, and the named-FK rejections.
- Out of scope: an admin viewer (SQL only), auditing enrollment *start* (runs
  in the browser), moving other admin actions into the new sink, and
  populating `ip`/`user_agent`/`request_id` on MFA rows.


## Quick summary — Marketing pages: one system, five jobs (2026-09-06; pre-merge)

The landing, features, and how-it-works pages no longer read as a reply tool.
Each now gives comparable space to five jobs — respond, protect/govern,
request, brief, measure — under the agentic frame (one agent per job, one
permission each, every action on the run spine, two watchdogs, the autonomy
dial).

- **Landing**: a new `jobs/` ledger section between the personas and the
  watchdogs (five equal rows). Hero scope note, problem essay, persona and
  fleet cards, closing CTA, metadata, and the shared `PRODUCT_BLURB` widened
  from "Google reviews" to the five jobs.
- **Features**: 9 chapters in 3 role groups became 13 chapters in 5 job
  groups (Respond · Request · Brief · Measure · Govern). New chapters: Review
  QR, Solicitor, Dashboard (Rep Pulse formula from `REP_PULSE_WEIGHTS`),
  Restraint. Insights pairs the weekly brief with the monthly impact report.
  The group ribbon and index rows size to 1–4 chapters (`--seg-i/--seg-n`,
  `--idx-n`).
- **How it works**: the six-step pipeline stays; a new "loops around it" band
  (Request · Brief · Measure · Record) and three FAQ entries follow it.
- **Contract change (owner decision 2026-09-06)**: Solicitor is present tense
  and `status: 'live'` in the fleet and persona data, on the commitment to
  flip `SOLICITATION_WATCH_ENABLED` + `SOLICITATION_SEND_ENABLED` in
  production (both on in staging). PRODUCT.md, BRAND-KIT §6, the Claude
  project instructions, landing DESIGN.md, and brand-story.md were updated in
  the same change; the Review QR (live, un-flagged) was added to every
  shipped list. Owner channels stay "by email" — Telegram/WhatsApp are off in
  prod and are not named.


## Quick summary — Restraint evidence (#1076/#1077/#1048, 2026-09-05; pre-merge)

The Restraint tab qualifies historical automatic-policy gaps even after
automatic posting is enabled. It also discloses when the bounded archival
history omits older events, independently of refusal totals and entry limits.
Neither fix invents an activation date or backfills a decision.

Solicitation's `already_reviewed` gate uses retained, dated reviews linked to
earlier outreach for the contact at this location. Deleted or undated reviews
do not qualify; spontaneous reviewer matching is outside this change. Consent
and suppression still take precedence, and the existing atomic ask/run/refusal
writer records the decision. Owner copy states this narrower evidence rule.

The shape stays in existing files: `src/lib/refusals/read.ts` owns the archival
overflow fact, the two Restraint components validate and present it, and
`src/lib/solicitation/batch-builder.ts` supplies matched review evidence.
`GhostPipeline.tsx` owns the corrected Requests explanation. No migration,
dependency, or feature flag is added. These changes remain local pending the
guarded verification/review and separately authorized shipping steps.

## Quick summary — **Refusal ledger**: every lane now writes (2026-09-01, PRs #1034/#1044/#1042/#1043/#1049/#1055)

**Every one of the seven Refusal lanes now records its decisions. The table is
written; nothing reads it yet — the reader is the Restraint tab, #1014, and it
is the last slice.**

The closed vocabulary, verified in `src/lib/refusals/vocabulary.ts`:

* **Seven lanes** (`REFUSAL_SOURCES`) — `held_draft`, `auto_post_revoked`,
  `autonomy_suspended`, `ask_withheld`, `outreach_withheld`, `batch_halted`,
  `policy_gate_held`.
* **Eight owner-facing categories** (`REFUSAL_CATEGORIES`), frozen at write
  beside the `vocabulary_version` that froze them.
* **Seven lane category maps.** Six lanes carry one map each, except
  `outreach_withheld`, which has two — its RENDER and DISPATCH writers decide
  different things at different moments. `held_draft` is **the one lane with no
  map at all**, because it has no code axis (constraint C4).

**What each slice added.** #1034 landed the five remaining category maps as a
shared prerequisite, carved out of the three slices that would otherwise have
raced for them. #1010 gave the three solicitation single-site lanes their
writers and added the ledger's **set-based arm** (`writeRefusalEvents`, one
`jsonb_to_recordset` INSERT) — needed because `ask_withheld` can reach 5,000
rows in one build, and looping the single-row helper would put that many round
trips inside a transaction holding the per-Business advisory lock. #1011 wired
the `outreach_withheld` RENDER lane and moved its clock to decision time. #1012
added `auto_post_revoked` and widened `account_id`. #1049 swept the debt those
three deferred. #1013 closed it with `held_draft` and `policy_gate_held`, both
inside the ONE `sql.begin` that carries invariant #4's moderation-hold
atomicity.

**One lane is live in code but silent in production, and that matters for
#1014.** `AUTO_APPROVAL_ENABLED` is `false` in production, which makes
`auto_approval_disabled` a STRUCTURAL gate: `isAutoApprovalCandidate` returns
false, no policy row is read, and `policy_gate_held` writes **zero** rows —
not few, zero. It turns on at position 4 of the ordered go-live flip, never at
a merge. So the **Coverage start** #1014 plans to render from
`accounts.created_at` is not yet honest for that lane. Raised on #1014;
merge ordering alone does not settle it.

**What is left.** Slice 7 of 7 — the **Restraint tab** (#1014): the report, the
archived-location footnote and the archived-period line. Reads render the
STORED `refusal_category` and never re-derive it.

## Quick summary — **Refusal ledger**, slice 1 of 7 (2026-08-30, PR #1019)

**RepWorth now has a place to record the things it decided NOT to do — one row
per decision, written when the decision was made. The table exists; nothing
writes to it or reads it yet.**

A **Refusal** is a *decision*, which is what excludes every neighbour that looks
like one: an owner act is the owner's decision, a delivery failure is an act
that did not land, an elapsed clock weighed nothing, and a Judge verdict is a
post-publication observation. It is **RECORDED, never re-derived** — the parent
effort tried to project this surface over seven tables and could not ORDER it,
because two lanes carry no immutable timestamp of their own. That failure is
why `occurred_at` exists and why it is writer-supplied.

`refusal_events` carries twelve columns, five CHECK constraints, three indexes
and **deny-all RLS** — the last is load-bearing rather than a default:
`all_refusal_codes` is non-owner-facing under ADR 0023, and **RLS filters rows,
not columns**, so an owner-readable policy could not withhold it.

Two constraints encode defects rather than hygiene. **C3** is biconditional
(`business_id IS NOT NULL` ⇔ not `autonomy_suspended`) because joining the audit
log through `businesses` multiplied one account-wide suspension by the location
count. **C5** gained two clauses the locked #1001 shape lacked: with
`refusal_code = 'winner'` against `all_refusal_codes = ARRAY['different', NULL]`
the original expression returned NULL, **and a CHECK passes on NULL** — Postgres
accepted a row lying about its own precedence. Reproduced on a live database
before the fix, and live-fired again on staging at promotion.

**No write site and no read.** The only code naming the table in the same change
is the account-offboarding purge, which must honour the `hard_delete` /
`must_be_absent` disposition the table forces — **no cascade reaches it**, so an
explicit account-scoped DELETE is the only thing that removes these rows.

**What #1009 then added (2026-08-31, #1031).** `src/lib/refusals/vocabulary.ts`
(the two closed axes) and `write.ts` (the ONE insert helper, on
`writeAccountAuditLog`'s model), the `autonomy_suspended` write site inside
`suspendAccountAutonomy`'s existing transaction, the eleventh `ArchivalPoller`
retention arm on `REFUSAL_LEDGER_RETENTION_DAYS = 180`, and a Sentry sink in
`AutonomyGovernorScheduler` — that scheduler is not a BullMQ worker, so
`attachJobFailureSink` never saw its per-candidate failures and a ledger error
would have left an account un-suspended silently every fifteen minutes.

Three things #1009 learned the hard way and are worth carrying: the input type
is a **per-lane union** transcribing CHECKs C1–C4, because a flat record lets a
mis-paired lane raise `23514` and abort the deciding transaction; the kill
switch's warning is rate-limited per **disabled episode** with the structured
log line as the DURABLE transport, because `Sentry.captureMessage` returns on
queue rather than delivery and swallows transport failures; and
`refusal_events`' account FK has no `ON DELETE` action by design, so every
live-DB teardown that deletes an account must clear the Refusal first.

The new shape:
- `supabase/migrations/116_refusal_events.sql` — table, 5 CHECKs, 3 indexes, deny-all RLS
- `scripts/ci/tenant-tables.ts` (**two structures**) · `docs/security/rls-inventory.md`
- `src/lib/account-offboarding/{table-disposition,purge-verification}.ts` ·
  `worker/jobs/account-offboarding/purge-stages.ts` — the purge surface
- `docs/adr/0023-refusal-log-owner-safe-projection.md` ·
  glossary: `docs/context/refusal-ledger.md` → **Refusal**, **Refusal source**, **Refusal category**, **Restraint tab**
- migration **116** — staging + prod 2026-08-30, lockstep, verified identical by
  constraint and index fingerprint

**#1009 SHIPPED 2026-08-31** (#1031) — the insert helper, its
`REFUSAL_LEDGER_ENABLED` kill switch, the `ArchivalPoller` sweep arm and the
first write site. **Superseded — every remaining write site has since
shipped, across #1034/#1010/#1011/#1012/#1049/#1013. See the entry at the top
of this file. Only the Restraint tab (#1014) is left.** #1008 could not say
where the FIRST write site lands and named #1009's PR as the change that
would. **#1009 settled it (D16): the first site is `autonomy_suspended`, one
site inside `suspendAccountAutonomy`, shipped beside the helper — and the rest
followed across #1010–#1013.** The deciding evidence was never the artifact count, which is
tied: it is #1004's verbatim slice order and #1009's ticket body §5.

## Quick summary — **Review QR** (2026-08-26, PR #982)

**Every location can now print a QR code that sends a customer straight to that
location's Google write-review page — through a RepWorth-owned redirect, so a
printed code never goes stale.**

The QR encodes the public **QR redirect** `/q/<businessId>`, which 302s to a
Google write-review deep link CONSTRUCTED from the stored, `isPlaceId`-validated
place id — no stored destination URL, no open redirect, hex CIDs refused. The
gate is `subscriptionAllowsQrRedirect` (`{active, trialing, past_due}` —
`past_due` deliberately keeps an already-printed counter code alive through the
grace window); every refusal (bad id, missing row, archived location,
`pending_payment`/`cancelled`, non-canonical place id) serves one byte-identical
scanner page, with the reason coded in the log only. Each scan best-effort
inserts a `qr_scan_redirected` analytics event AFTER resolve (random event key
per scan — a deterministic key would dedupe and undercount). Owners get the code
at `/dashboard/requests/qr`, with a per-location printable view. Moved out of
Settings by #1092; `/settings/review-qr` now redirects there.

The new shape:
- `src/app/q/[businessId]/route.ts` — the public **QR redirect**
- `src/lib/locations/review-qr.ts` (+ `getQrRedirectRow` in `repo.ts`) — resolve + refusal policy
- `src/app/(authenticated)/dashboard/requests/qr/` — owner surface + print view
  (#1092; `src/app/(authenticated)/settings/review-qr/page.tsx` survives as the redirect)
- `subscriptionAllowsQrRedirect` (`src/lib/shared/subscription-status.ts`) ·
  `qr_scan_redirected` (`src/lib/analytics/events.ts` + `docs/analytics/events.md`) ·
  migration **115** (CHECK widen; staging 2026-08-26, prod 2026-08-27, lockstep) ·
  glossary: `docs/context/review-qr.md` → **Review QR**, **QR redirect**

Post-merge ops (2026-08-27): WAF rule 3c `qr-redirect-per-ip-enforce` (`/q/*`,
30 req/60s per IP → 429) published + burst-verified — the redirect writes one
durable `analytics_events` row per anonymous scan (adversarial finding A2,
accepted ops gate; `docs/runbooks/vercel-waf-rate-limiting.md` Component 3).

## Quick summary — #631 **Auto-approval lane** (2026-08-24, PR #950)

**Autopilot accounts can now let solicitation send batches approve themselves — with an
owner veto window before anything sends. Every gate is OFF in every environment.**

The ask-generation finale approves a batch as `approval_method='auto_policy'` only when
four conditions hold (both server flags, full subscription access, the Autopilot tier,
no account-wide Governor suspension) AND the owner's opt-in policy row exists — decided
once, never on regeneration; a racing owner approval wins quietly. The owner then gets a
**Veto notice** (email/Telegram/WhatsApp, batch-scoped, tokenless CTA to
`/dashboard/requests`); the FIRST provider-accepted send starts the veto window, and the
**Veto anchor** release phase stamps the deadline once, fail-closed per D9 — no sent
notice, no anchor, no release, ever. Every release tick re-checks the conditions and
downgrades a lapsed batch back to owner review with the exact reason (flag off, tier
lost, policy removed, suspension). Judge stays release-owned (#900); the pre-existing
dead-sweep liveness blind spot is **CLOSED** (#949, migration 118) — `isJudgeHealthy` reads a durable
`judge_sweep` heartbeat and fails closed without one, which is also why flipping `JUDGE_ENABLED` on
costs a ≤60s warm-up window of downgrades.

The new shape:
- `src/lib/solicitation/auto-approval.ts` — condition gate, `auto_policy` verb, **Veto anchor**
- `worker/jobs/solicitation-veto-notice/` — the notice worker family (pending-post-notice clone)
- `src/lib/auto-approval/solicitation-settings.ts` + `settings-guards.ts` — opt-in lane + shared write-guards
- migration **113** (index-only; applied staging + prod 2026-08-24, lockstep) ·
  `SOLICITATION_AUTO_APPROVAL_ENABLED` default OFF · glossary: `docs/context/solicitation-send-mode-breaker-release-attribution.md` → **Auto-approval
  lane**, **Veto notice**, **Veto anchor** (LOCKED)

Deploy-inert proven on staging 2026-08-24 (clean boot, flags confirmed OFF). #633 owns
the ordered go-live flips.


## Quick summary — #900 **Solicitation release poller** (2026-08-23, PR #920)

**The loop that decides which approved messages are allowed to go out today — and the
thing that finally lets a wedged send batch close by itself.** One
Postgres-state-driven poller, five phases in a fixed order, every 60 seconds.

```
phase 1  unknown sweep      an Outreach row stuck `sending` past 60 min with no in-flight
                            outbox row → terminalize `unknown` + Sentry alert.
                            THIS IS WHAT DISCHARGES #915's BLOCKER.
phase 2  send_window_elapsed a batch past its 72h send window → Halt latch, no actor
phase 3  batch_expired       a batch never approved inside its 7-day window → same latch
                            (makes the 11-day `stalled` alert unreachable, not just unlikely)
phase 4  RELEASE             Send breaker → platform ceiling → account cap → per-child.
                            The ONLY phase `SOLICITATION_SEND_ENABLED` gates.
                            Outreach rows CAS `rendered → queued`, one send job each.
phase 5  backstop join       a second CALLER of `closeBatchIfSettled`, never a second
                            implementation
```

**"Flag off" does NOT mean "poller idle", and that is deliberate.** The flag suppresses
phase 4 only. Gating the whole cycle would strand a batch flipped off mid-drip with
`queued` rows forever, and migration 091's one-active-send index would then block that
location permanently — the exact wedge phase 1 exists to clear.

**No migration** — 091 and 110 already carried every column, CHECK member and index.

**Still inert in production.** `SOLICITATION_SEND_ENABLED` is off everywhere. This merge
removes #915's *blocker*; the flip itself is a separate decision.

The new shape:

| File | What it owns |
|---|---|
| `src/lib/solicitation/release.ts` | The deep module. `runReleaseCycle` (the five-phase order), `sweepSystemHalt` (one body, both clock-driven sweeps), `runAccountArm` / `runBatchArm` (the two isolation units), `capacityStop` (the three capacity gates asked once). |
| `worker/background/pollers/SolicitationReleasePoller.ts` | Composition root. Owns `sql`, the interval and the guarded-poll scaffolding — and nothing else. Deliberately does NOT read the send flag. |
| `src/lib/solicitation/approval.ts` | Gains `latchSystemHalt`, the Halt latch's THIRD arm — the one with no actor, which migration 091's halt-consistency CHECK enforces by requiring `halted_by IS NULL` for exactly its two reasons. |
| `src/lib/shared/job-outbox-helpers.ts` | Gains `enqueueSolicitationSend`, the typed enqueue for the release → send handoff. |

**One env var:** `SOLICITATION_RELEASE_POLL_INTERVAL_MS` — optional, 60s default. It
rejects one more class than its `JUDGE_POLL_INTERVAL_MS` precedent: a value at or below
the 45s cycle timeout is invalid, because a hung cycle must free the single-flight flag
before the next tick.

## Quick summary — #899 **Solicitation send worker** (2026-08-22, PR #912)

**The first code in this repo that can put a real email in front of a real customer.**
It is merged and inert: `SOLICITATION_SEND_ENABLED` is off in every environment, and
**it must stay off until #900 ships** (see the blocker below).

What it does, per job, for one **Outreach row**:

```
tx1 (short): stale-attempt guard → per-business advisory lock → batch row → outreach row
             → seven-item Dispatch gate → consent snapshot → Lazy child
             → unsubscribe token mint → CAS queued → sending
provider:    NO lock held. Idempotency key = the outreach row id.
             Retryable failures absorbed IN-PROCESS, while the raw token is still in scope.
tx2 (short): CAS sending → sent|failed  +  child terminal  +  solicitation_sent outcome
             +  outbox completion  +  closeBatchIfSettled      ← ONE transaction
```

**No migration** — #898's migration 110 already carried this family's schema work.

The new shape:

| File | What it owns |
|---|---|
| `src/lib/solicitation/dispatch.ts` | The deep module. `applyDispatchGate` (pure, owns B6's order and the withheld-reason mapping) and `dispatchOutreach` (the orchestrator). |
| `src/lib/solicitation/send-retry.ts` | `classifySendFailure` — D12c's terminal/retryable split, pure. |
| `worker/jobs/solicitation-send.ts` | Composition root. Extract the outbox handle, call one domain function. |
| `worker/jobs/solicitation-send/failed-hook.ts` | The only writer of `send_exhausted`. Picks its terminal by arrival status. |

**Four behaviours worth knowing** (a reader of amendment B6 alone would get each wrong;
all four are now recorded upstream as **B15**):

1. The two SLOW gate items (re-lint, re-moderation) run **above** `tx1` with no lock held —
   re-moderation is a ~10s provider call. `tx1` then proves the locked bytes still match the
   ones those verdicts were computed over, so the guarantee is checked rather than assumed.
2. A row already `sending` is **never re-gated and never re-sent**. The raw unsubscribe token
   died with the crashed process, so no correct message can be rebuilt.
3. A flag-off **defers**; it never terminalizes. 091/110 carry no `flag_off` withheld reason.
4. The exhaustion hook writes `unknown`/`send_indeterminate` for a `sending` row, not `failed` —
   calling a possible send "not sent" can put that customer in a future batch and email them twice.

> **⚠️ Enablement blocker — issue #915.** #899's recovery path for a crash between its two
> transactions IS #900's D12d `unknown` sweep. Until that ships, a dead process leaves a row
> in `sending` that nothing can terminalize: the batch never settles and the one-active-send
> index blocks every future batch for that location. Merging was safe; **flipping the flag is not.**

## Quick summary — #898 **Send governors** (2026-08-21, PR #904)

**Nothing here sends mail, and that is the point.** #898 ships the schema and the
three governors that #899 (the send worker) and #900 (the release-side consumer)
will stand on, so those two land without a migration between them. Today the
breaker can trip, page and be reset — but nothing reads it on the send path yet.

**The asset being protected is the Sending identity** — one `reviews@` mailbox and
one sending domain that every account sends through. That is why the **Send
breaker** is a platform singleton and not a per-tenant dial: one account's bad
contact list burns the deliverability everyone else is sending on. It is **not**
the **Halt latch** — that stops one batch; this stops all sending, everywhere.

**Three governors:**

- **Send caps** — a platform ceiling and a per-account daily cap, counted on
  UTC days.
- **Send breaker** — a rolling 7-day window that trips above a **2% hard-bounce
  rate** or a **0.3% complaint rate**, and never below 100 sends. The
  `HealthAlertPoller` is its only tripper, so a trip lands within one poll
  interval (5 min).
- **Bounce discrimination** — the Solicitation lane now records `bounce_kind`
  beside `bounced_at`, because the breaker must count hard bounces only.

**Three things that surprise people:**

- **The window is not a cohort.** The denominator is send-dated, the numerators
  are signal-dated, so a burst of bounces from a send nine days ago still trips
  it and the ratio can exceed 1.0. That is deliberate — the intuitive cohort
  measure dilutes a fresh bad batch with sends whose bounces have not landed,
  which is the fail-*open* direction.
- **A reset is a bounded half-open probe, not a re-arm.** Resetting moves the
  window's lower edge to that instant, so only post-reset activity is measured
  and the breaker stays quiet until 100 fresh sends accumulate. Roll
  `SOLICITATION_PLATFORM_DAILY_CAP` down *before* resetting — the ceiling is the
  only thing bounding how much mail leaves during the probe.
- **An open breaker is a STATE, not an event.** It re-pages every tick while it
  stands, under a constant title so Sentry collapses the repeats. One dropped
  page must never equal a silent platform-wide halt.

**It never self-clears.** The only thing that closes a trip is an admin at
**Safety → Send breaker** (`/admin/solicitation`), with a mandatory note enforced
both by the route and by migration 110's `reset_consistency` CHECK — so "who
cleared this, and why" cannot be unanswerable by omission. The latch table is
append-only with at most one open trip, because a second breach would otherwise
overwrite the very record someone reviews after the fact.

**The cost of a trip, which is easy to miss:** the breaker and the 72-hour send
window run on different clocks and nothing reconciles them. A trip that stays
open for days converts every batch approved in the 72 hours before it — across
every account — into `cancelled` / `send_window_elapsed`. That is a recorded
trade (amendment B14): a cancelled batch is an honest terminal state an owner can
act on; the alternative buries the trip under a stalled-batch alert storm.

**The new shape:**

| File | Role |
|---|---|
| `supabase/migrations/110_*.sql` | withhold vocabulary, `bounce_kind`, the latch table |
| `src/lib/solicitation/send-breaker.ts` | window read model, trip, fail-closed read, reset |
| `src/lib/solicitation/send-caps.ts` | ceiling resolver, account cap, UTC-day counters |
| `worker/background/pollers/health-alert/checks.ts` | the only tripper; isolated so a write failure cannot discard the other findings |
| `worker/ingress/resend/solicitation-lane.ts` | records `bounce_kind` |
| `src/app/admin/solicitation/**` | the reset surface (Island system, AAL2) |
| `docs/runbooks/solicitation-sending-domain.md` §8 | the operational procedure |

**Operational note:** all send flags stay OFF. Migration 110 is applied to
staging **and** production — lockstep complete, no standing exception.

## Quick summary — #872 **Ask withdrawal** (2026-08-18, PR #883)

**Until today, an owner who spotted one wrong message after approving a batch
had exactly one lever, and it cost them the whole cohort.** The **Halt latch**
stops a batch; it does not spare the other contacts, and because a halted ask
keeps `status='send'`, everyone in that batch is `over_contacted` for
`MIN_GAP_DAYS` — so a rebuild inside 30 days withholds them all. The cost of
one bad message was every message.

**Ask withdrawal is the cheap lever.** The owner taps `Withdraw` on a single
row; that one **Outreach row** goes `cancelled` / `owner_withdrawn` and nobody
else in the batch is affected. It is legal in exactly the **Batch states** where
the latch would have cancelled that row — `veto_window`, `approved`, `sending`
— and the row itself must be `rendered` or `queued`, **never `sending`**: halt's
"no further sends, not undo" contract is inherited whole rather than re-argued.

**It only ever moves toward restraint.** It removes a message; it never adds,
replaces or edits one. That is why it needs no re-lint, no re-moderation and no
per-ask approval state (the batch stays approved, `approved_at` and the veto
clock untouched), and why it does not reopen ADR 0020, whose subject is
*replacing* approved bytes: a message that does not send cannot violate **Owner
approval**'s byte-for-byte guarantee. ADR 0021 records that argument.

**What it does not do:** it does not release the contact. A withdrawn ask keeps
`status='send'` exactly like a halted one, so that person stays
`over_contacted` for `MIN_GAP_DAYS`. The saving is the *other* contacts — one
lost instead of the cohort.

Two details worth knowing:

- **It is keyed on the ask, not the row.** The verb resolves the live attempt
  under the batch lock, so a stale tab still withdraws the right message.
- **Idempotence outranks the state gate.** Withdrawing the last live row settles
  the batch, so a retry on that very row arrives in `closed` — it still answers
  "already withdrawn" (a fact about the row) rather than a 409 about the batch.

The new shape:

| Where | What |
|---|---|
| `supabase/migrations/109_outreach_owner_withdrawn_disposition.sql` | Widens 108's cancel arm by one value, `owner_withdrawn`. Applied to **staging and production** in lockstep on merge day; all three databases (local, staging, prod) carry a byte-identical constraint. |
| `src/lib/solicitation/approval.ts` | `withdrawAsk` — the fifth human-triggered verb, appended beside approve / halt / adminHalt / regenerate. Same lock order as the latch (advisory batch → batch row → outreach row → spine), one transaction, one `ask_withdrawn` step, then `closeBatchIfSettled`. The decision itself is the pure `classifyWithdrawal(state, attempt)`. It deliberately does **not** share #865's private `latchHalt` — the latch writes `halted_at` on the batch and withdrawal writes nothing there. |
| `src/app/api/dashboard/solicitation/batch/withdraw/route.ts` | Thin route over `withScopedBatch`; `{ batchId, askId }` body read by the hoisted `readBatchAsk` (now shared with regenerate). 200 withdrawn · 200 already-withdrawn · 409 not-withdrawable / not-live · 404 not-found. |
| `src/app/(authenticated)/dashboard/requests/AskList.tsx` | `WithdrawableAskList` — a third sibling list. Per live row a `Withdraw` control behind an inline two-tap confirm; the read-only `AskList` stays structurally unable to render a control. |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | New `withdrawable` display facet, the `useArmedWithdrawal` hook (one armed row at a time; disarms when a refetch drops the row), and copy that announces the **server's** remaining count — never a client-side subtraction, because the client cannot see an in-flight row. |

## Quick summary — #665 purge-verifier blind spots · #662 suppressions console (2026-08-18, PR #882)

**Two low-severity defects filed off earlier ships, both about a system telling
the truth about itself. Nothing a customer could see was broken; what was broken
was the machinery that would have told us if it were.**

**#665 — the account-purge verifier was not checking everything the purge
clears.** When an owner deletes their data, one stage tombstones their business
rows and a second stage re-reads them to confirm nothing survived. The re-read
listed 17 columns. The tombstone cleared 22 — including the owner-attested
**physical postal address** and its four attestation columns. Nothing leaked:
the write side really did clear them. But had a future change stopped clearing
them, verification would have said "clean" and the purge would have completed.
The verifier now covers every column the tombstone writes — the five postal
columns the issue named, plus `category`, `tone`, both Stripe identifiers and
`archived_at`, which no issue had named.

This matters more than a detector usually would, because the verifier runs
*inside* the finalize transaction and **throws**. It is a gate, not a report: a
purge that fails verification does not complete.

**#662.1 — a receipt that outlived its own truth.** On `/admin/suppressions`, an
admin who recorded an opt-out saw a green receipt. If they then corrected that
record, the lookup panel updated to "Not suppressed" while the receipt directly
below still read "Already suppressed — no change." Two panels, one screen,
opposite claims about the same address. The receipt is now cleared whenever a
correction settles the ledger — including the already-removed case, which
*returns* rather than throws and is therefore just as settled. A correction that
genuinely **fails** deliberately leaves the receipt and the row alone.

**#662.2 — `PRIOR CORRECTIONS` showed a raw UUID.** The audit trail answered
"who removed this?" with `6b7a3503-1257-4f79-8e5e-6af46527f0a9`. It now shows
`Name (email)`, falling back to the raw UUID when the user row is genuinely
gone. No foreign key was added: a compliance record must outlive every referent
it names.

**One documentation fix that is really a warning.** A comment claimed the new
`users` join needed no tenant-scope exception because it was "structurally
scoped". It is not. `users` is not in the audit's table list at all, so
`ci:tenant-scope` never formed an opinion about it — a green audit is not a
review of a join it cannot see. What makes the join safe is its shape: one
primary-key lookup per correction, behind the admin MFA gate, returning staff
identity and never tenant data.

**The new shape**

| File | What it is now |
|---|---|
| `src/lib/account-offboarding/purge-verification.ts` | The `businesses` residue predicate covers all 27 tombstoned columns. Two are not residue checks: `tone` compares with `IS DISTINCT FROM` because the tombstone restores a schema default on a nullable column, and `archived_at IS NULL` is a violation because the tombstone *sets* it. |
| `src/lib/admin/suppressions-service.ts` | `lookupSuppressions` `LEFT JOIN`s `users` and returns `removedByUserLabel`. |
| `src/app/admin/suppressions/SuppressionsClient.tsx` | Renders the label; the correction mutation calls `entry.reset()`. |
| `scripts/ci/tenant-scope-allowlist.ts` | Corrections entry re-pinned for the new query shape. Baseline unchanged at **381**. |

No migration, no env var, no feature flag, no new dependency, no new file.

## Quick summary — #865 admin **Halt latch** surface (2026-08-18, PR #876)

**RepWorth support can now stop a customer's send batch from the admin console.
Until this shipped, `admin_halt` was a permitted value in the database that no
code could ever write — a live-but-dead enum arm, and the owner-facing copy for
it had already shipped with nothing behind it.**

What an operator gets: a Send batch panel on `/admin/businesses/[id]` showing the
batch's **Batch state**, how many messages a stop would cancel, how many are
already in flight, and how many are already delivered — never a subject or body.
When the batch is stoppable, a required free-text note plus a stop control.
Stopping is AAL2-gated, writes `halt_reason='admin_halt'` with the acting admin's
id, cancels the `rendered`/`queued` messages, and leaves anything already sent
alone. The owner then sees the already-shipped line: "RepWorth support stopped
this batch."

Three things worth knowing:

1. **Two halt arms, one body.** `haltBatch` (owner) and `adminHaltBatch` (support)
   both delegate to a private `latchHalt` that owns the CAS, the cancellations,
   the audit row, the spine step and the join, in that order. The admin arm's
   reason is fixed by the caller's identity, so no request field can name it.
2. **Neither arm will stop an unbuilt batch.** That was originally scoped as a
   known owner-side hole to fix later, until review showed it was reachable
   through the ordinary owner API — the backend hands out the unbuilt batch's id
   and the endpoint accepts it. Halting an unbuilt batch corrupts the lifecycle
   inside the *builder's* later transaction, far from the request that caused it.
3. **The panel does not show the newest batch, deliberately.** It shows the one
   still capable of sending, then any built one, then the newest. Both departures
   from "newest" were found by real defects: a newer still-building batch can
   legally coexist with the batch actually dispatching, and stopping a batch is
   exactly what makes it stop looking live.

The new shape:

| File | Role |
|---|---|
| `src/lib/solicitation/approval.ts` | `latchHalt` (shared private body) + `adminHaltBatch`, its second writer |
| `src/lib/solicitation/batch-view.ts` | `readAdminBatchSummary` — the admin read projection and its deliberate ordering |
| `src/app/api/admin/solicitation/batch/halt/route.ts` | the AAL2-gated operator entry point |
| `src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx` | the panel |

No migration — every value already existed in migrations 091 and 108.

## Quick summary — #860 per-ask **Ask regeneration** surface (2026-08-18, PR #873)

**The owner can now ask for a new version of one message in a built batch — and
can no longer ask once they have approved it. That second half is the point.**

Before this, `regenerateAsk` existed in the worker but nothing on screen could
reach it, and it accepted four batch states including `approved`. #629 shipped
the approval lane on top of that and had to record the contradiction as a
deviation: **Owner approval** promises "what you approved is byte-for-byte what
sends", while a regenerate path could in principle replace approved bytes. It was
unreachable, so #629 could defer it. #860 builds the reachable path, so the
contradiction had to be settled.

**It was settled by refusing.** `isRegenerableBatchState(state) => state === 'built'`
(ADR **0020**, narrowing cross-spec amendment B2), checked twice — once before the
work starts, once again under a row lock inside the swap, so a batch approved in
the gap between them still cannot be overwritten. The byte-for-byte guarantee is
now **unconditional**, in code and in `CONTEXT.md`.

**What the owner sees** (once the lane is switched on — see "ships inert" below):
a Regenerate control on every rendered ask while the batch is still approvable,
with "N of 3 today" beside it. It disappears on held-back messages and once the
batch is approved. It is disabled on messages they have deselected, while another
rewrite is in flight, and once that ask has spent its three. The copy is explicit
about the boundary: *"You can ask for a new version of any message, but you cannot
write one yourself."* Editing stays forbidden (D22) — the owner's verbs are
approve, exclude, and ask for new bytes.

**The honest cost, found by this PR's own review.** ADR 0020 first called the
post-approval recourse — stop the batch, build a new one — "a real ergonomic
cost". That was wrong. Halting never clears `solicitation_asks.status='send'`, so
a rebuild inside 30 days withholds those contacts as `over_contacted`, and by the
time the gap clears the visit is stale for every vertical but home services. The
cohort is lost for that visit, not delayed. The ADR now says so, and **#872**
tracks the cheaper recourse (withdraw one message inside the veto window, which is
removal rather than replacement and so does not reopen the guarantee).

**Ships inert.** `SOLICITATION_SEND_ENABLED` is unset in every environment, so the
route 404s, the send lane is null, and no control renders. Verified on the staging
worker at merge. Do not flip it — the boot assert needs four vars that do not exist
there, and the sending identity is **#633**, still open.

### The new shape

| File | What it does now |
|---|---|
| `src/lib/solicitation/ask-generation.ts` | Owns the D3 decision: `isRegenerableBatchState` — `built` only |
| `src/lib/solicitation/approval.ts` | **Three** owner verbs now — `approveBatch`, `haltBatch`, `requestAskRegeneration` |
| `src/app/api/dashboard/solicitation/batch/regenerate/route.ts` | **New.** Fourth adapter at the `withScopedBatch` seam; 404s when the flag is off |
| `src/lib/costs/tracker.ts` | `peekAskRegenBudgetBatch` — advisory, fail-open; the worker's Lua INCR stays authoritative |
| `src/lib/solicitation/batch-view.ts` | Send lane reports `regeneratingAskId` + `regenBudgets` |
| `src/app/(authenticated)/dashboard/requests/AskList.tsx` | The per-ask control + counter |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | Exclusions keyed on `askId`; `LaneRefresh` tells the parent whether a write is terminal |
| `docs/adr/0020-regeneration-refused-after-approval.md` | **New.** The decision, and its corrected cost |

## Quick summary — #859 `ci:tenant-scope` reads query blocks · #858 case-safe batch closure · #861 read-failure copy pin (2026-08-17, PRs #870, #868, #869)

**The three follow-ups #629 filed on its way out have all landed, and the one
that mattered most changed how a security gate reads SQL.**

**#859 (PR #870).** `ci:tenant-scope` used to blank every parenthesised `SELECT`
before it read predicates, so a correctly-scoped `NOT EXISTS`, scalar subquery,
`LATERAL` or CTE body was indistinguishable from an unscoped one — and #629 had
to contort `approval.ts` and `batch-view.ts` into scanner-shaped joins and split
statements just to be seen. The audit now lexes SQL once (strings, dollar
quotes, nested comments, `${…}` placeholders) and proves **every physical
tenant-table binding in every query block** — CTE bodies, `EXISTS`/scalar/
`LATERAL` children, every set arm. A child inherits scope only through an
explicit account/business identity equality to a proven, unshadowed ancestor;
row-id correlation, siblings, `OR`/`NOT` fail closed. Two rules the branch review
added before merge: a scope predicate counts **only on a column the table
physically carries** (`TENANT_SCOPE_COLUMNS`, asserted against
`information_schema` — inside a subquery PostgreSQL resolves a missing column to
the OUTER row, so `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` restricts
nothing), and an alias re-bound in an intermediate block hides the same-named
ancestor from every descendant. Every finding now carries a stable
`sqlIdentity`; `--no-allowlist` prints the same occurrence proof for triage.
`ALLOWLIST_BASELINE` **397 → 381** (17 obsolete "scanner cannot see" entries
removed, one honest admin exception added — a false negative of the OLD parser).
`approval.ts` and `batch-view.ts` are back to their natural SQL.

**#858 (PR #868).** `closeBatchIfSettled` lowercases its batch id once; a
mixed-case request id can no longer strand a Settled batch with a running Send
parent (`agent_runs.subject_id` is TEXT — case-sensitive — while every `::uuid`
cast normalises). Fixed in the callee for all seven callers, ahead of #630's
releaser tick.

**#861 (PR #869).** The Requests load-failure card is pinned: a read failure may
not claim "nothing was sent" or "nothing changed" — any tense. Test only.

**The new shape**

| File | What changed |
|---|---|
| `scripts/ci/tenant-scope-audit.ts` | Rewritten (942 → ~2,100 lines): PostgreSQL-aware lexer, query-block analyzer, JS template lexer, `sqlIdentity`, `--no-allowlist`. |
| `scripts/ci/tenant-tables.ts` | Gains `TENANT_SCOPE_COLUMNS` — the per-table scope-column map the audit consults. |
| `scripts/ci/__tests__/tenant-tables.integration.test.ts` | **New.** Read-only live-DB suite: the map must match `information_schema` at migration head. |
| `scripts/ci/tenant-scope-allowlist.ts` | 397 → 381 entries. |
| `src/lib/solicitation/approval.ts` | One-statement lock with a correlated scalar send-parent lookup; readiness gate is `NOT EXISTS`. |
| `src/lib/solicitation/batch-view.ts` | Send-lane counts are two independent scalar aggregates on the lifecycle row. |
| `src/lib/solicitation/outreach.ts` | `closeBatchIfSettled` canonicalizes its batch id. |
| `docs/security/tenant-isolation.md` | Describes the block analyzer, the column rule, and the identity format. |

**Still open from #629's list:** #860 (per-ask regenerate surface, in flight —
merge order was #859 first, done) and the admin/support halt surface (#865).

## Quick summary — #629 owner approval lane (2026-08-17, PR #863)

**An owner can now approve a batch of review requests, drop individual ones
before they go, and stop a batch outright. Nothing sends yet.**

The screen at `/dashboard/requests` gains an approval panel. The owner sees every
drafted message, un-ticks any they do not want sent, and approves the rest in one
action. Un-ticking is the only edit available — a message is either sent as
written or not sent at all. Approving starts a 15-minute undo window; "Stop this
batch" ends the batch for good, with no resume.

**This ships inert.** `SOLICITATION_SEND_ENABLED` is unset in every environment,
and the thing that actually delivers the messages is #630. With the flag off the
Requests screen is exactly the watch-mode screen it was before.

Three rules decide the whole design:

- **You can only approve what is finished.** Every request in the batch must have
  a drafted message before approval is allowed, re-checked inside the approval
  transaction. That is what makes "what you approved is what sends" true — no
  message can appear after approval and go out unseen. *Finished* means "not
  cancelled", not "successfully drafted": a message held back by moderation is a
  finished attempt with nothing left to draft, so it does not block approval.
  Requiring a clean draft would wedge any batch that had one lint failure.
- **Dropping a request only ever removes a message.** It never adds or changes
  one, which is why it needs no re-check of the content, and why partial approval
  is safe even though editing a drafted message is forbidden. Drop every request
  and the batch is approved and closed in the same breath.
- **Stopping is one-way.** Approve, drop and stop are the owner's only verbs.

### The new shape

| File | What it owns |
|---|---|
| `src/lib/solicitation/approval.ts` | **New.** `approveBatch` (approval + per-request exclusion in ONE transaction) and `haltBatch` (the owner's stop). Neither closes the batch itself — both call the existing `closeBatchIfSettled`, so batch closing keeps one owner. |
| `src/app/api/dashboard/solicitation/batch/{approve,halt}/route.ts` | **New.** Thin routes over those two verbs. |
| `src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts` | **New.** One runner shared by the three batch routes. |
| `src/app/(authenticated)/dashboard/requests/{ApprovalPanel,AskList,ApprovalActions}.tsx` | **New.** The panel, the per-request list, the buttons. |
| `src/lib/solicitation/batch-view.ts` | Gains the send-lane read the panel renders from. |
| `supabase/migrations/108_outreach_owner_excluded_disposition.sql` | Lets the database record "the owner dropped this one". Applied to staging **and** production 2026-08-17. |

**Known gaps, all filed:** `closeBatchIfSettled` compares ids case-sensitively and
was fixed here for these two verbs only — **#858**, which must be resolved before
#630 (**landed** the same day, PR #868 — the callee now canonicalises for every
caller). Per-request re-drafting has no owner entry point — **#860** (in flight).
The admin/support stop surface exists in the database as a permitted value with
nothing that writes it — since filed as **#865**.

## Quick summary — #657 email adapter + solicitation webhook lane (2026-08-17, PR #853)

**The machinery to send review requests by email now exists, and nothing calls
it.** That is deliberate. #657 shipped three pieces that only meet at the
adapter, all of them inert until #630's dispatch worker arrives.

- **Messaging adapter** — a channel-neutral send seam with exactly **one** method,
  `send`. `EmailAdapter` (Resend) is its first and today only adapter; a WhatsApp
  adapter would be a *second adapter*, never a rewrite. It has **zero production
  callers**, which is an accepted trade (map decision 14) mitigated by keeping the
  interface to one method over the spec's already-locked envelope.
- **Sending identity** — review requests send from `reviews@feedback.<env>.repworth.net`
  on their own `feedback.` domain with their own API key, deliberately separate
  from the transactional sender. The point is blast radius: a key leaked from this
  lane **cannot forge an approval email or mint an approval link**. Three new
  server-only env vars, all fail-closed, and a boot assertion that refuses to
  start a worker with sending enabled and no From address.
- **Solicitation lane** — a branch of the Resend webhook ingress chosen by an
  echoed `lane=solicitation` tag **before any database lookup**. It records
  bounce, complaint and provider-suppressed facts onto the **Outreach row** and
  writes `global`-scope rows to the **Suppression ledger**, in one transaction.
  Its write surface is deliberately narrow — never `delivery_status`, `sent_at`
  or `unsubscribed_at`, which belong to other owners.

**Nothing sends yet and nothing can.** `SOLICITATION_SEND_ENABLED` is off in every
environment, and no Outreach row carries a `provider_message_id` until #630 sends —
so the lane's discriminant cannot match in production. The existing
`notification_deliveries` webhook path is byte-for-byte unchanged apart from two
imports and one guard clause.

**The new shape:**

| Where | What |
|---|---|
| `src/lib/messaging/messaging-adapter.ts` | the seam: `MessagingAdapter` (one method), `OutboundMessage`, `getMessagingAdapter()` |
| `src/lib/messaging/email-adapter.ts` | `EmailAdapter` — the whole envelope, plus the header-injection and one-recipient guards |
| `src/lib/messaging/lane-tag.ts` | the `lane`/`solicitation` discriminant, **import-free** so the ingress never loads the Resend SDK to read two strings |
| `worker/ingress/resend/solicitation-lane.ts` | the lane: discriminant, locked attribution lookup, seven event effects, one transaction owner |
| `worker/ingress/resend/bounce-classifier.ts` | the bounce classifier, moved out of `resend.ts` intact so "what counts as permanent" keeps one owner |
| `docs/runbooks/solicitation-sending-domain.md` | domain, DNS, DMARC, mailbox, warm-up — **authored here, executed at #633** |

**Still open:** the DMARC `rua` address is an unresolved input (spec §12) and #633
cannot create the DNS record without it. The `provider_message_id` index is
deliberately deferred to #630, which produces the rows.

## Quick summary — Architecture pass 2026-08-15, executed (2026-08-16, PRs #836–#841)

**The code was healthy; the tests were the story.** The entropy counter hit 6, a
Pathfinder pass ran over the two portals + onboarding funnel (6 features + 1 seam,
671 nodes, `docs/reviews/PATHFINDER-2026-08-15/`), and six handoffs were executed the
same day, each in its own sibling worktree, each merged only after the full local
gate (lint · typecheck · 17 audits · parallel project · fallow · integration lane
against a head-provisioned DB) **and** a seven-way merge simulation passed.

**What is true now:**

- **Invariant #3's auto-policy gate chain has a tripwire** (#836). One table-driven
  suite over `LOCKED_GATE_CHECKS` denies each gate independently — judge, runtime,
  veto, moderation, `approval_method` — plus a completeness test that fails if a gate
  is added without a denial row. Before: deleting the judge check left 32/32 green.
  Fifteen guards passing for the wrong reason (mutation-verified) are now pinned;
  zero production lines changed.
- **`ci:admin-aal2` is an AST audit** (#837). Per-handler, call-not-mention,
  fail-closed, and admin pages are in scope under **read-gate parity**. An unused
  import no longer clears the gate; a gated `GET` no longer launders an ungated `POST`.
- **The live-DB CI lane is pinned** (#840) — and the pass's own claim that it was
  "inert in CI" was **wrong**: CI has run all 91 integration suites since #244. What
  was missing was a pin on the wiring; four YAML lines could un-gate 92 suites and stay
  green. `ci-audit-wiring.test.ts` now fails on any of them.
- **Trial eligibility and the primary-scoped `onboarded_by` read each have one owner**
  (#838, rode staging: worker + UI deployed clean, 3/3 checkout smokes PASS vs Stripe
  test mode). `isTrialEligible` is the strict form the docs already recorded;
  `primaryOnboardedBySql` replaced three spellings, one of them unscoped. Tenant-scope
  allowlist **396 → 394 → 392** across #838/#839 (two provable scopes, no suppressions).
- **`HealthBadge` and churn derivation have one owner each** (#839). The detail page's
  private `Record<string,…>` copy — which rendered an unknown level silently green —
  is gone; `churnMetricsQuery` + `churnScoreFromMetrics` in `business-summary.ts`
  serve all three admin surfaces. The `as unknown as DetailData` cast is gone too.
- **The Voice tab reads multi-location MODE from the server** (#841, invariant #9b),
  plus a behaviour-preserving bundle (two 2-wide dashboard reads sequenced, six
  duplications folded, dead `withRateLimit`/`withSession` deleted, the owner shell's
  missing `role` check added).

**Process:** the sweep-miss mechanization is confirmed working (last three log entries
written by the skill). New class found: an *uncounted* PR (#803) deleted the `/feature`
skill's entire step 8 — the surface three earlier prescriptions targeted. Handoff-
execution PRs are now explicitly **not counted** toward the threshold (policy written
into `arch-review-log.md`). Counter reset to 0.
