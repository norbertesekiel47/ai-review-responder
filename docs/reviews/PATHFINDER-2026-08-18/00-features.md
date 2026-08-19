# Pathfinder 2026-08-18 — Phase 0: feature boundaries (windowed)

Window: `03db8633..HEAD` — 32 commits, 176 files, +26,814/−5,455 across
`src worker scripts supabase docs/adr`.

Boundaries cover only surface that changed in the window. The 2026-08-15 pass's
F1–F6/S1 are external dependencies except where this window moved them.

## Orchestrator adjustments to the discovery proposal

1. **F7 (public marketing pass) is KEPT and the scope brief was wrong.** Three
   merges — `ecd4924d` #851, `6038642b` #852, `d725d0f5` #862 — are inside the
   window by its own definition and were absent from `SCOPE.md`'s PR list. The
   discovery agent caught this. ~54 files, +3,662/−1,537. Marketing copy is a
   **third class the product counter is blind to**, alongside design-system and
   CI merges, so it belongs in a pass whose stated purpose includes that
   blindness. Charted at reduced depth — its architectural content is thin.
2. **F3 stays ONE feature, under protest, and its flowchart must test that.**
   The two halves share a trust model and a domain but **no import**. The
   flowchart agent is instructed to draw two flows and return an explicit
   verdict on whether the join survives contact with the call graph.
3. **Seed 2 is already refuted as stated.** The arch log says
   `delivery_status IN ('rendered','queued')` is spelled in TWO places. Phase 0
   found **four**: `approval.ts:494`, `approval.ts:1126`, `batch-view.ts:948`,
   plus a superset at `approval.ts:1146` / `ask-generation.ts:895`. The log's
   "a third caller would make it a real seam question" precondition is already
   met. This is a Phase 2 lead, promoted.
4. **Seed 1 (`latchHalt` as its own module) is rejected as a BOUNDARY**, not as
   a question. Both halt verbs open with `lockBatchForAction` and both refuse
   `pending`; extracting the latch alone splits one lock-order argument across
   two files. Whether `approval.ts` (1,178 lines) wants an internal split is a
   Phase 3 question.
5. **Depth tiers for Phase 1**: full — F1, F2, F4, F5. Medium — F3, F8, F9.
   Light — F6, F7.

---

### F1. Send batch approval lane — the five human-triggered writers
**Purpose**: Turn a decision about a built Send batch (approve / halt / regenerate
one ask / withdraw one ask / admin-halt) into one transactional write plus its
run-spine step and audit row.

**Entry points**
- `src/app/api/dashboard/solicitation/batch/approve/route.ts:71` — owner approve + exclusion set
- `src/app/api/dashboard/solicitation/batch/halt/route.ts:54` — owner halt
- `src/app/api/dashboard/solicitation/batch/regenerate/route.ts:55` — per-ask regeneration
- `src/app/api/dashboard/solicitation/batch/withdraw/route.ts:52` — per-ask withdrawal
- `src/app/api/admin/solicitation/batch/halt/route.ts:100` (exported `:161`) — AAL2 operator halt

**Core files**
- `src/lib/solicitation/approval.ts:112` `canonicalBatchId` · `:144` `lockBatchForAction` (shared opening of all five) · `:225` `approveBatch` · `:468` private `latchHalt` · `:587` `haltBatch` · `:672` `adminHaltBatch` · `:801` `requestAskRegeneration` · `:995` `classifyWithdrawal` · `:1048` `withdrawAsk`
- `src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts:111` `withScopedBatch` (flag-gate → owner-auth → uuid-parse → tx); `:46/:63/:76` three `readInput` shapes
- `src/app/api/dashboard/contacts/location-scope.ts:66` `requireSolicitationSendWriteAccess`
- `src/lib/solicitation/outreach.ts:317` `closeBatchIfSettled` (single terminalizer; `:321` lower-cases the batch id, #858)
- `src/lib/solicitation/ask-generation.ts:1242` `isRegenerableBatchState` · `:1307` `regenerateAsk`
- `src/lib/agents/run-spine.ts:71-74` — four new `STEP_PERSONA` keys
- `supabase/migrations/108_…`, `109_…` — the two CHECK widenings
- `src/lib/costs/tracker.ts:398` `peekBudgetBatch` · `:487` `peekAskRegenBudgetBatch` · `:88` ask-id lower-casing

**Terminal states**: `approved_at`+`veto_deadline_at`, or `halted_at`+`halt_reason`;
N `solicitation_outreach` rows `cancelled` with `disposition_reason` in
`{owner_excluded, owner_withdrawn, <halt reason>}`; an `agent_run_steps` row; an
`account_audit_log` row; possibly `send_closed_at`. HTTP: discriminated JSON,
uniform 404 for foreign/unknown batch.

**Window PRs**: #863/#629, #873/#860, #876/#865, #883/#872, #868/#858, #870/#859.

**Rationale**: One feature, not five — all share one opening (`:144`), one lock
order (`approval.ts:34-41`), one terminalizer, one refusal grammar. Not split
from the admin arm: `adminHaltBatch` and `haltBatch` share `latchHalt` verbatim.
Splits from `ask-generation.ts` on the actor axis — every signature here carries
an actor, none there does.

**Overlap**: F2 (client mirror), F3 (`adminHaltBatch`), F5 (`recordSuppression`
sibling). **Four-way row-predicate duplication, see adjustment 3.**

---

### F2. Requests owner surface — the Send lane read model and approval panel
**Purpose**: Show one batch's asks; let the owner deselect / regenerate / withdraw /
approve / halt; reconcile the screen after every write and on a poll.

**Entry points**
- `src/app/(authenticated)/dashboard/requests/page.tsx:13` → `RequestsClient.tsx:87`
- `src/app/api/dashboard/solicitation/batch/route.ts:27` `GET` — the only read door
- `src/app/api/dashboard/solicitation/batch/reviewed/route.ts:26` `POST`

**Core files**
- `src/lib/solicitation/batch-view.ts:773` `readLatestBatch` (REPEATABLE READ / READ ONLY) · `:736` `attachRegenBudgets` (Upstash peek, deliberately outside the tx) · `:1004` `markBatchReviewed` · `:122`/`:169`/`:203` the view types
- `.../RequestsClient.tsx:68` `RefetchMode = Exclude<LaneRefresh,'none'>` · `:87` · `:423` `useLatestBatch` · `:583` `useReviewedPing`
- `.../ApprovalPanel.tsx:169` `panelMode` · `:334-433` exclusion set · `:434-851` **"The write"** (copy maps `:482`/`:505`, `useLaneWrites:772`) · `:852-937` `usePendingRegeneration` · `:938-985` `useArmedWithdrawal` · `:1005` component. **1,109 lines.**
- `.../AskList.tsx:161`/`:248`/`:293` three list variants · `:208` `RegenerateControl` · `:336` `WithdrawControl`
- `.../ApprovalActions.tsx:51` · `.../requests.css` (606 lines)
- `src/lib/shared/dashboard-regen-rate-limit.ts:52/:102/:156`

**Terminal states**: a settled `PanelMode` (`ApprovalPanel.tsx:149-168`) plus a
`LiveRegion` announcement, or `Phase` = failure card (`RequestsClient.tsx:361`).

**Window PRs**: #863, #873, #883, #869.

**Rationale**: Separate from F1 — different terminal states and different failure
vocabularies. `LaneWriteOutcome`/`LaneRefresh` (`:711`/`:730`) exist only because
the client cannot always learn which happened. Separate from F3 — the read models
genuinely diverge (`readLatestBatch:773` vs `readAdminBatchSummary:929`), both in
`batch-view.ts` (1,021 lines), no shared row shape. **Seed 11 confirmed.**

**Overlap**: F1 verb-for-verb; F3 (`HaltReason` copy map at `ApprovalPanel.tsx:277`
vs `SolicitationBatchPanel.tsx:47` — two exhaustive maps over one union); F6.

---

### F3. Admin solicitation console — Send batch panel + suppressions correction receipt
**Purpose**: Give an operator, under AAL2, a read of the latest Send batch with a
halt control, and a suppressions lookup whose correction receipt names a human
and clears itself.

**Entry points**
- `src/app/admin/businesses/[id]/page.tsx:39-46` — third sequential `sql` read
- `src/app/api/admin/solicitation/batch/halt/route.ts:100` — `requireAdminWithAal2` first, `businessId` from the BODY
- `src/app/admin/suppressions/SuppressionsClient.tsx:638` `correction`

**Core files**
- `.../SolicitationBatchPanel.tsx:264` (476 lines) · `:47` `HALT_REASON_LABELS` · `:73` `NON_ACTIONABLE_COPY` · `:116` `HALT_REFUSAL_COPY` · `:198-241` the `useReducer` halt machine
- `src/lib/solicitation/batch-view.ts:929` `readAdminBatchSummary` · `:853` `AdminBatchSummary`
- `.../BusinessDetailClient.tsx:143-156` `initialBatchSummary` (server-read once; `invalidate()` → `router.refresh()`)
- `src/lib/admin/suppressions-service.ts:63` `lookupSuppressions` (`LEFT JOIN users`) · `:134-138` `removedByUserLabel` · `:210` `correctSuppression`
- `.../SuppressionsClient.tsx:254-257` label cell · `:641` `entry.reset()`

**Window PRs**: #876/#865, #882/#665+#662.

**Rationale**: The trust model is the boundary — AAL2 + `businessId` from the body
(the account-scope-vs-cookie-scope asymmetry the 2026-08-15 pass locked as
DO-NOT-UNIFY). Not part of that pass's F1: it adds a third independent read to the
same page and never touches churn derivation.
**CONTESTED — the two halves share no import. The flowchart must adjudicate.**

**Overlap**: F1 (`adminHaltBatch`), F2 (duplicated copy maps), **seed 4** — the
`useReducer` shape at `:198-241` is the fifth instance (#880).

---

### F4. Solicitation email lane — Sending identity out, tag-discriminated signals back
**Purpose**: Put one ask on the wire under a separate sending identity, and route
the resulting Resend events to outreach rows, never to notification-delivery rows.

**Entry points**
- `src/lib/messaging/messaging-adapter.ts:71` `getMessagingAdapter()` — **no production caller yet** (honest-scope note `:7-11`)
- `worker/index.ts:635` `app.post('/ingress/resend', …)`
- `worker/index.ts:536` `assertSolicitationSendEnv()` — boot gate

**Core files**
- `src/lib/messaging/email-adapter.ts:21`/`:28` `send`/`:91` `assertSendable`/`:129` `resolveFromAddress`
- `src/lib/messaging/lane-tag.ts:27`/`:30` — the cross-module routing contract, deliberately import-free (`:15-24` says why)
- `src/lib/notifications/email/client.ts:27` `getSolicitationResend` — the second client
- `src/lib/notifications/email/headers.ts:17` `'solicitation'` · `:158` `solicitationHeaders` · `:196` `getEmailTags`
- `worker/ingress/resend.ts:180` `processResendEvent` → `:191` the `isSolicitationLane` fork, **before any delivery-row lookup**
- `worker/ingress/resend/solicitation-lane.ts:36`/`:152`/`:218` `withAttribution` (single tx owner)/`:269,:305,:332,:372` four signal writers
- `worker/ingress/resend/bounce-classifier.ts:18`/`:79` — extracted so the lane pulls no Resend SDK
- `src/lib/config/server.ts:210-220` · `worker/config/startup-assert.ts:462`

**Terminal states**: outbound — a `providerMessageId` or a throw. Inbound — exactly
one `solicitation_outreach` UPDATE (asserted, `:263`) plus an optional ledger row,
then 200; an unmatched id either warns or throws by event.

**Window PRs**: #853/#657.

**Rationale**: One feature despite two directions and two runtimes — the tag is a
closed loop emitted at `email-adapter.ts` and read at `solicitation-lane.ts:36`
with **no compiler binding between them**. `lane-tag.ts:8-11` states the failure
mode: silent mis-route, zero rows updated, 200 ack, signal lost permanently.
Charting the halves separately would put that contract on no chart at all.

**Overlap**: F5 (`recordSuppression`); `worker/ingress/resend.ts:216`
`handleEmailBounced` now shares `bounce-classifier.ts` — one classifier, two
callers, the second-use extraction.

---

### F5. Unsubscribe redemption — dedicated pool, plain transaction, recipient-facing ingress
**Purpose**: Redeem a one-click unsubscribe token exactly once into a global
suppression, from the RFC 8058 machine POST or the browser button, without
starving the shared write pool.

**Entry points**
- `worker/ingress/unsubscribe.ts:76` `registerUnsubscribeRoutes` (registered `worker/index.ts:650`) · `:94` POST · `:178` GET
- `src/app/api/u/[token]/route.ts:26` POST
- `src/app/(public)/u/[token]/page.tsx:44` render, re-asks the ledger at `:97-98`

**Core files**
- `src/lib/db/server.ts:153-160` `UNSUBSCRIBE_POOL_MAX = 2` behind `withAdmissionControl` · `:215-226` shutdown close order
- `src/lib/solicitation/unsubscribe.ts:368` `redeemUnsubscribeToken` (takes `Sql`, owns its own `db.begin`; `:362-366` says why a plain `begin()` is the only legal constructor) · `:85` `isWellFormedUnsubscribeToken` · `:153`/`:163` receipt mint/verify · `:274` `redemptionConfirmsSuppression` · `:443` `hasLiveGlobalSuppressionForToken`
- `src/lib/solicitation/suppression.ts:226` `recordSuppression` — first-write-wins
- `worker/ingress/unsubscribe.ts:45` `UNSUBSCRIBE_ROUTE_OPTS` (rate-limiter exemption + 1 KB cap, owned here) · `:342` `createRedemptionSingleFlight` · `:449` `createUnknownTokenReporter`

**Terminal states**: `redeemed_at` stamped + a global ledger row; a 303 to
`/u/<token>[?ok=<receipt>]`, or a 200/`unknown_token` indistinguishable response.
The landing page may claim success only from a live ledger read during that render.

**Window PRs**: #857/#651, #866/#652.

**Rationale**: Two runtimes and three entry points converge on one redemption
contract and one pool — and #651/#652 is precisely a fight over where the
transaction boundary lives. Splits from F4: nothing imports across except
`recordSuppression`. Splits from F3: the operator **Correction path** removes what
this path writes, through a different sink.

**Overlap**: F4, F1 (both "one transactional write + a discriminated status"),
`src/lib/db/admission.ts`.

---

### F6. Three-tier design system — one token owner per surface  *(light)*
**Purpose**: Make "redesigning one surface touches exactly one token file, one
`@theme` block, and the components under one selector" a checkable property.

**Entry points**: `src/app/globals.css:1-2` and `:151-154` (four Island page
imports, order load-bearing per `:133-149`) — the single CSS composition root;
`src/__tests__/design-scope-purity.test.ts:1` — the guard that makes it enforceable.

**Core files**: `globals.css` (2,557 → 154 lines, now the Island token file only) ·
`(public)/_styles/{island,features,how-it-works,pricing}.css` (1,063/255/673/673) ·
`(authenticated)/_styles/tokens.css` (255, scoped to `.rw-console`), `theme.css`
(48), `console.css` (2,262) · `design-scope-purity.test.ts:32-40` ·
`design-token-single-source.test.ts` · `design-doc-token-pin.test.ts` ·
`src/__tests__/helpers/css-tokens.ts:10,32,54,81,88,95` (the shared parser) ·
`(authenticated)/dashboard/connect/page.tsx` (the one component change)

**Window PRs**: #843, #844, #846, #845 — **none counted by the product counter.**

**Rationale**: A feature, not a chore — the deliverable is an enforced invariant
with its own test surface (488 guard lines + a 110-line shared parser), not a file
move. Distinct from F7: F6 moved *where tokens are declared* and changed no
rendered pixel. Commit sets are disjoint.

---

### F7. Public marketing surface pass — native scroll, truth-matched copy, per-plan lead doors  *(light)*
**Purpose**: Make the marketing funnel's claims match the shipped product, remove
the scroll-hijack layer, and let a visitor express tier interest from a pricing door.

**Entry points**: `src/app/(public)/page.tsx:14` → `LandingExperience.tsx:94` ·
`features/page.tsx:12`, `how-it-works/page.tsx:12` (all three now read
`trialPeriodDays()`) · `pricing/PricingContent.tsx:262` ·
`src/app/api/lead-intake/route.ts:209`

**Core files**: `LandingExperience.tsx:58-64` (the note recording that Lenis + snap
+ dissolve + chapter rail were removed **together**; four deleted files, −720
lines) · `sections/features/*` (11) and `how-it-works/*` (7) — the truth pass ·
`PricingContent.tsx:130/:134/:187` `PlanCopy` + `onPlanInterest` ·
`LeadIntakeForm.tsx:19` `LeadPlanInterest`, `:41/:58/:236` the optional field ·
`api/lead-intake/route.ts:22` `ALLOWED_PLANS`, `:137-141` absent→null,
`:160-183` `buildLeadMetadata` — **`planInterest` lives in metadata, never a
column** · `src/lib/payments/flags.ts:71` `trialPeriodDays()` (three-caller
extraction)

**Window PRs**: `ecd4924d` #851, `6038642b` #852, `d725d0f5` #862 — **absent from
the original scope brief; see adjustment 1.**

---

### F8. CI enforcement surface — tenant scope, directory map, edit surface, doc shape  *(medium)*
**Purpose**: Convert four architectural rules that depended on reviewer attention
into failing CI checks.

**Entry points**: `scripts/ci/tenant-scope-audit.ts:2092` · `directory-map-audit.ts:261`
· `feature-surface-audit.ts:253` · `src/__tests__/ci-audit-wiring.test.ts:71` (the
meta-check that package.json, the workflows and `lefthook.yml` cannot drift)

**Core files**: `tenant-scope-audit.ts` (2,076 → **2,181 lines**): `:1062`
`analyzeQueryBlock` · `:1217` `findAllowlistIntegrityFindings` · `:1308`
`auditSqlText` · `:1810` `extractSqlTemplates` (JS template lexer) · `:2046`
`auditSourceText` — **three lexers/analyzers in one file, seed 7** ·
`tenant-tables.ts:1` `TENANT_TABLES`, `:125` `TENANT_SCOPE_COLUMNS` ·
`tenant-scope-allowlist.ts:149` `ALLOWLIST_BASELINE = 381` (was 414) ·
`directory-map-audit.ts:180`/`:215`/`:45` · `feature-surface-audit.ts:54`/`:78`/`:99`
· `claude-md-shape.test.ts:28-31`

**Window PRs**: #847, #848, #870/#859, #875/#867, #850, #849, #854.

**Rationale**: One feature — all four scripts are consumed by one wiring contract
(`ci-audit-wiring.test.ts:71-114`, incl. the `CI_ONLY_BY_DESIGN` carve-out at `:38`)
and one lefthook mirror. They are one gate, not independent tools.

**Overlap**: every SQL-writing feature is a subject. **Seed 9** — the audit forms
no opinion on any table outside `TENANT_TABLES:1`, and 381 allowlist entries carry
no in-code marker separating "reviewed and exempt" from "never in scope".

---

### F9. Account purge verifier — tombstone completeness  *(medium)*
**Purpose**: Prove, after a purge, that every column on a tombstoned `businesses`
row is either scrubbed or provably tombstoned.

**Entry point**: `src/lib/account-offboarding/purge-verification.ts:39`
`verifyAccountOffboardingPurge`

**Core files**: `:74` `verificationQuery` · `:110-152` the `businesses` OR-chain
(**27 columns**) · `:35` `PURGE_VERIFICATION_SQL_TABLES` · `:731` `absentByBusiness`
· `:120` `b.tone IS DISTINCT FROM 'professional and friendly'` (restored-to-default
exception, and why `<>` is wrong for a nullable column) · `:150` `b.archived_at IS
NULL` (**not a residue check at all**) · `:113-136` the six columns #882 added

**Window PRs**: #882/#665+#662.

**Rationale**: Smallest feature here (+20 production lines), kept because it is a
complete end-to-end with its own terminal state and because **seed 10 is confirmed
in source**: one OR-chain now mixes three predicate KINDS — residue, restored-default,
never-tombstoned — with nothing structural distinguishing them.

**Overlap**: F5 (`redeemUnsubscribeToken:400-405` documents racing this purge's
scrub — the RETURNED values, never a prior read); F1 (the ABBA lock-order hazard
`approval.ts:36-38` names is against this purge).

---

## Boundaries rejected

- **`closeBatchIfSettled` as a feature** — one function, seven callers. F1's terminalizer.
- **`latchHalt` as a "halt lane" module** — see adjustment 4.
- **`sqlUnsubscribe` / the admission chokepoint** — `db/server.ts:153-160` is a pool declaration; `db/admission.ts` did not change. F5's infrastructure.
- **`scoped-batch-route.ts`** — 145 lines, four callers, all in F1. F1's route seam.
- **The `useReducer` admin-form shape (#880)** — a duplication finding across five surfaces, one of which changed. Phase 2 input.
- **`bounce-classifier.ts`** — 86 lines, two callers, both in F4.
- **`lane-tag.ts`** — two constants. F4's defining contract, on F4's chart.
- **`src/lib/costs/tracker.ts`** — its window change exists only to serve F1's regenerate verb.

## Coverage check — changed non-test files owned by no feature

- `src/lib/config/server.ts` — **spans two features**: the four `SOLICITATION_*` entries are F4, the `TRIAL_PERIOD_DAYS` comment is F7. Both flowchart agents must know.
- `src/lib/payments/flags.ts:71` — F7 only.
- `worker/index.ts` — composition root; two lines (`:76`, `:536`), charted as F4's boot entry.
- `src/lib/agents/run-spine.ts:71-74` — four keys, F1's.
- `src/app/api/dashboard/contacts/location-scope.ts:66` — one preamble, F1's.
- `scripts/{arm-check.sh,feature-setup.sh}`, `scripts/ci/self-hosted-runner/*` — no runtime path; F8 for completeness, no flowchart value.
- `docs/adr/{0009,0020,0021}` — evidence, not charted.

## Known gaps carried into Phase 1

1. ~13,000 lines of new test files unread — no feature's test surface was verified against the boundary drawn.
2. `suppression.ts` read only at `recordSuppression:226`; F5's ledger semantics are taken from callers' comments.
3. `console.css` (2,262) and `island.css` (1,063) unopened; F6's boundary comes from the import graph and the guards.
4. **Seed 8 is not verifiable from source** — `ALLOWLIST_BASELINE` is 381 and no entry carries a "provable" marker. Confirming it needs a `--no-allowlist` run.
