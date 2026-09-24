# RepWorth — Progress Tracking

> **Human changelog — newest at the bottom.** This is the detailed build history.
> Agents looking for current state should read [currents.md](currents.md); for
> load-on-demand detail read [.claude/reference/](../.claude/reference/).
>
> **Older history is archived** to keep this file readable (live entries start at
> "2026-09-06 — Admin MFA audit trail #468"):
> - [progress-archive/progresstracking-2026-04_sprints-1-to-6.md](progress-archive/progresstracking-2026-04_sprints-1-to-6.md) — Sprint 1 → Sprint 6 (2026-04-06 → 2026-04-17)
> - [progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md](progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md) — Channels → Multi-location (2026-04-20 → 2026-05-22)
> - [progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md](progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md) — CI Keystone → Ask withdrawal (2026-05-24 → 2026-08-18)
> - [progress-archive/progresstracking-2026-08-21-to-23_send-governors-to-release-poller.md](progress-archive/progresstracking-2026-08-21-to-23_send-governors-to-release-poller.md) — Send governors → Solicitation release poller (2026-08-21 → 2026-08-23)
> - [progress-archive/progresstracking-2026-08-24-to-31_auto-approval-to-refusal-slice-3.md](progress-archive/progresstracking-2026-08-24-to-31_auto-approval-to-refusal-slice-3.md) — Auto-approval lane → Refusal ledger slice 3 (2026-08-24 → 2026-08-31)
> - [progress-archive/progresstracking-2026-08-31-to-09-06_refusal-sweep-to-landing-route-map.md](progress-archive/progresstracking-2026-08-31-to-09-06_refusal-sweep-to-landing-route-map.md) — Refusal ledger sweep → Landing route map (2026-08-31 → 2026-09-06)

---

## 2026-09-06 — Admin MFA audit trail #468 (local, pre-merge)

- Migration 117 `admin_audit_log`: actor-keyed admin control-plane trail,
  deny-all RLS + client-role REVOKE, two indexes, no-action FK, keep forever.
- `writeAdminAuditLog` beside `writeAccountAuditLog` in `src/lib/audit/log.ts`.
- `factorStatusBefore` (pure, over `user.factors`) in `src/lib/auth/mfa.ts`.
- MFA challenge route: one memoised actor lookup; audit routed by role
  (admin / owner / unroutable → Sentry); `mfa_factor_enrolled` vs
  `mfa_challenge_succeeded`; `factor_status_before` on every verify payload.
- Tests: 11 new route cases (admin path, enrollment vs step-up, unroutable,
  best-effort), helper unit tests, and the read-only live suite for 117.
- Registries/docs: `REVIEWED_NOT_TENANT_SCOPED`, migrations-log (head 117 +
  retention row), rls-inventory, directory rows, MFA reset runbook § Audit.
- Plan reviewed by Codex (gpt-6-astra), 4 rounds → APPROVED; the review moved
  the factor lookup off the network and added the REVOKE + live suite.

## 2026-09-06 — Route map: the header becomes the map's title (local, pre-merge)

Owner rejected the seam between the dial section and the route map. The
section now has no padding from 1280px up: the chart starts at the section's
top edge, fades up from ink over a title band (top 36%), and the header —
eyebrow, heading, lead, closing quote, legend — sits over that band inside
the reading column. The stage grew to 2000×1440 so the road stays under the
title; below 1280px the header stacks above the chart as before.

## 2026-09-06 — Route map: the phone trail is an accordion (local, pre-merge)

Owner: "not optimized for the phone, it stretches for so long, not functional".
Below 900px each stop is one row (glyph, marker, name, chevron); a tap opens
the hint under it, one at a time. Touch handling fixed alongside: the hover
path ignores touch pointers, blur closes only when focus leaves the list, and
focus opens a row only when no pointer caused it. Section height at 390px:
~2,300px → ~1,500px.

## 2026-09-07 — `job_outbox` deny-all RLS, migration 119 (#1171, PR #1175, squash `7a1484a9`)

**The defect.** `job_outbox` was the only table of the 54 in schema `public`
whose `relrowsecurity` differed between the Supabase projects: production true,
staging **false**, zero policies on both, with `anon` and `authenticated`
holding all 8 privileges on both. RLS off plus `anon` INSERT is not a
disclosure bug alone — `OutboxPoller` dispatches whatever rows it finds without
asking who wrote them, so anyone holding the public staging anon key could
enqueue an Outbox job. `anon` also held TRUNCATE, which row policies do not
restrain.

**Provenance.** Migration 107's deferred half. Production (2026-04-05) shipped
with the Supabase `ensure_rls` DDL event trigger; staging (2026-05-30) was
provisioned after Supabase dropped it. 107 removed the generator and
deliberately left its past output for a reviewed migration of its own.

**Shipped.**

- `supabase/migrations/119_job_outbox_rls.sql` — one transaction:
  `SET LOCAL lock_timeout = '5s'`, a `DO` block issuing
  `ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY` **only when
  `relrowsecurity` is false**, `REVOKE ALL … FROM anon, authenticated`, a
  `COMMENT ON TABLE`.
- `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` —
  the boundary's guard, five cases.
- `scripts/ci/live-db-suites-audit.ts` — the suite joins
  `MIGRATION_SHAPE_FILES`.
- No production TypeScript, no env var, no feature flag, no dependency.

**Why the ALTER is guarded.** `ATExecSetRowSecurity` has no early-out and
`AT_EnableRowSecurity` takes `ACCESS EXCLUSIVE`, so an unconditional statement
would block every write to the busiest table in the schema — on production, to
set a flag already set. `REVOKE` takes no relation lock. Measured: under a
concurrent `AccessShareLock` holder the guarded file completes in ~53–64 ms,
against ~5,070 ms to `lock_timeout` unconditional. On the production apply the
guard correctly skipped: its first real exercise.

**Why `BEGIN` + `SET LOCAL`.** `SET LOCAL` is effective, no session GUC leaks,
the lock window is minimal, and the ALTER and REVOKE become atomic. 109 and 114
are the precedent — 10 of the 11 `SET LOCAL` migrations wrap; 088 is the sole
unwrapped file and the only source of the "can only be used in transaction
blocks" warning that briefly misled the first draft.

**Applied, and lockstep proven by hash.** Staging 2026-09-07T11:42Z, production
2026-09-07T12:0xZ, byte-identical SQL, staging first, verified by introspection
and never the ledger. One identical query over all 54 `public` tables on each
project — `relname | relrowsecurity | relforcerowsecurity | relacl | policy
count`, ordered and md5'd — returns `3404cf07434a4d4ad9670f62ce573556` on
**both**; the `job_outbox` row alone hashes `40ec5814b6fcc41430af78ddf13d101a`
on both; the table comment is byte-identical (md5 `7b88d544…`, 228 bytes). On
both projects: `anon` + `authenticated` 16 privileges → **none**;
`service_role` 8 → 8 unchanged; owner 8 → 8 unchanged. Post-apply the OWNER read
rows WITH RLS enabled on both (46 staging, 4 production) — the direct proof that
RLS does not block the worker, which is the single assumption the migration
rests on.

**Registries: none change.** `job_outbox` stays `REVIEWED_NOT_TENANT_SCOPED` and
out of `TENANT_TABLES` (owner decision, taken after measurement).
`TENANT_TABLES` membership also switches on `ci:tenant-scope`, which demands an
`account_id`/`business_id` predicate on every binding; the table carries neither
column and 55 files under `src/` + `worker/` bind it in SQL. `ci:rls-audit`
therefore does not cover this table, and the suite is the guard.

**The review, which is the story of this branch.** Five independent red-team
passes plus four review axes returned findings across seven rounds. **Nine P0s
were found and every one was in the test, never in the migration** — which all
five passes independently confirmed correct.

| Pass | P0 | Root cause |
|---|---|---|
| 1 | owner-privilege arms unfalsifiable | the container owner is a superuser; `has_table_privilege` is a constant for one |
| 2 | `GRANT … TO PUBLIC` escaped | the ACL guard filtered on grantee NAME; PUBLIC is OID 0 |
| 3 | column grant to an inherited role escaped | the intersection two arms left open |
| 4 | three lexical evasions | `/**/`, `--` inside a string literal, comment-as-evidence |
| 5 | off-target DDL passed | the case read one table; `GRANT` on another sailed through |

Pass 4's verdict ended the pattern: *the approach is wrong, not merely
incomplete — a hand-rolled regex approximation of a SQL lexer keeps losing to
the next construct nobody enumerated.* The guard was rebuilt to **execute** the
migration: degrade `job_outbox` to the pre-119 posture, assert that vulnerable
state exists so the case cannot pass vacuously, apply the checked-in file
verbatim through `db.unsafe`, then assert RLS, force, policies, client
privileges, that the owner and `service_role` are **unchanged against the
before-reading**, and that **no other table in `public` moved**. Every vector
from all five passes is re-run and killed.

Four axes independently killed one false claim: that production had "run this
exact posture for five months". It had run the RLS half only and still held the
client grants, so the empirical argument never covered the REVOKE — the one
statement that could break the worker. The rollback plan was also wrong in a
way worth remembering: it would have run `DISABLE ROW LEVEL SECURITY` on
production, dropping it BELOW its own pre-119 baseline and manufacturing the
staging vulnerability there mid-incident. It is now per-environment.

**Workflow record.** Two surface amendments of two used, both with stated
reasons: `arch-review-log.md` (required by `ci:merge-ledger`) and
`live-db-suites-audit.ts` (the apply-and-assert rebuild). The `/feature`
`reviewed` transition was **not** set and was not forced — `red-team-status.mjs`
correctly refuses it, because each pass's fixes moved the tree past the sidecar
it was written against and the intake was amended twice. The five passes'
reports under `docs/reviews/red-team/1171-*/` and the four axis reports under
`docs/reviews/fix-1171-job-outbox-rls/` are the evidence instead. Full
deviation record: `docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md`
(D1–D21).

**Not done, tracked as #1176.** 21 production and 20 staging tables still carry
client-role grants behind deny-all RLS — including `auto_approval_policies` and
the agent run-spine tables — and `anon` holds TRUNCATE on **49 of 50** tables.
Inert today for the same reason production's `job_outbox` was inert, except for
TRUNCATE, which that argument does not cover. The issue also carries the
`rls-inventory.md` reconciliation and six sibling suites that repeat a
whitespace-literal guard weakness.

## 2026-09-10 — chosen marketing landing and final polish (local, pre-merge)

Final render follow-up: `hero/hero.css` now makes the hero copy immediately visible under reduced motion, even before hydration. The existing hook's transition update did not cancel an entrance already in progress. The source record is the 2026-09-10 frontend lab note; the final browser driver checks both pre-hydration and hydrated computed styles.

Implemented the owner-selected F3 narrative with F1's Working Atlas on the public landing route, preserving the original hero, CTA and footer. The selected composition and its defining details are recorded in [chosen-design.md](brand-asset-library/collections/2026-09-final/chosen-design.md), with the four-way design history and media provenance beside it.

The working tree's route supplies `FinalMiddle` F3 plus `FinalRoadmap` F1 to `LandingExperience`. Previous iterations added the chosen problem/fleet/agent/job/supervision sections and generated five job films plus lever/activity footage. Owner corrections fixed the watchdog arch's media containment, mapped Copilot left and Autopilot right, skipped Autopilot's stationary source lead-in, and rendered the roadmap's three chapter crops from the original 3840px image at 1.75× zoom.

The last refinement changes `final-iteration/final.css`, `synthesis/loop/index.tsx`, both synthesis media helpers, `footer/LandingFooter.tsx` and composition comments in `LandingExperience.tsx`. The mobile CRT index now sits below the curved frame with four 44px controls. The sticky screen fits short viewports; selection uses its measured bottom and responds to resizing. Headings balance, small supporting text is more readable, original media failures keep their stills, and the reduced-motion footer mask changes without interpolation. No extra visitor controls or dependencies were added.

Verification artifacts include the selected interaction/responsive reports, seven-section desktop and phone captures, and the new `verify-polish.mjs` / `polish-results.json` for all public navigation, keyboard agent controls, original media failure and a simulated lead-intake error/retry/success journey. The latter intercepts the request; it sends no real lead or email. Source checks and exact browser coverage are documented in the collection. Native Computer Use/WebKit are unavailable; Chromium results do not claim Safari coverage. This is a local implementation record, not a merge or production deployment. No feature flag, schema, backend behavior or architecture merge counter changed.

**Cleanup (same day, local).** The exploration code moved out of the tree. Deleted: the four `design-*` comparison routes; `sections/landing/{directions,exploration-v2,synthesis,final-iteration}/` (the agent's `design-loop/` notes included); the comparison-only assets in `public/landing-*`; and the superseded original middle sections with their helpers (`staged.tsx`, `carousel.tsx/.css`, `agent-flip-card.tsx/.css`, `future/future-route.ts`) and those helpers' tests. The selected sections now live in their own folders — `problem/`, `fleet/`, `personas/`, `jobs/`, `watchdogs/`, `tiers/`, `future/` — each with one stylesheet; `section-scopes.css` holds the two shared type scopes, and `LandingExperience.tsx` renders the sections without a `story` slot. The variant overrides (M1/L1/L2/F3) and the `final.css` refinements are folded into the base rules with the same result. Section media moved to `public/fleet/`, `public/jobs/` and `public/tiers/` (checksums unchanged); the lever files lost their reversed names. Evidence: a production build captured at eight viewports (360–1800px, reduced motion) before and after — all 128 scroll slices are pixel-identical, no request fails, and the only state-capture differences trace to film decoding and the removed `#final-roadmap` scroll margin (reapplying it reproduces the baseline exactly). The section tests were rewritten for the new components.

**Stale-code pass (same day).** A per-module import check and a CSS rule check against the live staging page found what the first cleanup orphaned. Removed: `fleet/fleet-copy.ts` and the pre-existing unused `reveal.tsx`; the `.rw-lp-glass` block and the unused `--rw-lp-section-gap` token in `landing-experience.css`; the old section headings and labels in five copy files; and the data fields no section reads (personas `publishes`/`status`, jobs `tone` with its `data-tone` attribute, the old map's stop coordinates and legend). Stale comments now match the page — including the pause rule's (no keyframe animation remains under `sections/landing/`). The landing DESIGN.md and measurements.md describe the current sections and assets; their dated notes stay as history.

## 2026-09-11 — retire legacy Security and Runbook (#1200)

After the owner's #1224 Page parity approval and Admin app PR #3 merge (`0104047b69aa774e1ebd8a4f70c6f4ef93d82fd2`), removed the two legacy pages, Security's client/tests, the runbook-only consent tests, their sidebar entries, palette pin, and inventory rows. Kept the unrelated past-replies empty-state check. Repaired Jobs' obsolete runbook link with the approved plain-text direction to the Admin app; no early `ADMIN_APP_URL` read. All API routes, shared MFA hooks, impersonation, and synthetic gate-audit fixtures are untouched. The owner accepted the port evidence limitations on #1224; this retirement adds no claim of Computer Use verification, which remains unavailable.

## 2026-09-11 — retire legacy business pages (#1202)

After the owner's #1226 Page parity approval and Admin app PR #10 merge (`44452f060f78c691cc81188b6bbd05a6d3be82c1`), removed the three legacy business pages and co-located components/hooks/tests. Pruned their navigation/exclusion, palette/star-file pins, runtime page-gate imports and inventory; retained shared breadcrumb and surviving-page coverage. Overview, Jobs and Autonomy keep business facts and recovery actions but replace retired links with plain text and Admin app guidance, without an early `ADMIN_APP_URL` read. API routes, shared widgets, impersonation and synthetic gate fixtures remain unchanged. The port's approved Disconnect route substitution and exact main-app link/account ID addition are explicit scope decisions, not hidden route parity. Computer Use is unavailable; the owner's accepted port evidence remains fixture comparisons.

## 2026-09-11 — Admin home cutover and Overview retirement candidate (#1192 + #1201)

Applied the approved batch after #1202: server-only `ADMIN_APP_URL` feeds the eleven redirect/default sites and both retained sidebar brand anchors. Trusted external password-login defaults and successful end-impersonation returns use full document navigation; the existing untrusted `from`/`next` restrictions remain. The exact gated `/admin` proxy relay gives MFA an internal return path and keeps expired challenges in the Admin login flow. Both actual end-button render paths receive the server-provided destination, without changing impersonation API/session semantics.

Removed only the legacy Overview page/client/co-located tests and affected navigation/file pins. All APIs, shared UI, nav-counts and the ten remaining page retirements stay in place for their ordered tickets. Added harmless test/build CI URL fixtures and both environment inventories. The [staging campaign ledger](runbooks/evidence/2026-09-11-admin-home-cutover-staging-evidence.md) owns deployment provenance and remaining verification; the candidate still requires the single review pass, one red-team pass and staging release before merge. Computer Use remains unavailable; no source-login browser verification or production rollout is claimed here.

## 2026-09-11 — Owner Operator **Run A**: the turn pipeline (`feat/owner-operator-run-a`)

The first code for the **Owner Operator**, the conversational surface an owner will use to configure RepWorth by talking. Spec of record: `docs/roadmap/2026-09-11-owner-operator.md` (§15 carries the matching review-log entry); glossary: `docs/context/owner-operator.md`. **Inert on arrival** — `OWNER_OPERATOR_ENABLED` is server-only, default off, and unset in every environment.

**What shipped.** Migration **120** — `agent_conversations`, `agent_turns`, `agent_proposals`, `agent_unsupported_requests`, deny-all RLS, and the hard-delete offboarding disposition with its `runContentPurgeStage` arm. The `agent_turn` outbox topic, queue and typed helper (a plain INSERT: `job_outbox` has no generic in-flight index, 004/018 are per-topic). `src/lib/responses/voice-settings.ts`, the shared transactional voice writer, with `highlight_facts` and the settings-route extension. The v1 catalog — three reads, four voice proposables, one capture. The model-output schema, the semantic validator and the **Pasted-review scrub**. The `owner_operator` LLM task (reply-generation pair, `maxTokens: 1200`, `temperature: 0.2`; the MODEL question stays open at the checkpoint). The **Turn claim** / predecessor-wait / **Fenced completion** protocol and `AgentTurnWorker`. The POST turn route and the two account-scoped owner reads. ADR 0005's flag-on LLM envelope moved 11 → 12 for the third gated lane, at concurrency 1.

**NOT built, deliberately:** the screen, Apply, Decline, receipts, the consequence line, asymmetric friction, the three auto-approval operations, and any executor. `requires_confirmation` is therefore always false in Run A, because no registered operation widens autonomy. All of that is Run B.

**Two design facts worth keeping.** The **Context snapshot** has no *field* that could hold review text, response text or a reviewer name — `sampleResponses` is excluded by type, not filtered — so a leak is a compile error rather than a missed branch. And a zero-row fenced UPDATE means the lease was lost: discard the model output and exit, never retry and never touch the outbox row, which belongs to the attempt that holds the lease.

**Process.** Plan hardened over three Codex rounds (round 3 APPROVED with one untriaged note, carried into T5). Two surface amendments: #1 pulled the pre-existing `src/app/api/settings/voice/__tests__/route.test.ts` into T2's lease, because extracting the writer moved the behaviour 8 of its cases pinned; #2 created `docs/directory/lib-owner-operator.md`, because `lib-platform.md` and `lib-reviews-responses.md` were both at exactly 3,000 words and the eleven new `src/lib` rows had nowhere else to go. Full record: `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md`.

**Before any flip:** migration 120 must be applied in that environment FIRST — `runContentPurgeStage` names the four tables unconditionally and raises `42P01` at plan time without them — and BOTH lanes read the flag, so it is set in Vercel AND Railway.

## 2026-09-12 — Owner Operator Run A merged (#1270, squash `d8e3f334f`): fresh red-team run, `agent_turn` alert path, migration 120 on both databases

**Merge and promotion.** PR #1270 squash-merged at 10:55Z with every required check green (`fallow` included, which had failed at the previous head until the fallow-gate refactor `15bc4a4aa`). Migration 120 applied to production `udeyaqnvpojbwgoaxwdg` with the file's SQL in one transaction and verified by introspection against staging: four relations, RLS on / FORCE off, 0 policies, no `anon`/`authenticated` privileges, seven `pg_get_constraintdef` strings byte-identical, three indexes. `staging` realigned to `main` by one server-side force-with-lease push of `d8e3f334f` over `493c65970` (no local `reset --hard` needed).

**Before the merge — session 2 of the `/feature` run.** `origin/main` was taken BEFORE the adversarial pass (one docs-only commit; the PR was `BEHIND`, so the update was owed at merge time anyway and taking it first costs one gate run, not a second red-team pass). Fresh red-team run because the closed three-round run was voided by the fallow refactor and by intake amendments #3/#4: round 1 at `5b223e33f` — 1 P0, 7 P1, 1 P2; fixes in `3a377f656`; round 2 re-killed every guarded line (the round-1 lease survivor now fails three tests); round 3 (owner-authorized, doc-only) closed two wording defects. **Surface amendment #5** added `worker/background/pollers/health-alert/checks.ts`, its unit test and `docs/runbooks/beta-launch-alerting.md` so the alert path could be fixed in the same PR. Final status CLEAR at `7583062a4` with the round-2 scope rule applied explicitly (237 never-executed rows `excluded`, reason on each row). `reviewed` was set by hand under owner authorization after `transition-state.mjs` refused on a summary section in the deviations file that had no `**Verdict:**` line; the re-verification diff (two doc files, zero code past the red-team head) is recorded in the deviations closeout entry.

**Open, non-blocking.** Red-team P2-4 (runbook triage step names `turn_id`; the Sentry event carries `outbox_id`); the rule-11 Sentry alert for `subsystem:worker_job` + `queue:agent_turn` is documented but NOT built — required before `OWNER_OPERATOR_ENABLED` goes on anywhere. Both ride Run B's first docs commit.

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-12):** the red-team runner's 3-round cap plus "an amended intake voids the sidecar"; the round-2 inventory scope rule; the deviations auditor reads every `## ` section; `pnpm ci:fallow:coverage` is the CI signal, not `ci:fallow`.

## 2026-09-13 — Owner Operator Run B merged (#1273, squash `34857b73b`): Apply, Decline, receipts, the Operator screen; fresh red-team run over the CI fixes

**Merge and promotion.** The branch rode `staging` first as a plain fast-forward to `f96b1a879` (02:05Z): the Railway staging worker redeployed (SUCCESS at 02:07Z; `/ready` 200 with `postgres`, `queue_redis`, `cache_redis` ok) and the Vercel `staging` custom environment built READY at `staging.repworth.net` — build and boot proof with the flag off, which is all a flag-off ride can prove. PR #1273 squash-merged at 02:13Z with every required check green (`fallow` and `react-doctor` included). `staging` realigned to `main` at `34857b73b` by a `--force-with-lease` push of the merge commit (no local reset). Worktree removed by `scripts/feature-cleanup.sh`; the run's `.feature/` ledgers were archived before removal. No migration; no env var; no flag flip anywhere.

**What landed (production).** `src/lib/agents/operator/apply.ts` (`applyProposal`: contract check before any lock; one transaction locking the `businesses` row then the proposal; `revalidateActor` under the locks; the three-way text **Version token** compare; the operation's own fields through the shared voice writer; `buildReceipt` writing the server-owned **Receipt** in the same transaction; sibling pending Proposals marked `stale`; repeat Apply returns the stored Receipt), `version-token.ts`, `declineProposal`; `src/app/api/operator/gate.ts` (`requireOperatorWriter` / `requireOperatorProposalWriter`, order flag → same-origin → writable owner → impersonation → uuid) serving `turns` and `proposals/[id]/{apply,decline}`; the conversation read's `?locationId=`, `connectionStatus`, `location_not_found` and per-turn `unsupported`; the Operator screen under `src/app/(authenticated)/dashboard/operator/` (server page `notFound()` when off; `OperatorClient` decomposed into `useOperatorConversation`, `useTurnPoll` with a module-level `startTurnPoll`, `useProposalWrites`, `useTurnSubmission`, `useOperatorUrl`; `ProposalCard` + `ProposalState`, `ReceiptView`, `SummaryPanel`, `TurnBody`, `wording.ts`, `operator.css`); the `operator` `NavSection` and the six-tab mobile bar gated by a server prop; one `hasImpersonationCookie` (`src/lib/admin/impersonation/cookie.ts`); `/api/operator` on `isProtectedOwnerApiRoute`. Tests: 51 promised titles plus the review-round additions, two fast-check properties, `apply.integration` and `reads.integration` live-DB suites, `e2e/operator.spec.ts` with its SQL worker stand-in.

**Review.** Plan locked by owner call after three Codex rounds (11 + 7 + 1, all accepted). Wave at `dba7af671`: spec 7, standards 13, Codex adversarial 3, red team 11 (P0: the docs claimed Sentry rule 11 BUILT; it was not). Fix commits `64f9de864` / `aa7fd157a` / `cd4710b4b`; red-team rounds 2–3 closed CLEAR at `ef9b3a7ca` with RT-12 accepted as risk (AUTH-3). Rejected with evidence: RT-09, RT-10, RT-14; standards F7; F11 later REVERSED by CI's fallow duplication gate (the `gate.ts` helper, surface amendment #4).

**After `reviewed`.** The first CI run failed `fallow` (10 unused exports, 6 complexity findings, 3 route-preamble clones) and React Doctor (`effect-needs-cleanup` on a self-rescheduling poll timer). Fixed in `99975e2e9` and `79f695d53`. Those two commits touched production files after the red team closed, so a resumed session (`/feature-resume`) preserved the closed run as `…-fec8cf-rounds1-3/`, rotated the journal and ran a FRESH three-round red team scoped to `git diff ef9b3a7ca..79f695d53 -- src` under the owner's verbatim authorization. Round 1: RT-B2 **P0** (the Receipt's `before` could be swapped for the after-state; the only assertion was `not.toHaveProperty('updatedAt')`), RT-B1/RT-B3/RT-B4 P1, RT-B5/RT-B6 P2 — all fixed in `77ce88f04` (tests plus one `useMemo`) and `13433a583`. Round 2: all six re-measured and killed; `INCOMPLETE_ORACLE` on B1-27. Round 3 (owner-authorized, "I authorize a third round scoped to the 11 skipped rows and RT-B7 (B1-27)."): RT-B7 pinned by a new case (`94e4a1a26` — a read that answers after the turn finished resumes the newer running turn); the 11 skipped rows all killed; **CLEAR** at `e11aeceda` — 88 rows, 62 killed, 0 inconclusive, 0 skipped-budget. One new P2 left open for T8: RT-B8 (the S3 refetch in `adoptAcceptedTurn` has no discriminating case). Session 2 cost ≈ 160M input tokens / 308K output / 6.5 h on top of session 1's 120M / 265K / 8.1 h.

**Open, owed by the T8 follow-up PR.** Sentry rule 11 in `repworth-staging` and `repworth-production` (NOT BUILT — the API refused for want of `alerts:write`); the staging flip of `OWNER_OPERATOR_ENABLED` through the `flag-flip` skill; p50/p95 of `completed_at - created_at` on staging; the `worker/jobs/agent-turn/constants.ts` tune; spec §12.1 checkpoint and §15; RT-B8's test. Still open from Run A: red-team P2-4 (runbook triage hop via `outbox_id`), spec §14 CA1 (OutboxPoller stranded turn) and CA4 (predecessor-wait clock).

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-13):** run `pnpm ci:fallow:coverage` and React Doctor BEFORE the review wave on a UI-bearing branch; the red-team checker's `authorizations` admits only finding-resolving records and a third round needs the words "third round"; revert a mutant with `finalize`, never a second `mutate`; the base-tier auth harness cannot sign an owner into any `/dashboard/*` page; the plan prevalidator reads hex runs on any line carrying a git word.

## 2026-09-13 — Owner Operator T8 merged (#1276, squash `099409ae2`): the staging flip, the first live turn and its fix, rule 11, RT-B8, the §12.1 checkpoint

**The flip.** Preconditions checked (migration 120's four tables on staging by introspection; Sentry rule 11 built; the merged PR's RLS/tenant-scope audits green), then `OWNER_OPERATOR_ENABLED=true` on staging on both lanes, owner-run because the harness reserves feature-flag writes: Railway worker 02:59Z (deploy SUCCESS 03:01Z, `/ready` green) and the Vercel `staging` Custom Environment 03:03Z through the REST API (`vercel env add` cannot target a Custom Environment) plus a redeploy (READY 03:04Z). Production stays off.

**The first live turn failed.** 03:11Z, `model_output_invalid` on BOTH pinned providers, two attempts each. Reproduced locally in minutes with the production prompt and a Tanicia-shaped snapshot: gpt-4o-mini answered `{scope_check, unsupported: "…"}`, claude-haiku `{operationId, proposedValue}` in a code fence. Cause: nothing declared the output shape — the LLM seam sends system + user text, hands no JSON schema to a provider, and validates with zod only after the completion arrives; prompt `2026-09-11.2` said "matching the declared schema" and declared nothing. Fix (`11e9b9940`): `OUTPUT_SHAPE` in the system prompt spelling `OperatorModelOutputSchema` (version `2026-09-13.1`); every proposable declares `inputShape`, projected as `allowedOperations[].input`; `prompt.test.ts` pins every key and segment type read from the schema (fails when the block is removed); `catalog.test.ts` pins each `inputShape` to the strict schema's keys. Re-verified live against both models, ridden to staging at 03:26Z.

**The §12.1 drive (after the fix, owner Tanicia Resort Testing).** Item 1 PASS: turn 2 in 8.95 s → `set_tone` Proposal with the full before/after → Apply → Receipt (`appliedAt 03:28:50.999Z`, before "professional and friendly", after "warm and brief", actor, verbatim request, turn reference), `businesses.tone` read back. Item 3 PASS: reload during "Preparing your plan" resumed the turn from the URL; repeat Apply answered 200 with the same `appliedAt`; resend under one `clientTurnKey` returned the same ids, a different text under it 409. Item 4 PASS: a touched `businesses.updated_at` → `stale` with Refresh plan; unknown id → 404; a bumped `contract_version` → `contract_changed`. Items 5 and 7 rest on the suites (claim race; Origin — staging's SSO gate answers from outside a browser). Items 2, 6, 9 wait on review traffic, a second location, the owner. Item 8: the auto-approval Apply path estimated in §13 at 14–16 h. Item 10: five completed turns — p50 8.38 s, p95 9.5 s, max 9.64 s, 3.3–5.5 s of each the outbox claim wait; reasons over 7 days: completed 5, `model_output_invalid` 1 (pre-fix). Constants unchanged with the floors recorded in `constants.ts`. The tone was restored through the Operator (a fourth Receipt).

**Also.** Sentry rule 11 built in both projects through the new alert builder (staging `3984512`, production `3984518`), verified via the API. Red-team RT-B8 closed (`dc1bf7b75`). Merged at 03:44Z; `staging` realigned to `main`.

**Open.** The auto-approval proposables and their transaction-aware writer (§13); the seam's missing structured-output contract and a live keyed eval case per structured task (§14); the OutboxPoller items CA1/CA4 from Run A.

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-13, T8):** a schema the model was never told is a prompt promise, not a contract — the keyless eval harness and the mocked unit suites cannot see it; the first live turn on staging is the first real test of any LLM task's shape.

## 2026-09-13 — Owner Operator Run C verification and release reference (#1278)

**Implementation.** The seven-operation catalog now includes the three policy dials. The shared policy writer participates in Operator Apply's transaction; account-before-proposal locking, parent/override tokens, exact stored confirmation phrases and fresh readiness checks precede the write. Immutable receipts preserve actual old/new rules, recomputed 30-day consequences, imported/unknown exclusions and retained approval-grant counts. Console (Harbor) cards expose those facts. Initial ingestion records provenance on the existing run spine; structured tasks deliver their registered schemas to both providers. No migration or production flag change accompanies this work.

**Verification.** Candidate `a8b934a69434476ce41d056c0d846b03129fe994` passed the full review gate: 15,911 tests passed, 11 skipped, with build, E2E and the required audits green. The fourth red-team report is CLEAR: 1,001 retained rows, 445 killed, 7 equivalent and 549 excluded. Its new work used 126 of 150 authorized local launches: 56 kills, 7 equivalents and 153 exclusions; the earlier report history remains intact. The final prompt correction and reviews used Codex under the owner's instruction against external Opus delegates; earlier implementation attribution remains in the historical feature evidence.

**Staging.** The first candidate failed account-off planning; that attempt remains recorded as FAIL. Prompt `2026-09-13.4` corrected the semantic failure. Matched UI/worker deployments of the reviewed candidate then passed three fresh real turns: all-locations off, Cafe clarification with Salon selected, and the weekend scheduling request. The ten-review fixture counted 8 included, 1 imported and 1 unknown; Apply persisted one audit, and the pending second tab returned the same receipt without another write. Actual 390px/1440px captures, stored state and all 25 zero-result cleanup checks are in the [acceptance evidence](runbooks/evidence/2026-09-13-owner-operator-run-c-evidence.md). The first Apply was desktop; the replay was mobile. No responses or connections were created. Staging retained-veto alert 3985600 is saved; live delivery was not exercised.

**Release boundary.** PR #1278 merged at 2026-09-13T19:22:35Z, squash `280d1b0137f4f5a3e2cd613abe7464238d0f665e`, after required CI passed with15,911tests/11skipped. Its tree matches the reviewed candidate. Both post-merge staging deployments pin that squash. The fresh390px Apply at19:30:09Z persisted eligibility5→0of8, veto15/cap2, retainedVeto0 and one audit; the receipt survived1440px reload. All25post-merge cleanup checks were zero at19:33Z, and the exact completed queue job and Auth identity were removed. Production remains off; §12.1's remaining human/traffic checkpoints and the COO owner-pilot record are unchanged. The provenance, semantic-eval and mutation-oracle lessons are recorded in the September lab history.

## 2026-09-14 — Owner Operator Run D merged (#1291, squash `fb91cd2f4a3769f5ac35227cf58751720d83b381`)

**Implementation.** CA1 couples winning outbox exhaustion to its stored tenant/conversation/turn through `reconcileTurnForFailedOutbox`. Live and contended claims defer safely; accepted or expired claims terminalize in the same transaction. The D-A1 correction makes aged exhausted `agent_turn` rows left in `dispatching` after rollback eligible for the existing watchdog. CA4 makes `releaseTurnClaim` fence both turn token and outbox attempt, including delivery before enqueue acknowledgement; healthy waits refresh liveness, and delay failures still reject for retry. `dispatch_exhausted` renders durable recovery wording and a new-conversation action. No migration, dependency, new production module, production enablement or flag change was made.

**Verification and review.** Final candidate `f2586bd101c22fecbce09c3f1ed64d9740d1a465` passed the full local gate: 15,978 tests passed / 11 skipped and 60 E2E passed / 108 skipped, with fingerprint `fa984d05f14ef341881978afeb38afb3247d1374c75d1426f1068d79e0ec8fc1`. Spec and standards reviews approved; accepted D-PS-1/2/3, D-A1 and prepared-runner D-RUN1 were fixed. Native Codex's final round-2 report is CLEAR: 278 retained identities, 102 killed, 176 excluded, no findings or waived risk. The second pass measured 92 cases with 191/200 launches; all 95 mutations were restored. The owner-approved final recording exception preserves the completed work grant in permanent admission history and leaves the risk-waiver list empty; it changed no checker or product source. The branch includes the explicitly bounded D verifier safeguards and their regression coverage. [Review reports](reviews/codex-owner-operator-run-d/) and [adversarial record](reviews/red-team/codex-owner-operator-run-d-7749f8/findings.md) retain provenance and limits.

**Staging and limits.** The original campaign's actual 390px/1440px journeys covered next-draft tone, pinned location and durable recovery. The owner's early close yielded 24/24 completed turns over 19h50m14.857381s (p50 6.838317s; p95 16.10373645s), explicitly `full_24_hours_elapsed=false`. The tone prompt was reconstructed from source inputs; its literal placeholder signoff remains a recorded quality limitation. The corrected candidate `091d86bc778480dfd3c2cbc9fbbf61017392bbe0` then ran on Railway `113ceb47-ac01-49fb-8f6d-fd50741c0b04` and Vercel `dpl_E9ncrTWQ96hvov9pmYxXPdsFGofM`. The actual deployed watchdog produced a matching terminal pair at 2026-09-14T19:17:47.567765Z; independent ten-scope cleanup was all zero at 19:18:21.401216Z. That fixture exercised the durable rollback state without model work, Auth creation, live outage injection or an alert-delivery drill. Original fixtures and follow-up fixtures were removed. [Evidence](runbooks/evidence/2026-09-13-owner-operator-run-d-evidence.md) owns detailed cleanup and post-merge deployment records.

**Release.** Required CI passed for the merged feature head. Architecture counter 1→2; a pass is not yet due. The separate documentation closeout precedes E. §12.1 item 9 remains BLOCKED-human; production enablement remains a human decision.

## 2026-09-15 — Owner Operator Run E #1293 merged; post-merge deployment/readiness PASS

Candidate `ba0c65bb3a3665ed10a6441d27917802819ad4c1` implements receipt-derived
Restore, Rules timeline, clear override and fenced durable policy refusals.
Corrective fixtures strengthen13 existing cases; finite verifier additions retain
the frozen388 records / 776 launches, earlier findings and round 2's 1,600-launch cap.
Closed semantic-warning diagnostics were independently corrected to a scalar
field retained by the actual logger, without prompt/validation/retry/billing changes.
The [E evidence](runbooks/evidence/2026-09-15-owner-operator-run-e-evidence.md)
records qualified J1–J7 PASS and exact cleanup:67 public rows, Auth/session scopes,
7 observed queue jobs and campaign tabs/viewport closed by approximately 10:34Z.
The original J5 failed turn remains separate from successful later recovery;
J6's direct GET key is uncaptured and blank J7 images are not visual proof.
Migration 121 applied in both projects; alert 3993328 is configured, delivery unproven.
Parent ba0c65bb full gate passed: 16,218 DB / 11 skipped, 14,903 ordinary /
1,316 skipped; build/E2E/checks PASS. Report-only fb66d15d changes two files
(195 insertions / 7 deletions), leaving application/test/configuration unchanged.
Final certification CLEAR: 2,437 identities = 361 killed + 2,076 excluded;
12 fixed / zero open / zero waivers. Round2 finalized 802 launches / 401 pairs;
record400's target-selection miss and same-ID second-attempt401 kill are retained.
Required CI34962247726 passed, deploy-install validly skipped; optional Fallow
failed (eight complexity findings / two clone groups). E2E34962247838 passed
30 / 54 skipped; Doctor34962247896 passed. Local post-report verification did
not pass: first four timeouts, then ten with 14,893 passed / 1,316 skipped in
1,280.09s; remaining wrapper checks stopped. The owner [approved the bounded exception](reviews/codex-owner-operator-run-e/release-verification-approval.md), accepting passing GitHub checks and the earlier full local pass on identical application code without declaring the failed local wrapper green.
Feature #1293 merged as `d4a96f3205bc1061cd03f6fe0bceb0eabb546ebf` at 2026-09-15T16:39:27Z.
Matched post-merge deployments and [post-merge readback](runbooks/evidence/owner-operator-run-e-2026-09-15/postmerge-readback.json) passed at d4a96f3: Railway SUCCESS16:49:36.554Z, Vercel READY16:42:55.421Z with staging alias, `/ready` HTTP20016:49:55.515Z, PostgreSQL/both Redis OK and named flags unchanged (production Operator UNSET). This documentation closeout publishes the remaining records; GitHub retains its PR and merge identity.
Architecture records 2→3 once for this feature; docs do not count. D docs #1292/30896acb closed the dependency;
its shortened observation and human pilot/production decisions are unchanged.

## 2026-09-19 — #1329 merged (#1337, squash `48ba6e4fb`): both release-scan fairness arms made exact; three red-team rounds

**What shipped.** The **Release cycle**'s P4 candidate scan (`selectReleaseCandidates`,
`src/lib/solicitation/release.ts`) is `ORDER BY approved_at ASC LIMIT 50` with both
account-level gates evaluated AFTER it, so an account the cycle always refuses held
candidate slots for its batches' whole 72h send window while every other account
released zero. #900's `capped_accounts` closed that for one gate, approximately. Now
both arms are exact:

- `account_unentitled` (new): a correlated `NOT EXISTS` on `accounts` binding
  `FULL_ACCESS_SUBSCRIPTION_STATUSES` — a new export in
  `src/lib/shared/subscription-status.ts` over which `subscriptionGrantsFullAccess`
  is now implemented. One owner, so SQL and TypeScript cannot disagree and `trialing`
  cannot be starved.
- `capped_accounts` (repaired): stops keying on `DEFAULT_DAILY_SEND_CAP_ACCOUNT`. The
  cycle reads configured caps once per tick (`readResolvedAccountCaps`), resolves each
  through `resolveAccountDailySendCap`, and binds `(account_id, cap)` pairs via
  `unnest`; the arm compares `COUNT(*) >= COALESCE(r.cap, <resolver's null branch>)`.
  `LEAST(configured, 10)` still has exactly one spelling, in TypeScript.

Both exclusions are counted from the same `eligible` CTE in amendment B6's order — the
second count carries `AND NOT account_capped`, so an account refused by both gates is
ONE withhold under `account_cap` — and both survive a tick with zero candidate rows via
the `LEFT JOIN … ON TRUE`.

**Files.** `release.ts` (arms, `readResolvedAccountCaps`, `capBindArrays`, retained
`readAccountDailySendCap`, second withhold count) · `subscription-status.ts` (+ the
exported array) · `scripts/ci/tenant-scope-allowlist.ts` (+2 entries, `ALLOWLIST_BASELINE`
380 → 382) · `release.integration.test.ts` (53 → 68 executed cases) ·
`subscription-status.test.ts` (+1 pin). No migration, flag, dependency or new writer.

**Two premises the review destroyed.**

1. **#900 round 2's "unreachable today" was false at HEAD.** It deferred the sub-default
   cap because "no TypeScript writes `daily_send_cap`". `upsertSolicitationAccountDefault`
   (`src/lib/auto-approval/solicitation-settings.ts`) writes it via
   `PATCH /api/settings/auto-approval`, `DailySendCapSchema` admits 1..50, and LOWERING
   the dial is an exposure contraction that passes no readiness gate — so only the
   autonomy flags stood between the gap and production. Found by building the tripwire
   meant to guard the premise; it fired on the settings lane immediately, and was then
   deleted as pointless once the arm became exact.
2. **A snapshot cannot authorize a send.** The first cut ALSO deleted the per-account cap
   read and served the gate from the tick's snapshot, arguing arm and gate could then
   never disagree. Codex review showed the cost: nothing downstream re-checks the cap,
   so an owner contracting the dial mid-tick was obeyed one tick late. The read stays.
   The arm is a DISCOVERY bound; the gate is the AUTHORIZATION. The lane therefore issues
   ONE statement more per tick, not fewer — three documents claimed the opposite and were
   corrected. A second review axis simultaneously asked to finish the de-duplication,
   which would have deepened the regression; reading the whole findings table before
   fixing anything is what caught it.

**Review: 4 axes, 3 red-team rounds, 16 findings.** Round 1 (wave): Codex `REVISE` + 2 P0,
4 P1, 3 P2. Round 2 found **two new P0s in round 1's fixes** — `pnpm lint` broken by the
fix itself (a dead import after both uses were replaced; `lint` is a required check), and
the restored gate read's `WHERE` unpinned, where dropping `account_id` or
`location_id IS NULL` each survived 66 green cases. Round 3 (owner-granted, because
`round-start` caps rounds at two and round 2's fixes moved HEAD past the pass that
reviewed them) held all 14 fixes and found one more P1 — in the orchestrator's own
authorization entry, which failed the checker's schema. Final status CLEAR: 24 inventory
rows, 15 fixed, 1 P2 open by choice (the duplicate-row `throw` guards a state migration
074's unique index makes impossible).

**Two tests that proved nothing, and how.** The "lockstep pin" derived its expectation
from `subscriptionGrantsFullAccess`, which is now implemented OVER the array under test,
so dropping `TRIALING` moved both sides and passed; it now pins against literals. The
cap-gate case expected `released: 2` under the default `perTickBudget`, which is also 2,
so the BUDGET satisfied the assertion; it now passes `perTickBudget: 10`. Reaching either
per-account gate at all needs a mid-tick change, and the seam is subtle: `runAccountArm`
reads the cap BEFORE counting attempts, so the cap case drives its change from a SIBLING
account's count while the lapse case correctly uses its own. Five mutants were re-measured
after fixing; each fails exactly the case named for it.

**Staging.** Rode `staging` at `5d10e341b` before the PR. The worker booted and the
release cycle logged `Release cycle complete` with `releasePhaseStoppedBy: null` and
`itemFailures: 0` — so the scan actually ran, and the `unnest` bind with BOTH arrays
empty (the production case) executed without error. Staging realigned to `main` after
merge; `staging == main` at `48ba6e4fb`, zero drift.

**Two process traps, both already documented as lab notes.** `gh pr checks` reported no
failures while **no CI run existed at all** — the draft→ready transition raced the push
and the surviving run carried `draft: true`, whose jobs skip; merging `origin/main`
produced a `synchronize` event and the real run (all checks green, `test` included).
And `red-team-status.mjs` binds its evidence to a TREE, so appending to the triage record
after the final round broke the `reviewed` transition — everything except the sidecar must
be committed before the last round opens.

**Named residual.** These arms exclude ACCOUNT-level refusals only. A mid-drip
`auto_policy` batch held by a failed auto condition still holds its slot until P2
terminalizes it at 72h (`release.ts:1854`, `applyDowngradeSplit` returns `held` and
changes nothing), so the candidate window is not generally starvation-free — a cursor or
rotation is a separate ticket. `release.ts` is 2121 lines and `selectReleaseCandidates`
its most complex function; extracting `release-candidates.ts` is justified and deferred
because the tenant-scope allowlist is FILE-keyed and would re-key all seven release
entries in a PR `refactor/616` is already touching.

**Shipped with one known red row.** The local `pnpm test` fails one unrelated
pre-existing case (`red-team-mutation-runner.test.ts`, filed as #1334) which passes in
CI; the owner's call was to ship on CI's verdict for that row rather than mix a tooling
fix into a high-risk solicitation PR. Every other local row was green.

## 2026-09-19 — #616 the two fallow complexity hotspots, cleared by decomposition (PR #1340, squash `3a7cd6653`)

Issue #616 tracked two long-standing `fallow` complexity findings. Both are
cleared by splitting the functions, not by suppressing the check.
**Behaviour-preserving**: no schema, migration, flag, env var or dependency, and
no pre-existing test body was modified. +28 tests, 0 removed.

| function | before | after |
|---|---|---|
| `src/lib/shared/logger.ts` `emit` | cognitive 24, CRAP 106.4 (`fallow` grade **critical**) | assembly over six module-private helpers; public interface untouched |
| `worker/jobs/OnboardingDemoWorker.ts` `handleOnboardingDemo` | cognitive 25, cyclomatic 19, 144 lines | orchestration only, cognitive 7 / cyclomatic 8 |

Two new modules in the existing DI package: `onboarding-demo/subscription-guard.ts`
and `onboarding-demo/cost-reconcile.ts`. Three `scripts/ci/tenant-scope-allowlist.ts`
entries follow the query to its new file — same SQL, same `od.id` scoping.

**Method: characterization first.** T1 and T3 pinned the contract against the
UNREFACTORED code before either extraction, so a red test means the refactor moved
behaviour, never that the test is stale. Two mutation probes recorded, each failing
exactly one new test and passing the pre-#616 suite.

### What the reviews actually bought

- **A signed-off intake invariant was FALSE about the code.** It claimed every
  non-completing path releases the 20¢ reserve. The subscription `SELECT`,
  `claimDemo` and `markOutboxCompleted` sit outside the outer `try` and release
  nothing. Narrowed to the as-built contract and pinned by a test — deliberately
  not "fixed", since that would be a behaviour change on this branch.
- **A rounding assertion that could not distinguish `Math.round` from `Math.floor`.**
  Both fixtures used 3.42¢, where the two agree. Now paired: 3.55¢ → 4 with
  3.42¢ → 3, which admits only `Math.round`.
- **Neither the ORDER of the finalize/threshold pair nor the `await` on either was
  pinned.** `checkCostThreshold` reads the very counter `finalizeOnboardingDemoCost`
  decrements — reversed, every demo measures thresholds against the un-reconciled
  20¢ reserve, roughly 17¢ per demo too high.

### Three gotchas worth keeping

1. **`fallow` assumes 40% coverage when no coverage file is present.** An
   intermediate state at cognitive 9 / cyclomatic 10 still failed on CRAP 31.6
   (10² × 0.6³ + 10). Real coverage cleared it, but that makes the proof depend on a
   coverage file being current inside a parallel gate. A `leavesNoWorkToDo` type
   predicate took cyclomatic to 8, so the check now passes with no coverage data at
   all. Recorded as named debt (D7): a one-caller predicate kept against project
   preference, for a stated reason.
2. **`outboxAttempt` was droppable at FOUR call sites, and three successive rounds
   each found one more.** `expect.objectContaining` tolerates a missing key, and a
   harness default of `attempt: undefined` makes a dropped forward byte-identical to
   a correct one. Every fix asserted its own site and then CLAIMED the class was
   closed. The class is now closed by ENUMERATION — `grep -n outboxAttempt` over the
   root returns exactly four forwards, each asserted with a distinct nonzero value
   (4, 5, 7, 9), so a cross-wired forward fails too.
3. **The tenant-scope allowlist is FILE-keyed.** Moving a query to a new file
   re-keys its entries. That is also why PR #1337 deferred its own
   `release-candidates.ts` extraction.

### Shipped with the `reviewed` transition WAIVED — the first on this ledger

Recorded as deviation **D11**, by owner decision. Not a code compromise; a workflow
one. Red-team round 3 raised two findings of its own, RT-010 (P0) and RT-011 (P1).
Both were fixed in `cceef6ff` and hand-verified — the RT-010 mutant was run and
observed to fail a named test — but neither could be journaled, because the round
that RAISED them was the last one the runner allows. Three `red-team-status.mjs`
errors resulted; the owner authorization `issue-616-round-3-residual` clears one,
and two stand on record unresolved:

- the sidecar's `head_sha` is stale against four moved paths, and the staleness rule
  has no authorization escape (`red-team/SKILL.md` names hand-editing `head_sha` as
  the wrong path, so it was not edited);
- inventory row `rt-078` is `inconclusive` / class `oracle` — a type-only annotation
  no vitest case can measure — and `recomputeStatus` ranks `INCOMPLETE_ORACLE` above
  `OPEN_P1`, so the sidecar cannot reach `CLEAR` even with every finding resolved.

Both structural causes are filed: **#1342** (the round cap collides with
`RUN_C_FOURTH_TEXT`, so the minimal generalisation breaks twelve tampering checks —
it was tried on this branch and reverted) and **#1343** (any branch adding a
type-only annotation can never pass step 7.5).

**Shipped with the same known red row as #1337.** Local `pnpm test` fails one
unrelated pre-existing case (`red-team-mutation-runner.test.ts`, #1334): 1 failed,
15,162 passed, 33 of 34 gate rows green. It passes in CI — confirmed on this PR's own
`test` job. CI was the authority for that row.

## 2026-09-21 — #1374 secret scan merged (PR #1415, squash `e39ff8a7a`)

Ran inside one `/feature-swarm` sitting with #1016+#612 (three parallel runs, one
owner). Lane `/feature`, size reclassified `small` → `standard` at step 0 once the
real numbers were in (397 production / 136 test lines against a 110/120 estimate —
the estimate was wrong, not the scope), RISK normal, 3 review rounds, red team
WAIVED at normal risk and recorded by `red-team-status.mjs`. Records:
`docs/reviews/feat-1374-secret-scan/` (triage.md carries every verdict) and
`docs/superpowers/plans/feat-1374-secret-scan-deviations.md`.

**What shipped.** A new CI audit, `ci:secret-scan`
(`scripts/ci/secret-scan.ts`), wired three ways under
`src/__tests__/ci-audit-wiring.test.ts`: `package.json`, `lefthook.yml` pre-push,
and ci.yml's `lint` job. It runs gitleaks over the **commits** in
`<base ref>..HEAD` — `baseRefFor()` from `merge-ledger-audit.ts`, `origin/main` by
default and `GITHUB_BASE_REF` on a PR — with `--redact` and
`--diff-merges=remerge`. Never the working tree. A secret one commit adds and a
later commit removes is still caught, and so is one pasted into a merge
resolution. `.gitleaks.toml` is new. `docs/runbooks/secrets-rotation-api-keys.md`
is new and records six owner-reported rotations of 2026-09-20 plus the decision
**not** to scrub history; audit item C1 in
`docs/audits/2026-07-06-codebase-audit-findings.md` now carries its true status
and stays deliberately unticked, because step 3 is PARTIAL — five non-LLM keys
still have no rotation procedure.

**The architectural consequence, which is the part to remember.** This is a **new
external tool dependency on every developer machine and every gate run**:
`brew install gitleaks`, and the audit fails closed without it by owner decision.
`scripts/verify-gate.sh` builds its audit set from package.json's `ci:*` keys
(excluding `ci:fallow*`), so the row joined every local gate with no gate edit at
all. No npm dependency, flag, env var, migration or schema change.

**Three measurement defects the review found, all in the gate's own logic.**

1. **Round 1's P1 — the gate could not see and passed anyway.** gitleaks 8.30.1
   exits **0** with `[]` on stdout whenever its own `git log` writes anything to
   stderr (an uninstalled `.gitattributes` textconv driver, a partial clone that
   cannot fetch a blob, a `warning:` from a damaged commit-graph). It prints
   `ERR error="stderr is not empty"` and `INF 0 commits scanned.` and exits 0. The
   reviewer reproduced a real private key in the range shipping green. A pass is
   now a conjunction: exit 0 AND `[]` AND gitleaks' own scanned-commit count at or
   above the commits that add a text line AND no `ERR`/`FTL`/`fatal:` marker on
   stderr.
2. **The count model was wrong twice.** Measured with a `git` shim on PATH:
   gitleaks counts a commit when it yields a hunk on a file that **survives** the
   commit — added *or removed* lines — and does not count empty commits,
   whole-file deletions, 100%-similarity renames, mode-only or binary-only
   changes. So `git rev-list --count` is systematically too high a comparand,
   while an equality against the added-line count is too low and false-fails an
   honest revert or delete-only push. Owner decision at round 2: the check is a
   **lower bound**. Only a shortfall proves the scan stopped short.
3. **`--diff-merges=remerge` is the only variant that works.** `git log -p` shows
   no diff for a merge at all. Against a scratch repo whose merge resolution
   introduced a fake private key present in neither parent: `-m` finds it but
   double-reports it (once per parent), `--cc` and `-c` find nothing,
   `--first-parent -m` finds it but drops every side-branch commit. Needs git
   ≥ 2.35; an older git fails closed rather than silently skipping.

**Two more things worth carrying.** A `[[allowlists]]` block with no `targetRules`
disables **every** rule for what it matches — the fixture-path block shipped that
way in round 1 and silently switched off all ~200 default rules, `private-key`
included, across six live test suites. And **the branch failed its own scan**
(round 2, finding N1): the rotation-drill paragraph wrote a literal PEM marker
pair, gitleaks' `private-key` rule matches from an opening marker to the next
closing one across ordinary prose, and because the scan reads commits a later
commit could not clear it — the unpushed commit was undone with
`git reset --soft` and rewritten so the pair never entered the branch history. A
doc that explains the shape must **describe** the markers, never spell them.

**Known limits, stated rather than implied.** A sufficient count does not prove
the range was fully read: a file `.gitattributes` marks `-diff` or `binary` is
invisible to both sides, so the minimum does not rise either (script header +
runbook "Known limit"). An inline `gitleaks:allow` comment and a committed
`.gitleaksignore` entry each pass a complete fake key — pre-existing gitleaks
behaviour, measured at round 3, explicitly out of scope. And the version pin is
**CI-only**: Homebrew is unpinned locally, so the script prints the local version
beside the CI pin on its first line, making drift visible rather than prevented.

## 2026-09-21 — #1016 + #612 remainder merged (PR #1417, squash `3b894b22c`)

The other half of the same `/feature-swarm` sitting. Lane `/feature`, size
reclassified `small` → `standard` after the review fixes (the growth was almost
entirely test strength — the rule-scoped doc pin, the per-offboarding fingerprint
tests and the comment-skipping scan), RISK high, lead `claude/opus`, 3 review
rounds (spec-correctness + async/operations lens, standards-maintainability,
Codex `gpt-6-astra` adversarial) plus **3 red-team rounds**, the third
owner-authorized. Records: `docs/reviews/fix-1016-612-purge-terminal-alert/`,
`docs/reviews/red-team/fix-1016-612-purge-terminal-alert-e8cee7/`, and
`docs/superpowers/plans/fix-1016-612-purge-terminal-alert-deviations.md`.

**What shipped.** `alertPurgeFailure`
(`worker/jobs/account-offboarding/PurgeWorker.ts`) now sets a fingerprint. The
retry arm takes the shared `[account_offboarding_purge_failed, retry]` at
`warning`; the terminal arm takes
`[account_offboarding_purge_failed, terminal, <account_offboarding_id>]` at
`error`. Both spellings are exported —
`PURGE_TERMINAL_FINGERPRINT_PREFIX` and `PURGE_RETRY_FINGERPRINT` — because the
runbook names them and the test reads them back. `docs/runbooks/beta-launch-alerting.md`
gains a §1 checklist entry and **rule 16**. One production file, one new
production behaviour; no migration, flag, env var, dependency or module.

**Two locked intake decisions were reversed by review round 1, both owner-decided.**

- **Codex A1.** The intake locked a two-member terminal fingerprint, which would
  have put every terminal failure in ONE Sentry issue — and Sentry's action
  throttle is per issue, so a second account's page would be suppressed for the
  rest of the hour. The terminal fingerprint gained the offboarding id: **one
  issue per terminally failed offboarding**. The guarantee is cross-offboarding
  only; repeats on the same offboarding stay throttled. The cost is storm mode —
  N systemic failures, N issues, N pages, no aggregate ceiling — accepted so a
  second account is never suppressed, and written into the rule rather than
  hidden.
- **RT16-01 / spec F1 (P0).** The runbook's operator action prescribed a re-drive
  that **no code path can perform**. `validatePurgeableOffboarding` rejects the
  row, `AccountOffboardingPurgePoller` claims only
  `status='purge_scheduled' AND purge_started_at IS NULL`, the teardown retry path
  is scoped to `failed_step='teardown'`, and the one admin route that writes
  `status`/`failed_step` — the provider-disposition route behind
  `shouldTransitionToPurgeScheduled` — leaves both untouched on a
  `failed_step='purge'` row. The runbook now says so plainly, tells the operator
  to treat the account as holding **live PII** (the purge is Stripe-redaction-first
  with no per-stage checkpoint, so a terminal failure before the parent tombstone
  stage leaves names, emails, phones and addresses in place while the auth user is
  already deleted), and a P1 ticket **#1411** owns the recovery mechanism.

**The prose pin was beaten three rounds running, and the third defeat is
structural.** Round 1: a file-wide `toContain` matched the same string in a
different section, so rule 16's row could be corrupted to `terminal equals false`
at `warning` on the retry fingerprint and the test stayed green (RT-A6). Round 2:
row-scoped regexes each found themselves in the *other* cell's sentence, so
SWAPPING the two fingerprint spellings inside the row survived (RT16-02, P0 for a
second consecutive round). The fix asserts **position** — which cell, which
sentence — by slicing the file to rule 16's block, splitting the row into cells,
finding each cell by its column header, and pinning every facet inside the cell
that carries it: the filter cell's tag, level, `subsystem`, `step` and environment
scoping; the grouping cell's opening level plus both constants position-scoped
(terminal only ahead of the retry-arm sentence, retry only inside it); the trigger
cell's every-event delivery, 60-minute per-issue throttle and integration 443670.
Nothing else in the row. Round 3 then found **RT16-11**, which position-scoping
cannot close: every pinned substring stays present under a `do **not**` prefix.
Measured three times in three different cells, each surviving — the pin is
**17-for-24 against value corruption and 0-for-3 against polarity**, and the cell
already contains a negated instruction in production prose, so the mutation is
native to the shape, not contrived. The owner accepted it; the durable fix is a
machine-readable record the prose row is checked against cell by cell, filed as
**#1414**.

**What rule 16 is, and is not.** It is **REQUIRED, NOT CONFIGURED, and not
delivery-proven**. Nothing pages from it until an operator builds it in Sentry —
staging first, read the saved rule and destination back, then production. A
delivery drill is a separate §4 requirement. The generic job-failure sink does not
cover this path by design: on the terminal attempt the handler calls
`markPurgeTerminalFailure` and `markOutboxFailed` and then **returns** without
throwing (owner decision: one failure, one report), so BullMQ emits no `failed`
event and `attachJobFailureSink` never fires — and rule 11's filter is
`subsystem=worker_job` AND `queue=agent_turn`, matching neither. Rule 1 is not a
fallback either: its §1 box is unchecked, and once built it triggers on first-seen
over a finding whose message embeds a count and whose payload never carries the
offboarding id, so it would fire once per distinct count value.

**Deferred with the owner's authorization, all filed.** **#1412** — `TeardownWorker`
and `BillingScheduleWorker` carry the identical one-shared-issue shape,
re-verified byte-identical to the merge base before the deferral was recorded.
**#1413** — three terminal paths in the same lane raise no `terminal:true` event:
`account_offboarding_not_found` returns with no alert, a `loadPurgeOffboarding`
throw happens outside the handler's try, and a watchdog terminalization carries no
offboarding id. Both are named in the runbook.

**#612 remainder.** The `csv_ingest` advisory-lock-key single-owner scan in
`src/lib/solicitation/__tests__/ingest.test.ts` widens to `src/lib` + `worker` —
the same width as the `solicitation_batch` scan — so the offboarding purge lane is
inside the guard. It blanks **comment text**, not whole comment lines (whole-line
stripping hid code after a `*/` and on `*`-leading continuations, RT16-09), which
is why `purge-stages.ts` leaves the diff entirely: no production prose was
reworded to dodge a regex. The race half of #612 was closed by #637.

## 2026-09-21 — #1149 MFA second factor merged (PR #1416, squash `d66c74823`)

The third run of the same `/feature-swarm` sitting, and the last to land (2026-09-22).
Lane `/feature`, size small, RISK high (auth), lead `claude/sonnet` with `opus`
fix rounds; three review rounds (spec-correctness + security lens,
standards-maintainability, Codex `gpt-6-astra` adversarial) and three red-team
rounds, the third owner-authorized, final status CLEAR with 0 survivors.

**Files.** `src/lib/auth/mfa.ts` (new pure `nextFactorFriendlyName`),
`src/components/auth/useMfaEnrollment.ts` (fresh `listFactors()` read before
enroll, error-code mapping, the step-up sentinel guard), their two test files,
`docs/directory/lib-platform.md` (row for the export; also re-pointed the stale
`src/proxy.ts:92-103` span to `getAalGate` at `:260-271`). No new module,
dependency, flag, env var or migration.

**Decisions.** Name rule `RepWorth`, `RepWorth 2`, … (first unused, fills gaps,
no clock, no randomness) rather than a date — the Security page already shows
"Added <date>". The hook re-reads the factor list rather than trusting its
state. The terminal-vs-retry question did not arise here; the one owner decision
was to keep "no cleanup of abandoned unverified factors" as a non-goal and gate
the PR on a staging measurement — then, on 2026-09-21, to merge without it.
That measurement is **#1418 (P1)**.

**What the review changed.** The invariant property was empty (`fc.string()`
never drew an in-sequence name; the red-team mutant `return 'RepWorth'` survived
100,000 draws) — now biased and paired with a first-unused-name property. The
cancel fixture placed an unverified factor under `totp`, a shape auth-js 2.106.2
never emits (every factor goes to `all`, only verified ones to `totp`); deleting
the `all` arm of `collectFactors` left the suite green. Provider text reached
the string `isStepUpRequiredError` sniffs, so a Supabase message containing
"sign in again" would have rendered the AAL2 step-up link on an enrollment
failure — guarded in the hook, bound to the real consumer predicate in a test.

**Gotchas.** CI's `test` job failed once on `migration-119-job-outbox-rls`
(`deadlock detected`) — the known live-DB deadlock class
(lab-notes/live-db-test-suites.md), not this branch; green on re-run. A branch
that takes `main` after `reviewed` makes `red-team-status.mjs` report a stale
sidecar by construction; the PR records the empty intersection instead of a
hand-edited `head_sha`.

## 2026-09-21 — #1412 + #1413: every offboarding worker pages per offboarding, and a watchdog-stranded offboarding is named

**Why.** The review wave on #1016 (PR #1417) found the RT-08 shape it had
just removed from `PurgeWorker` still standing in `TeardownWorker` and
`BillingScheduleWorker` (#1412): one constant `captureMessage`, no
fingerprint, retry `warning` and terminal `error` in one Sentry issue, so a
first-seen rule fires on an early retry and never on the terminal event — and
the terminal branch RETURNS, so `attachJobFailureSink` never covers it. The
same wave found three purge paths that raised no `terminal:true` event at all
(#1413): a not-found dispatch, a throw from `loadPurgeOffboarding` outside the
try, and a watchdog terminalization that runs no handler and leaves the row
`purge_scheduled` with `purge_started_at` set — a state the purge poller never
re-claims.

**What.** `worker/jobs/account-offboarding/failure-alert.ts` is the one
emitter: per-step constant message, `[message, terminal, <offboarding id>]` at
`error` or the shared `[message, retry]` at `warning`, a Sentry throw swallowed.
All three workers alert AFTER their durable marks and alert the not-found
branch as terminal under the dispatched id. The purge load sits in its own try:
a terminal throw marks `failed` / `failed_step='purge'` by the payload's ids.
`checkStrandedAccountOffboardings` runs LAST in `runHealthChecks`, isolated:
one `account_offboarding_stranded:<id>` error finding per offboarding whose
newest billing/teardown/purge outbox row is `failed` while the offboarding is
neither terminal nor `failed`; a re-drive's newer row silences the old one.
Runbook rules 17 (teardown) and 18 (billing) join rule 16 — all three still
REQUIRED and unconfigured — and `failure-alert.test.ts` pins each rule's own
table row to the exported constants (the rule-16 pin moved there from
`PurgeWorker.test.ts`), with #1414's three cheap pins added: one row per rule
name, the trigger cell opens with every event, no `do **not** filter tag`.

**Gotchas.** `account_offboardings_failed_step_check` — a `failed` fixture row
must name its step, which the live-DB case learned first. The health-check
mock queue is positional, so the new check is appended LAST: an exhausted queue
yields `[]`, and no existing push count moved. Mutation pass on the runbook
pins: swapped fingerprints, `terminal equals false`, a duplicate contradicting
row, a first-seen trigger and a renamed message each turned the suite red; the
duplicate-row case first failed at collection time rather than in a named test,
which is why the cells are parsed inside each `it`.

## 2026-09-22 — six single-owner cleanups merged (#1367, #1384, #1414, #1112, #1371, #1403)

Six tickets ran as six parallel agents, each in its own sibling worktree. Each PR passed one strict code-quality review and one five-axis review before merge. The three PRs that change worker code (#1452, #1451, #1448) ran on `staging` together at `9faba471e` before they reached `main`. `staging` was then reset to `main` (`706679fe0`).

| PR | Issue | Squash | What landed |
|---|---|---|---|
| #1449 | #1367 | `075a84498` | `src/lib/approval/transitions.ts`: `markResponseApproved` / `markResponseEdited` / `markResponseSuperseded` for the token, session and callback modes. |
| #1453 | #1384 | `a78174bd3` | The 035/040/045 RLS guard suites now run their migration and compare `readPublicCatalogue` output with pinned literals (two oracles). |
| #1450 | #1414 | `dea5935b9` | Rule 16's runbook row is compared cell by cell with text built from the emitter's exports. The `stripComments` known-limitation test is an `it.fails`. |
| #1452 | #1112 | `c11c514f9` | `insertOutreachRenders` is the only INSERT column list. The single-row function delegates to it. The exhaustion settle writes all holes in one statement. |
| #1451 | #1371 | `eca95b39f` | `CANCELLATION_GRACE_DAYS` + `cancellationGraceDeadline()` in `src/lib/shared/cancellation-grace.ts`. The poller inlines `make_interval(days => …)`. |
| #1448 | #1403 | `706679fe0` | `worker/jobs/send-and-record-strategies.ts`: `sendMarkedFirst` / `sendKeyed`, shared by the drip and the owner nudge. |

**Decisions the review changed.**
- #1449: the first header claimed "single owner for every responses status transition". 14 more sites write their own UPDATE, and they set `updated_at` while the approval lane does not. The header now states the narrow scope, and #1454 lists the other sites.
- #1450: the first version stored the runbook prose as a typed record in `failure-alert.ts`. That broke the emitter-to-runbook link for the fingerprints. The record is deleted. The test builds the cells from the exports, and a fingerprint mutation now turns rule 16 red.
- #1452: the first version kept two copies of the 20-column INSERT. The single-row function now delegates, and `RETURNING id` is gone.
- #1451: the first version added `cancellationGraceExpiredSql`, a helper with one caller. It is deleted. The grace start date still has two owners, tracked in #1455.
- #1448: the first version moved the `bodyVaries` branches into per-worker modules. Now there are two named strategies in one shared module, and both failure logs name the business again.
- #1453: removed checks, each with a reason in the suite header: the SMS policies dropped by 061, the total-policy count (25, now 23), and `notification_preference`, which 022 dropped.

**Gotchas.**
- A squash merge copies every branch commit message into the final commit. The first #1450 commit said "Closes #1414 for rule 16", so the merge closed #1414 even though the PR body said `Refs`. #1414 was reopened. See the lab note of the same date.
- A worktree made with plain `git worktree add` has no `.env*.local`. The pre-push hook then fails the #719 live-DB precondition in `onboarding-drip.integration.test.ts`. Use `pnpm worktree:new`, or copy the env files.
- With six agents sharing one local test DB, `ci:rls-audit`'s live content-hash check failed and `send-breaker.integration.test.ts` miscounted sends (100 vs 101). CI passed every time. The root cause is not proven.

**Follow-ups filed.** #1447 (rules 1–15 and 17–18), #1454 (the remaining transition writers and `updated_at`), #1455 (the grace start date — **closed 2026-09-23**, migration 125 + `resolveCancellationGraceState()`, see `.claude/reference/arch-review-log.md`).

## 2026-09-24 — #1350: Outreach remnant survives a contact Delete (ADR 0033)

**Built.** Migration 126: the asks→contacts, outreach→contacts and outreach→asks FKs become column-scoped `ON DELETE SET NULL`, and their three columns become nullable. `deleteContact` checks ownership, unlinks unsubscribe tokens, deletes in-flight asks with their live attempts, redacts terminal outreach and cuts ask evidence to `{decision, reason}`, then deletes the contact, all in one transaction. The Requests panel leaves remnant asks out. The delete confirm copy names the history.

**Tests.** New live-DB `contact-delete-remnant.integration.test.ts`, including a column-classification guard over both tables and a breaker-window before/after check. The Resend lane suite gains a remnant case.

**Not done.** Migration 126 is not applied to staging or production; the owner applies it, staging first.

