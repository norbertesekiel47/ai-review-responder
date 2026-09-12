# Handoff prompts — Pathfinder 2026-09-12

Every handoff is **issue-shaped**: a title a `/feature` run can take, an
acceptance clause, and the evidence. Every finding says **LIVE** or **LATENT**.

> **This pass files its own issues.** `07-handoff-reverification.md` §F shows
> the mechanism in a controlled experiment: the 08-18 pass's H1–H7 got issue
> numbers **#890–#896** and 3 of 3 tracked items landed; the 08-24 and 08-26
> passes' handoffs got prose and **0 of 6 landed** across two windows. The
> `gh issue create` block at the end of this file is part of shipping the
> pass, not a follow-up to it.

---

## H1 — Owner Operator Run B pre-work · **DO FIRST, three separate PRs**

Three small changes Run B needs. Each stands alone; none is more than ~30
lines of production code. **All three are LATENT today** —
`OWNER_OPERATOR_ENABLED` is unset everywhere (`docs/currents.md:16`;
`readFlag` = `process.env[name] === 'true'`, `src/lib/config/flags.ts:21-23`).

### H1-A — `/api/operator` joins the owner-API MFA allowlist · **HIGH**

> **Title:** `fix(auth): /api/operator routes get the owner-API AAL2 gate`
> **Acceptance:** `isProtectedOwnerApiRoute('/api/operator/turns')` returns
> `true`; a test in `src/lib/shared/__tests__/protected-routes.test.ts`
> asserts it for `/api/operator`, `/api/operator/turns`,
> `/api/operator/conversation` and the two Run B routes.

```
$ rg -n 'operator' src/lib/shared/protected-routes.ts \
                   src/lib/shared/__tests__/protected-routes.test.ts
(no output)
```

`isProtectedOwnerApiRoute` (`src/lib/shared/protected-routes.ts:47-59`) names
`/api/dashboard`, `/api/settings`, `/api/account`, `/api/billing`,
`/api/locations` and three Zernio paths. **`/api/operator` is in none of
them**, so proxy branch 6 (`src/proxy.ts:349-364`) — which applies
`getAalGate()` (`:260-271`) — never runs for an Operator route.

**Say this plainly in the PR body.** The routes are **not** unguarded:
`withSameOrigin()` (`turns/route.ts:101`) and `requireWritableOwner`
(`:37` → `route-helpers.ts:133-146`) give role + `account_id` +
writable-subscription + the `isProcessingBlocked` offboarding gate.
**The missing piece is AAL2/MFA only.** It is **LATENT on two independent
grounds** — the flag is off, and `getAalGate` returns `'ok'` whenever
`mfaEnforcementEnabled()` is false (`src/proxy.ts:261-263`,
`src/lib/auth/flags.ts:33-35`). **This pass did not read the deployed
`MFA_ENFORCEMENT_ENABLED` value. Not an incident.**

**Why it is still first:** Run B's whole content is two POST routes moving
owner state — voice config now, auto-approval policy later — and
`PATCH /api/settings/voice` changes the same rows behind the MFA bar. Ship the
asymmetry and it becomes invisible.

**Guard:** do not add a fourth branch to `proxy.ts`. One entry in the existing
allowlist.

### H1-B — Extract `hasImpersonationCookie` before Run B adds copies 3 and 4 · **HIGH**

> **Title:** `refactor(auth): one owner for the impersonation-cookie check`
> **Acceptance:** exactly one definition in the repo; both existing call sites
> import it; `rg -c 'function hasImpersonationCookie'` returns 1.

Two byte-identical private copies today:
`src/app/api/operator/turns/route.ts:97-99` and
`src/app/api/settings/auto-approval/route.ts:116-118`, both
`Boolean(request.cookies.get(IMPERSONATION_COOKIE_NAME)?.value)`.
`src/lib/admin/impersonation/cookie.ts` exports the cookie **name** (`:38`)
and sign/verify helpers (`:23-36`) — **no boolean-check export exists**.

Run B's `apply` and `decline` both need it (an impersonating admin may look,
never act — `turns/route.ts:40-44`). **Land this before Run B, or the fix
costs four edits instead of two.** Put it in `src/lib/auth/route-helpers.ts`
beside the other gate helpers, or in `impersonation/cookie.ts` beside the
name. LATENT.

### H1-C — Export `patchAutoApprovalSettingsInTransaction` · **HIGH, Run B is blocked on it**

> **Title:** `refactor(auto-approval): a transaction-aware policy writer for Apply`
> **Acceptance:** `patchAutoApprovalSettingsInTransaction(tx, input)` is
> exported from `src/lib/auto-approval/settings.ts`;
> `patchAutoApprovalSettings` remains the thin `sql.begin` wrapper both
> existing callers use; behaviour (locks, exposure classification,
> archived-policy rule, readiness, confirmation, `writeAccountAuditLog`) is
> unchanged, pinned by the existing suite.

```
$ rg -n 'patchAutoApprovalSettingsInTransaction' .
docs/roadmap/2026-09-11-owner-operator/README.md:397
docs/roadmap/2026-09-11-owner-operator/README.md:532
docs/superpowers/plans/feat-owner-operator-run-a-intake.json:16
docs/superpowers/plans/feat-owner-operator-run-a-plan.md:19
```

**Four hits, all specs. Zero in code.** `patchAutoApprovalSettings(sql: Sql, …)`
(`settings.ts:199-209`) is narrowed to `Sql` and opens its **own** `sql.begin`
at `:206`, so Apply cannot call it from inside Apply's transaction. The
transaction-aware pieces `updatePolicyInTransaction` (`:216`) and `lockAccount`
(`:379`) are **module-private** — `rg -n '^export' src/lib/auto-approval/settings.ts`
lists only the two types, the error class, `getAutoApprovalSettings` and
`patchAutoApprovalSettings`.

**The spec already chose the shape** (`README.md:532`) and `README.md:643`
lists it as an accepted Run A finding. **Do it the spec's way** — export the
in-transaction function, keep the wrapper — rather than a parallel executor.
Two real callers to re-check: `src/app/api/settings/auto-approval/route.ts:57`
and `scripts/ws8-staging-smoke.ts:500`.

### H1-D — Correct the Run B intake's dashboard-reuse premise · **docs-only, do with H1-A**

> **Title:** `docs(operator): Run B's summary panel reuses the granular reads, not the dashboard payload`

Measured field by field (`03-unified-proposal.md` U1-G,
`01-flowcharts/F5-console-harbor-dashboard.md` §2):

| Field | Verdict |
|---|---|
| rating band | **present-but-shaped-wrong** — `ReputationSummary.averageStar` (`types.ts:33`) and `RatingBreakdown` (`:58-62`) bucket **all** rated reviews; the Operator wants **pending drafts by star** (`catalog.ts:132`). Run A's `readStarBands` (`operator/context.ts:192-232`) is the right reader |
| pending count | **present, already reused correctly** — `getPendingApprovalCountsForAccount` (`src/lib/dashboard/pending-count.ts:35-55`) at `operator/reads.ts:236` |
| posted count | **absent** — `totalReviewsHandled` (`types.ts:66`) is all-time; `recentReviewCount` (`:213`) is a capped *received* sample. Run A's `readPosted7d` (`context.ts:241-251`) is correct |
| location list | **absent from the per-location DTO** (`types.ts:107`). Roster is `getLocationsForAccount` (`src/lib/locations/repo.ts:64`) |

Both dashboard builders take `sql` and need no React context
(`service.ts:129-140`, `aggregate-service.ts:92`) — that half of the premise
holds. But importing the assembled DTOs drags in a 45 s Redis TTL cache
(`service.ts:64`), ranking, velocity and briefs, **and two of four fields
would still be wrong.**

**Run A's pattern — call the granular helpers — is correct. Say so in the
spec so Run B does not "fix" it.**

---

## H2 — The entropy counter gets ONE owner · **HIGH**

> **Title:** `feat(ci): the arch counter becomes a derivation, not a judgement`
> **Acceptance:** every `ci:merge-ledger`-triggering PR writes a line keyed by
> merge SHA carrying `counts: true|false` from `isProductionFile`; the counter
> in the header is reproducible by `grep -c 'counts: true'` since the last
> reset; a test asserts the audit fails a line missing the key or the boolean.

This is the 08-26 pass's H7, unlanded. **The error grew from 4 to 62 in
seventeen days** (21 stated, **83** measured — `SCOPE.md`). Seven passes, six
wrong counters.

**The audit already computes the answer and discards it.** `classifyDiff`
(`scripts/ci/merge-ledger-audit.ts:111-117`) returns
`{production, governance}` on every run. `counts = production.length > 0`.

**Two things this window adds to the case:**

1. **The log convicts itself twice, in its own prose.**
   `arch-review-log.md:306-316` (*"six of those merges were never recorded
   here… recovered MECHANICALLY rather than by reading this file"*) and
   `:427-431` (*"**The count lags reality** — #1069, #1071, #1073, #1074,
   #1075, #1097, #1098 and #1099 all merged with production changes and no
   entry… **Eight unrecorded merges… reconciling them is the next
   architecture pass's job**"*). **This is that pass. The reconciliation is
   62, not 8.**
2. **The bullet list stopped being maintained entirely after 2026-09-04.**
   The last 39 counted merges (#1140 → #1270, 2026-09-06 onward) have **no
   bullet at all** — the whole Admin split wave and Owner Operator Run A.

**Mark the 17 governance-only merges.** They were required by CI to leave a
line and required by the rule not to increment. Under the SHA + boolean design
they classify themselves. Under today's they are indistinguishable — reason 3
of the four the log already lists.

**Guard:** do not make the audit write the number. It should write the
`counts` boolean per merge; the header number stays a query a pass runs.

---

## H3 — Import the Stripe retry-policy owner at the two sites that shadow it · **HIGH — the pass's only LIVE behavioural divergence**

> **Title:** `fix(offboarding): two Stripe call sites shadow isRetryableStripeError by name`
> **Acceptance:** `rg -n 'function isRetryableStripeError'` returns exactly
> one definition (`src/lib/account-offboarding/stripe-retry-policy.ts:61`);
> both sites import it; a test asserts a socket-code error is classified
> retryable at both call sites.

| | `file:line` |
|---|---|
| owner (reads the vocabulary sets, handles 4xx/5xx, **then falls through to `RETRYABLE_NETWORK_ERROR_CODES`**) | `src/lib/account-offboarding/stripe-retry-policy.ts:61-79` |
| private copy A — guards `stripe.subscriptions.cancel` at `:104` | `worker/jobs/account-offboarding/teardown-stripe.ts:121-134` |
| private copy B — guards `stripe.subscriptions.update` at `:117`, **byte-identical to A** | `worker/background/pollers/AccountOffboardingReactivationResetPoller.ts:175-188` |

Both copies hardcode four type strings, do 429-or-≥500, and have **no
socket-code branch at all**.

- **Is it wrong?** Yes — #1126's stated goal was one owner *for this lane*,
  and both copies are in it.
- **Is it reachable?** **Yes, routinely.** Copy A runs on every `delete_data`
  teardown with an active subscription; copy B on every stale-claim recovery
  cycle. A retryable type in the vocabulary but not in the four strings, or
  any socket-level `code`, is silently **non-retryable** at these two sites
  and correctly retryable at the other two. **LIVE.**

**The reason it ranks this high is the shadowing, not the duplication.** The
copies carry the *same identifier* as the shared export, so a reader in either
file sees `isRetryableStripeError(err)` and assumes it is the owner.

**Ride along (one line):** `src/lib/payments/stripe-error-inspect.ts:9-15`
still names `stripe-invoices.ts` as the module that *"applies its own retry
policy"* — true before #1126, false now.

---

## H2-N — One claim contract for the notice family, and the bounced check moves with it · **HIGH**

> **Title:** `refactor(notifications): one claim contract for the six-member notice family`
> **Acceptance:** `delivery.ts` exposes one parameterised claim function;
> every member reaps a stale row and distinguishes `settled` from `pending`;
> `worker/jobs/auto-post-notice/dispatch.ts` skips a bounced owner email; a
> test asserts all six members behave identically on a stale row and on a
> bounced owner.

This is the 08-24 pass's H1 + H2, re-issued by 08-26, **still 0 of 2 landed —
and the surface grew 150% while they sat.**

**The claim contract went from 2 functions to 5.** `delivery.ts:84`, `:113`,
`:143`, `:194`, `:278` — 440 lines, **no shared helper**. They differ on
exactly two axes, giving three variants: no reap (2), reap only (1), reap +
settled/pending split (2). The middle variant (`pending-post-notice`) is
**newly catalogued by this pass**; 08-24 recorded only two.

**BUG 1 is still live in code.** `rg -n 'bounce' worker/jobs/auto-post-notice/`
→ **no output**; the directory is `AutoPostNoticeWorker.ts`, `context.ts`,
`dispatch.ts`, `errors.ts`. Every sibling has a check
(`escalation-notice/dispatch.ts:91-94`, `pending-post-notice/dispatch.ts:101-104`,
`solicitation-veto-notice/dispatch.ts:85-88`,
`autonomy-suspended-notice/dispatch.ts:49-51`). **The auto-post email template
itself references the flag** (`src/lib/notifications/email/templates/auto-post-notice.ts:13`)
while the dispatcher that sends it does not read it. `worker/ingress/resend.ts`
still enrols `auto_post_notice` in `OWNER_DIRECTED_TEMPLATES`.
**LATENT in effect** (needs `AUTO_APPROVAL_ENABLED`), **LIVE in code**.

**Eleven private gating sites** for the same check today
(`07-handoff-reverification.md` §D). Five of the six context modules already
run the same business + offboarding query — put the check where the query is.

**Start with the cheapest step, as proof the consolidation is tractable:**
extract `resolveExistingClaim(sql, {…, template})` from the byte-identical
`delivery.ts:249-259` ≡ `:327-337`. It is private to one file and touches
**nothing** the DO-NOT-UNIFY register protects (the register covers the claim
helpers' `ON CONFLICT` **key columns**, `delivery.ts:80-82`, which stay
per-member).

**Guard:** `autonomy-suspended-notice/context.ts:59-116` is account-first, not
business-first, because autonomy suspension is account-scoped (invariant #11).
**Do not fold it into the shared context builder.**

---

## H4 — Three `boundedErrorClass` copies import the hardened export · **MEDIUM**

> **Title:** `refactor(worker): one boundedErrorClass`
> **Acceptance:** `rg -n 'function boundedErrorClass'` returns exactly one
> definition; the other three files import it.

Four copies. The **export** is the hardened one; the three **private** copies
are byte-identical to each other and weaker.

| | `file:line` | Body |
|---|---|---|
| exported | `worker/jobs/solicitation-batch/failed-hook-shared.ts:36` | `err.constructor.name` validated against `/^[A-Za-z][A-Za-z0-9_$]{0,99}$/` |
| private | `worker/job-failure-sink.ts:59` | `err.name.slice(0,100)`, no validation |
| private | `worker/jobs/csv-ingest/failed-hook.ts:94` | identical to the above |
| private | `worker/jobs/judge/failed-hook.ts:39` | identical to the above |

The arch log's *"five collapsed to four"* is **verified true** —
`worker/jobs/agent-turn/failed-hook.ts:8` imports the shared one.

A custom `Error` subclass setting a `.name` with structuring characters is
sanitised on one path and not on three. **LIVE as an observability
inconsistency** (two hooks can emit different Sentry tag values for the same
error class), **not a safety defect**. Three imports, three deletions.

---

## H5 — Name the "five jobs of the system" once · **MEDIUM, and it is a PRODUCT decision**

> **Title:** `docs(marketing): one owner for the five jobs, or an explicit mapping`
> **Acceptance:** either one shared source consumed by all four surfaces, or a
> written decision recording that the four lists intentionally differ and why.

Canonical: `src/components/sections/landing/jobs/jobs-copy.ts:55-101` —
Respond · **Protect** · Request · Brief · Measure.
`grep -rn "from.*jobs-copy"` → **two importers, both inside `jobs/`.**

| Surface | List |
|---|---|
| `jobs/jobs-copy.ts:55-101` | Respond · **Protect** · Request · Brief · Measure |
| `features/FeaturesContent.tsx:39-63` | Respond · Request · Brief · Measure · **Govern** — the same agents renamed. The comment at `:39-45` **admits** it and does not resolve it |
| `how-it-works/HowItWorksContent.tsx:117-122`, `:131-166` | a 6-step pipeline **plus** 4 loops including **Record**, a concept in neither other list |
| `pricing/PricingContent.tsx:26-52` | prose bullets, **no job labels** |

**LIVE**, reachable by any visitor reading two of the four pages. No test
catches it — the three `*Content.test.tsx` suites each assert their own page.

**This pass does not choose.** (a) one constant with per-page presentation,
(b) a documented mapping, (c) a decision that the pages address different
audiences. All three are legitimate; **silence is not.**

### H5-B — the three cheap UI unifications · **LOW, bundle them**

> **Title:** `refactor(ui): one star-glyph helper, import FeatReceipt, one advisory panel`

1. **`starGlyphs(rating)`** — seven Console reimplementations of
   `clamp → round → '★'.repeat(f) + '☆'.repeat(5-f)`:
   `AttributedReviews.tsx:173-183` · `approval/approval-client.tsx:198-204`
   (whose comment says *"Matches the defensive helpers in the dashboard
   cards"* while importing nothing) · `kpi/ReputationHeroBand.tsx:51-58` ·
   `reviews/EditReplyDrawer.tsx:177-178` · `reviews/PastReplyCard.tsx:148-153`
   · `reviews/ReviewFeedCard.tsx:457-461` · `timeline/TimelineContent.tsx:206-212`.
   **A real divergence hides inside "the same pattern":**
   `AttributedReviews.tsx:182` and `PastReplyCard.tsx:152-153` render empty
   stars as dimmed `'★'`; the other five use the literal `'☆'`. **Leave the
   two marketing copies alone** (`WatchArtifact.tsx:18-20`,
   `MarqueeBackground.tsx:65`) — different design system.
2. **Import `FeatReceipt`** — **the owner is already written**, with a
   docstring saying so (`sections/features/FeatPrimitives.tsx:52-69`), and the
   sibling directory hand-rolls the identical three-cell `.rw-dl-rec` markup
   four times: `how-it-works/{GateArtifact.tsx:68-81, PostArtifact.tsx:40-53,
   TriageArtifact.tsx:21-34, JudgeArtifact.tsx:21-34}`. **This is a
   cross-directory import, not the "collapse the seven step artifacts" the
   08-26 register forbids (X13).** Ride along: export the demo draft sentence
   from `DraftArtifact.tsx:6-7` instead of retyping it at
   `GateArtifact.tsx:20`, `:87`, `HeroFlowArtifact.tsx:78`,
   `PostArtifact.tsx:35`, `JudgeArtifact.tsx:16`.
3. **One `AdvisoryPanel`** inside `src/components/dashboard/reviews/edit-reply/`
   — the byte-identical inline box at `DraftConflictPanel.tsx:25`, `:63`,
   `:100`, `RecoveryPanel.tsx:13`, `ReviewChangedPanel.tsx:13`.

All three LIVE, all safe, none on any register.

---

## H6 — Fix the seven stale prose claims this pass measured · **MEDIUM, all one-liners**

> **Title:** `docs: seven claims that stopped being true`
> **Acceptance:** each line below matches the code at HEAD.

| # | Claim | Truth |
|---|---|---|
| 1 | `.claude/CLAUDE.md:47` — *"18 of 32 topics today"* | **37** topics (`src/lib/shared/queue-names.ts:12-71`), **19** helpers, 18 without. Numerator right by coincidence |
| 2 | `docs/directory.md:39` — `app-admin.md` covers *"overview, jobs, costs, notifications, runbook, `businesses/`…, `locations/csv-import/`, flagged drafts"* | **All deleted.** The target file opens *"After #1193, five pages remain"* (`docs/directory/app-admin.md:5`) |
| 3 | `docs/directory.md:115` — `useAdminActionForm` replaced state in **five** surfaces | **One.** `rg -ln 'useAdminActionForm' src/` → the hook, its test, `ImpersonationStartClient.tsx`. Its whole documented rationale (*"the success channel is a TYPE PARAMETER because measured across the five it is four different things"*) now serves one caller |
| 4 | `docs/adr/0001-…:41-43` — the admin disconnect route uses a *"bearer-aware same-origin wrapper"* | `withSameOriginUnlessBearer` was **deleted** by #1266 (`f4a3441d0`) — the intended end state per ADR 0025 D8 / 0031 D6. Prose only |
| 5 | `src/lib/admin/nav-counts-service.ts:16` — *"behind `requireRoleOr401(admin)`"* | `requireAdminWithAal2` since #1184/#1220 (`nav-counts/route.ts:12`) |
| 6 | `worker/jobs/account-offboarding/purge-stages.ts:757-763` — **"ORDERING (D5)"**: the Stripe redaction stage *"runs LATE"* | It runs **FIRST** (`PurgeWorker.ts:103` before `:104`), and `PurgeWorker.ts:80-101` explains the inversion. Two comments in two files contradict each other |
| 7 | `src/lib/payments/stripe-error-inspect.ts:9-15` — `stripe-invoices.ts` *"applies its own retry policy"* | It is a caller; the policy is `stripe-retry-policy.ts:61` since #1126 |

Also: **`ErrorState` is dead code.** `src/components/admin/ui/states.tsx:22-38`
has zero production importers — `<ErrorState` matches only a *comment* at
`src/app/admin/error.tsx:35`, and the barrel resolves only `EmptyState` and
`TableSkeleton`. `fallow` reports dead exports at 0.0% because the barrel *is*
imported.

---

## H7 — Two working-rule compliance fixes · **LOW**

> **Title:** `chore: import the legacy notice topic constants; no-store on admin error bodies`

1. **Seven hand-typed topic literals.** `'notify_owner_reconnect'` /
   `'notify_owner_connection_lost'` at `worker/jobs/publisher/no-connection.ts:66`
   · `edit-publish-tx.ts:209`, `:223` · `publisher-error-handlers.ts:197`,
   `:211` · `worker/ingress/zernio/zernio.ts:133` ·
   `src/lib/zernio/auth-error-fallback.ts:70`. CLAUDE.md's working rule: *"No
   string literals for … job names — import the constant."* One exported
   constant pair, seven imports. **Leave the alias routing alone** —
   `worker/queues.ts:132-133` deliberately maps both onto `sendOwnerEmail` and
   `scripts/ci/outbox-seam-audit.ts:47-50` explicitly defers judging it.
   LATENT.
2. **`Cache-Control: no-store` on the ~16 admin error bodies** that bypass
   `internalError()`: `src/app/api/admin/costs/route.ts:39` ·
   `nav-counts/route.ts:20` · `jobs/route.ts:45` ·
   `businesses/[id]/route.ts:44`, `:110`, and the rest.
   `internalError()` always attaches `NO_STORE_HEADERS`
   (`admin-mfa-gate.ts:27-30`); these do not. **LIVE, low severity.**

**Guard: do NOT normalise the 36 admin error strings.** ADR 0028 D5
(`docs/adr/0028-admin-api-contract.md:60-65`) explicitly declines that, and
this pass does not re-propose it. **Only the cache-header half.**

---

## H8 — Say that Owner Operator does not use the run spine · **LOW, docs-only**

> **Title:** `docs: the run spine covers Reply/Guardian/Insights, not the Owner Operator`

`grep -rn 'agent_runs\|agent_outcomes\|run-spine' src/lib/agents/operator/
worker/jobs/agent-turn/` → **nothing.** Deliberate — the Operator has its own
four tables (migration 120) — but CLAUDE.md's *"Every persona action is
recorded on the run spine"* reads as universal, and a Run B author applying it
literally will look for rows that do not exist. **One clarifying clause** in
the "What this project is" paragraph or the operator routing row.

---

## H9 — The enumerated-guard completeness rule, finished · **MEDIUM**

> **Title:** `feat(ci): every enumerated guard can fail on an unclassified subject`
> **Acceptance:** `ratchet-harness.ts` fails fatally on `scannedCount === 0`;
> every audit's `SCAN_DIRS` is exported and one `ci-audit-wiring` case fails
> on a production directory covered by zero audits.

The 08-26 pass's PR 2, **partially landed**: the `scannedCount === 0` fatal
exists in **exactly one guard, locally**
(`scripts/ci/pool-fanout-audit.ts:530-539`), not in
`scripts/ci/lib/ratchet-harness.ts` (zero occurrences; docblock `:5-9` still
says *"Each audit still OWNS its SCAN_DIRS"*). **Exactly one** of ~13 audits
exports `SCAN_DIRS` (`pool-fanout-audit.ts:142`); the rest are locals
(`directory-map-audit.ts:66` · `process-env-audit.ts:19` ·
`dropped-columns-audit.ts:51` · `reviews-status-audit.ts:60` ·
`outbox-seam-audit.ts:80` · `db-imports-audit.ts:20` ·
`response-status-audit.ts:39` · `static-policy-audit.ts:50-51` ·
`outbox-topics-audit.ts:50`). No union check exists.

**Both named live consequences persist.** `ci:pool-fanout`'s `SCAN_DIRS` is
still `['src/lib/admin','src/lib/dashboard','src/lib/locations']`, unchanged
since `efd2145d9` (2026-08-23), and
**`src/lib/solicitation/contacts-repo.ts:103`'s two-way `Promise.all` is still
there** (file last touched `ec1150892`, 2026-08-04).
`table-disposition.test.ts:102` still builds its universe from `TENANT_TABLES`
+ an explicit account-linked list, so it **structurally cannot see**
`owner_leads`.

**This window produced two NEW members of the class — the argument for
finally doing it:**

- **`DELETABLE_BY_BUSINESS` (13 tables, `worker/jobs/account-offboarding/purge-helpers.ts:61-75`)
  vs `ABSENT_BY_BUSINESS_TABLES` (11, `src/lib/account-offboarding/purge-verification.ts:772-784`)**
  — two hand-typed sets that should near-mirror, with **nothing asserting
  they do**. The difference is legitimate today (four tables are deleter-side
  only because they have dedicated verifier branches, e.g. `:264-272`), but a
  table added to one and not the other silently either never gets swept or
  never gets verified. **LATENT.**
- **H9-B below.**

**Guard:** do **not** collapse the 25 `SCAN_DIRS` into one constant. The
08-26 register rules against it and `ratchet-harness.ts:5-7` says why. Export
separately; check the **union**.

### H9-B — the directory-page cap needs a warning band · **LOW**

```
3000 docs/directory/lib-platform.md
3000 docs/directory/lib-reviews-responses.md
2995 docs/context/refusal-ledger.md
```

`src/__tests__/reference-shape.test.ts:83-110` asserts `<= 3000`.
`ci:directory-map` requires **one row per production file** under `worker/` +
`src/lib/`, and a row is several words. `lib-platform.md` inventories
`src/lib/kpi/` and siblings; `lib-reviews-responses.md` inventories
`src/lib/approval/` and siblings.

**Adding any new production file under a folder either page owns makes the two
gates unsatisfiable in that PR.** The escape hatch exists and is documented
(`docs/agents/context-layout.md` §"How to add": *"a folder moved to a sibling
page to stay under the cap is recorded there too"*), so this is not a
deadlock. **The finding is the absent warning band** — the first signal is a
red gate on an unrelated feature PR, and the fix (split a page, update the
Pages table) is not what a feature author expects to do. Add a soft warning at
95% of cap. **LIVE on the next new file in either folder group.**

### H9-C — `owner_leads` gets a disposition · **MEDIUM**

The 08-26 pass's PR 3, unlanded.
`rg -n 'owner_leads' scripts/ci/ src/ worker/ supabase/` returns only the
tenant-scope exemption (`scripts/ci/tenant-tables.ts:244`), migration
`033_owner_leads.sql`, `src/app/api/lead-intake/route.ts:256`, `:261`, and
test fixtures. **No `TABLE_DISPOSITIONS` row, no sweep, no verification
branch.**

**This window sharpened the case:** `src/lib/account-offboarding/table-disposition.ts`
**was edited on 2026-09-12** by #1270, to add the four Owner Operator tables —
and `owner_leads` was not added. Nobody erred; the Operator author had no
reason to know. **That is the mechanism, demonstrated on the exact file.**

**One row.** The classification — scrub, delete, or **consciously retain with
a stated reason** — is a product decision this pass does not make. If scrub or
delete, add the verification branch too (writer and verifier are a matched
pair; there are **NINE** stage runners now, not eight —
`runStripeCustomerRedactionPurgeStage` at `purge-stages.ts:792` is the ninth).
**Reachable conditionally, iff the owner used the public lead form before
signing up.**

**Guard:** do **not** add a tenant column to `owner_leads` to make the guard
see it. The table is pre-signup by nature.

---

## H10 — `OutboxPoller` gets a heartbeat row · **LOW**

> **Title:** `feat(worker): a durable heartbeat for the outbox poller`
> **Acceptance:** `recordPollerCycle(sql, POLLER_OUTBOX)` at the end of a
> clean `pollOutbox` cycle; a `HealthAlertPoller` check that fires on
> staleness.

`poller_heartbeats` (migration 118) has **one writer**:
`JudgeSweepPoller.ts:61` via `src/lib/shared/poller-liveness.ts:61-70`.
`OutboxPoller` calls neither `recordPollerCycle` nor the log-only
`notePollerActivity` (`worker/background/poller-heartbeat.ts`, used only by
`HealthAlertPoller.ts:13, :103, :106`). **The platform's single most
load-bearing loop has no dead-man switch** — its liveness is inferred from
stuck/failed-outbox-by-topic checks, which are downstream of the loop working.

Migration 118's own comment (`:37-38`) says a second poller adds a **row**,
not a migration, and that only `judge_sweep` was written by that change. So
this is a scoping choice, not an oversight — but it is the obvious next row,
and it is the same *predicate-depends-on-the-thing-it-checks* shape that made
#949's Judge blind spot.

**Ride along, and do not skip it:** `OUTBOX_DISPATCH_TIMEOUT_MS` (10 s,
`OutboxPoller.ts:50-54`) was not re-derived when #1071 changed the unit it
bounds — it now bounds an `addBulk` of up to 500 same-topic rows instead of
one row, and a batch spanning many topics dispatches **serially**
(`:411-420`), so a worst case could exceed `readMaxCycleMs()` (60 s, `:78-82`)
and trip the "assumed wedged" path (`:435-438`) on a legitimately draining
cycle. **Not a correctness bug** — concurrent cycles are safe by design. **Low
probability** — real traffic clusters by topic within a hop. Recorded because
the constant's meaning changed and the value did not. **LATENT.**

---

## Not carried forward

- **ADR 0028's error-vocabulary normalisation** — 36 admin literals, 177
  repo-wide. ADR 0028 D5 declines it explicitly. Only the cache-header half is
  carried (H7).
- **A shared `<Card>` component** — 21 files spell `className="card …"`, but
  `.card` is a **CSS** contract (`console.css:1219-1225`,
  `DESIGN.md:379-388`) and a component would be a wrapper for a class name.
  Measured and ruled out, not overlooked.
- **Widening X16's single-flight poller scaffold to all 18 pollers** — only
  two share it (`CleanupAbandonedSignupsPoller.ts:302-329` ≡
  `EmailChannelReconcilePoller.ts:241-263`, self-acknowledged in comments).
  Unifying those two is safe; the general case was not evaluated and is not
  asserted.
- **`haltBatch` vs `adminHaltBatch`** — ruled LEAVE by 08-18 (W4) and 08-22.
  Re-verified at HEAD; not re-proposed.

---

## File these issues when the pass ships

```bash
gh issue create -t "fix(auth): /api/operator routes get the owner-API AAL2 gate" \
  -b "Pathfinder 2026-09-12 H1-A. See docs/reviews/PATHFINDER-2026-09-12/04-handoff-prompts.md#h1a. Blocks Run B's first writing route. LATENT (flag off + MFA_ENFORCEMENT_ENABLED gate)."
gh issue create -t "refactor(auth): one owner for the impersonation-cookie check" \
  -b "Pathfinder 2026-09-12 H1-B. Two byte-identical private copies; Run B adds two more unless this lands first."
gh issue create -t "refactor(auto-approval): a transaction-aware policy writer for Apply" \
  -b "Pathfinder 2026-09-12 H1-C. Run B is blocked. Spec prescribes the shape at docs/roadmap/2026-09-11-owner-operator/README.md:532."
gh issue create -t "docs(operator): Run B's summary panel reuses the granular reads, not the dashboard payload" \
  -b "Pathfinder 2026-09-12 H1-D. Field-by-field measurement in 03-unified-proposal.md U1-G."
gh issue create -t "feat(ci): the arch counter becomes a derivation, not a judgement" \
  -b "Pathfinder 2026-09-12 H2 (= 08-26's H7, unlanded). Counter read 21, window measured 83."
gh issue create -t "fix(offboarding): two Stripe call sites shadow isRetryableStripeError by name" \
  -b "Pathfinder 2026-09-12 H3. The pass's only LIVE behavioural divergence."
gh issue create -t "refactor(notifications): one claim contract for the six-member notice family" \
  -b "Pathfinder 2026-09-12 H2-N (= 08-24 H1+H2, third re-issue). Grew 2 claim fns to 5 while unactioned."
gh issue create -t "refactor(worker): one boundedErrorClass" \
  -b "Pathfinder 2026-09-12 H4. Three private copies import the hardened export."
gh issue create -t "docs(marketing): one owner for the five jobs, or an explicit mapping" \
  -b "Pathfinder 2026-09-12 H5. Product decision required."
gh issue create -t "refactor(ui): one star-glyph helper, import FeatReceipt, one advisory panel" \
  -b "Pathfinder 2026-09-12 H5-B. Three cheap unifications; FeatReceipt's owner already exists."
gh issue create -t "docs: seven claims that stopped being true" \
  -b "Pathfinder 2026-09-12 H6. Each a one-line fix; the pass's own headline class."
gh issue create -t "chore: import the legacy notice topic constants; no-store on admin error bodies" \
  -b "Pathfinder 2026-09-12 H7."
gh issue create -t "docs: the run spine covers Reply/Guardian/Insights, not the Owner Operator" \
  -b "Pathfinder 2026-09-12 H8."
gh issue create -t "feat(ci): every enumerated guard can fail on an unclassified subject" \
  -b "Pathfinder 2026-09-12 H9 (= 08-26 PR 2, partially landed). Two new class members this window."
gh issue create -t "chore(docs): a warning band before a directory page hits its 3,000-word cap" \
  -b "Pathfinder 2026-09-12 H9-B. Two pages sit at exactly 3,000."
gh issue create -t "feat(offboarding): owner_leads gets a table disposition" \
  -b "Pathfinder 2026-09-12 H9-C (= 08-26 PR 3, unlanded). table-disposition.ts was edited on 2026-09-12 and owner_leads was not added."
gh issue create -t "feat(worker): a durable heartbeat for the outbox poller" \
  -b "Pathfinder 2026-09-12 H10."
```
