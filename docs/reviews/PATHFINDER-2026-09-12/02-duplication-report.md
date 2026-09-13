# Cross-feature duplication — Pathfinder 2026-09-12

Every claim carries **≥ 2 `file:line`**. Every finding is labelled **LIVE** or
**LATENT**, and where copies are legitimate the report says **SPECIALIZATION**
and stops — that is a result, not a failure to find something.

**Prior registers read in full and not re-proposed:**
`PATHFINDER-2026-08-26/02-duplication-report.md:903-922` (12 entries) ·
`-08-24/…:454` · `-08-22/…:409` · `-08-18/…:397`.

`fallow dupes` at HEAD: **64 clone groups, 2,185 lines, 1.2%, 58 files.**
Nineteen of its top groups are `docs/admin-api/admin-api.d.ts`, which is
**generated** (`scripts/ci/admin-contract-audit.ts:144`) and excluded from
every recommendation below.

---

## 1. Ranked by consequence

### X1 — The `businesses ⋈ accounts` subscription read: **33 sites → 48, in 46 files**

The 2026-08-26 pass measured 33 and ranked it its largest duplication in six
passes. **It grew by 15 sites and 14 files in one window, and nothing
extracted it.**

```
$ rg -n 'JOIN accounts a ON a\.id = b\.account_id' src/ worker/ \
     -g '!**/__tests__/**' -g '!*.test.ts' | wc -l
48
$ … | rg -l … | wc -l
46
```

Every site hand-types `FROM businesses b JOIN accounts a ON a.id = b.account_id`.
There is still **no shared SQL fragment anywhere.** Representative sites, one
per subsystem: `src/lib/dashboard/service.ts:172` ·
`src/lib/db/account-guard.ts:131` · `src/lib/responses/judge-health.ts:79` ·
`src/lib/shared/writable-subscription.ts:165` ·
`src/lib/admin/business-summary.ts:414`, `:443` ·
`worker/jobs/response-generation/load-context.ts:128` ·
`worker/jobs/publisher/load-context.ts:66` ·
`worker/jobs/auto-post-notice/context.ts:120` ·
`worker/background/schedulers/WeeklySummaryScheduler.ts:70` ·
`src/app/api/dashboard/route.ts:103`. Full 48-site enumeration was produced
and inspected; it is reproducible with the command above.

**One partial fix did land:** `src/app/api/zernio/disconnect/route.ts` went
from two occurrences to one. All +15 growth came from **new call sites
cloning the pattern**.

- **LATENT.** No wrong behaviour. The risk is drift in the offboarding
  projection's 10-alias `ao.*` block, whose *consuming* shape is already
  centralised by `activeOffboardingStateFromProjection`
  (`src/lib/account-offboarding/gate.ts:98`).
- **Not safe to blanket-unify** — the same verdict the 08-26 pass reached,
  now with a bigger number. 08-24's register entry *"the 21-line offboarding
  SELECT — do not extract into the notice family"* still governs the `ao.*`
  projection. **The `JOIN accounts` clause itself has never been on any
  register and remains open** — three sites in `src/lib/shared/writable-subscription.ts`
  alone (`:88-111`, `:145-168`, `:215-240`) repeat the identical 13-column
  offboarding projection inside three near-identical functions
  (`assertWritableSubscriptionForAccount`, `assertWritableSubscriptionForBusiness`,
  `resolveWritableAccountForLocation`). **That file is the cheapest place to
  start** and is carried as the non-goal note in H-X1.

### X2 — The notice family: **still 6 members, and both 08-24 bugs are still LIVE**

No seventh directory appeared:
`worker/jobs/{auto-post-notice, autonomy-suspended-notice, escalation-notice,
notification, pending-post-notice, solicitation-veto-notice}`.

| Member | `context.ts` | dispatch | claim fn (`src/lib/notifications/delivery.ts`) | bounced-owner check |
|---|---|---:|---|---|
| `notification` (progenitor) | `:101-142` | 346 | none typed (`NotificationFailoverPoller` keys on `template='approval_request'`) | **yes** |
| `auto-post-notice` | `:106-137` | 150 | `claimAutoPostNoticeDelivery:84` — **no reap** | **NO — zero refs** |
| `escalation-notice` | `:102-137` | 187 | `claimEscalationNoticeDelivery:113` — **no reap** | yes |
| `pending-post-notice` | `:142-177` | 239 | `claimPendingPostNoticeDelivery:143` — reap, **no settled/pending split** | yes |
| `autonomy-suspended-notice` | `:59-116` (account-first) | 125 | `claimAutonomySuspendedNoticeDelivery:194` — reap + split | yes |
| `solicitation-veto-notice` | `:101-136` | 188 | `claimSolicitationVetoNoticeDelivery:278` — reap + split | yes |

**`fallow` undercounts the context duplication.** It reports 3 byte-identical
instances (`escalation-notice/context.ts:102-137` ≡
`pending-post-notice/context.ts:142-177` ≡
`solicitation-veto-notice/context.ts:101-136`). Reading the other two:
`notification/context.ts:101-142` and `auto-post-notice/context.ts:106-137`
run the **same** business + offboarding-guard query, differing only in log
wording and the presence of a reason string. **Five-way semantic duplicate,
three-way byte-identical.** `autonomy-suspended-notice/context.ts:59-116` is
genuinely different (account-first, because autonomy suspension is
account-scoped per invariant #11) — **SPECIALIZATION, leave it.**

**BUG 1 — the bounced-owner gap. LIVE, unchanged since 08-24.**
`worker/jobs/auto-post-notice/` contains **no bounce handling of any kind**
(`rg -n 'bounce' worker/jobs/auto-post-notice/` → no output; the directory is
`AutoPostNoticeWorker.ts`, `context.ts`, `dispatch.ts`, `errors.ts`). Every
sibling has at least one check (`escalation-notice` 2/2,
`pending-post-notice` 2/2, `solicitation-veto-notice` 2/2,
`autonomy-suspended-notice` 3/1). `worker/ingress/resend.ts` still enrols
`auto_post_notice` in `OWNER_DIRECTED_TEMPLATES`, so a bounced-owner account
earns a fresh hard bounce on every auto-posted reply. **Its own email
template knows about the flag** —
`src/lib/notifications/email/templates/auto-post-notice.ts:13` reads *"so a
hard bounce flags `businesses.owner_email_bounced`"* — while the dispatcher
that sends it does not read it. **Deployment-dormant** (requires
`AUTO_APPROVAL_ENABLED`), so **LATENT in effect, LIVE in code.**

**BUG 2 — both halves LIVE.** Half A (no stale reap): `delivery.ts:84-102`
and `:113-131` have no `DELETE FROM notification_deliveries`, unlike `:151-158`,
`:213`, `:291`. Half B (a null read as dedup):
`worker/jobs/auto-post-notice/dispatch.ts:101-108` treats `deliveryId === null`
as harmless and increments `skipped`; `worker/jobs/solicitation-veto-notice/dispatch.ts:116-127`
distinguishes `claim.kind === 'pending'` and **throws**. **Finer than 08-24
recorded:** `pending-post-notice` has the reap but **not** the settled/pending
union — a **third, previously uncatalogued middle variant.**

**NEW sub-finding, not on any register.** `delivery.ts:249-259` ≡ `:327-337`:
inside `claimAutonomySuspendedNoticeDelivery` and
`claimSolicitationVetoNoticeDelivery`, the *post-conflict* resolve tail
(`SELECT id, sent_at, failed_at … LIMIT 1`; no row → `pending`; sent-or-failed
→ `settled`; else `pending`) is byte-identical apart from the `template`
literal. **Distinct from the register's protected entry**, which covers the
claim helpers' `ON CONFLICT`/INSERT **key columns** (`delivery.ts:80-82`), not
this read. **LATENT, safe to unify** as a private
`resolveExistingClaim(sql, {…, template})` inside `delivery.ts`.

**Self-duplication:** `worker/jobs/OwnerEmailWorker.ts:207-249` ≡ `:316-353`
— a 52-line claim → send → rollback-on-failure scaffold, duplicated between
`sendReconnectRequired` and `sendConnectionLost`. No trust-model difference.
**LATENT, safe to unify.**

`worker/jobs/auto-post-notice/dispatch.ts` ≡
`worker/jobs/pending-post-notice/dispatch.ts` (fallow: 20 + 14 lines) —
PPN's own header admits it (*"Clone of the escalation-notice dispatcher … with
ONE structural difference"*). **MIXED:** the per-channel
try/catch/classify/release/fail scaffold is accidental; the approval-link
creation and the bounced-check presence are the legitimate content
differences and must not be folded in.

### X3 — `isRetryableStripeError`: **three implementations, two of them shadow the owner BY NAME** · LIVE

The sharpest new finding in the window, because #1126 was *the merge that
created the owner*.

| | `file:line` | Behaviour |
|---|---|---|
| **owner** | `src/lib/account-offboarding/stripe-retry-policy.ts:61` | reads `RETRYABLE_STRIPE_ERROR_TYPES` / `PERMANENT_STRIPE_ERROR_TYPES`, handles 4xx/5xx separately, **then falls through to `RETRYABLE_NETWORK_ERROR_CODES`** |
| correct callers | `stripe-customer-redaction.ts:53, :429` · `stripe-invoices.ts:6, :116, :426` | |
| **private copy A** | `worker/jobs/account-offboarding/teardown-stripe.ts:121-134`, used at `:104` | four hardcoded type strings, 429-or-≥500, **no socket-code branch** |
| **private copy B** | `worker/background/pollers/AccountOffboardingReactivationResetPoller.ts:175-188`, used at `:117` | **byte-identical to copy A** |

- **Is it wrong?** Yes. #1126's stated goal was one owner *for the offboarding
  lane*, and both copies are in that lane.
- **Is it reachable?** **Yes, routinely** — copy A guards
  `stripe.subscriptions.cancel` on every `delete_data` teardown with an active
  subscription; copy B guards `stripe.subscriptions.update` on every
  stale-claim recovery cycle. A retryable type present in the vocabulary but
  absent from the four hardcoded strings, or any socket-level `code`, is
  silently treated as **non-retryable** at these two sites.
- **LIVE. Safe to unify — import the owner.**

**Worse than an anonymous duplicate: the copies carry the same identifier as
the shared export.** A reader in either file sees `isRetryableStripeError(err)`
and reasonably assumes it is the owner. Shadowing across a module boundary, by
name. → **H3**

A third posture rides along: `BillingScheduleWorker.ts:79` does no
classification at all. Defensible for that call shape; recorded so the count
is honest at **three postures over five Stripe call sites**. And a stale
pointer: `src/lib/payments/stripe-error-inspect.ts:9-15` still names
`stripe-invoices.ts` as the module that *"applies its own retry policy."*

### X4 — `boundedErrorClass`: **four copies, three identical, one hardened — and the hardened one is the export** · LIVE-adjacent

| | `file:line` | Body |
|---|---|---|
| **shared, exported** | `worker/jobs/solicitation-batch/failed-hook-shared.ts:36` | `err.constructor.name` validated against `/^[A-Za-z][A-Za-z0-9_$]{0,99}$/`, else `'UnknownError'` |
| private | `worker/job-failure-sink.ts:59` | `err.name.slice(0,100)` |
| private | `worker/jobs/csv-ingest/failed-hook.ts:94` | **byte-identical to the above** |
| private | `worker/jobs/judge/failed-hook.ts:39` | **byte-identical to the above** |

The arch log's claim *"five collapsed to four"* is **verified true**:
`worker/jobs/agent-turn/failed-hook.ts:8` imports the shared one rather than
defining a fifth.

**The three private copies are byte-identical to each other and diverge from
the export in the same two ways** — source field (`err.name` vs
`err.constructor.name`) and the absence of identifier validation. A custom
`Error` subclass setting a `.name` with structuring characters is sanitised on
the shared copy and **not** on the other three.

- **Is it wrong?** Yes — an inconsistent log-hygiene property across three of
  four sites.
- **Is it reachable?** All four run continuously in production failure paths.
  Never on the same error at the same site, so no single bug manifests — but
  two hooks reporting the "same" error class to Sentry can emit different tag
  values. **LIVE as an observability inconsistency, not a safety defect.**
- **Safe to unify:** the three should import the export. → **H4**

### X5 — The "five jobs of the system": one taxonomy, four re-cuts, one admitted collision · LIVE

Canonical: `src/components/sections/landing/jobs/jobs-copy.ts:55-101` —
Respond · **Protect** · Request · Brief · Measure.
`grep -rn "from.*jobs-copy"` → **two importers**, both inside
`jobs/` (`JobsSection.tsx:8` and its test). **Zero cross-page sharing.**

| Source | Taxonomy |
|---|---|
| `jobs/jobs-copy.ts:55-101` | Respond · **Protect** · Request · Brief · Measure |
| `features/FeaturesContent.tsx:39-63` | Respond · Request · Brief · Measure · **Govern** — the same agents (Guardian · Judge · Governor) renamed. `:39-45` **acknowledges** the rename and does not resolve it |
| `how-it-works/HowItWorksContent.tsx:117-122` + `:131-166` | a 6-step pipeline (Watch/Triage/Draft/Gate/Post/Judge) **plus** 4 loops: Request · Brief · Measure · **Record** — a fifth concept in neither other list |
| `pricing/PricingContent.tsx:26-52` | per-tier prose bullets, **no job labels at all** |

**LIVE**, reachable by any visitor reading two of the four pages. Not caught by
any test — the three `*Content.test.tsx` suites each assert their own page in
isolation. → **H5**

### X6 — `hasImpersonationCookie`: two byte-identical private copies, and Run B would add two more · LATENT

`src/app/api/operator/turns/route.ts:97-99` and
`src/app/api/settings/auto-approval/route.ts:116-118`, both:

```ts
function hasImpersonationCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get(IMPERSONATION_COOKIE_NAME)?.value);
}
```

`src/lib/admin/impersonation/cookie.ts` exports the cookie **name** (`:38`) and
sign/verify helpers (`:23-36`) — **no boolean-check export exists.**

**LATENT today** (operator routes 404 behind the flag). **The reason it is in
this report is sequencing:** Run B adds `apply` and `decline`, both of which
need the same check. Landing them first makes it **four** copies. Extract
before Run B, not after. → **H1-B**

### X7 — Star-rating glyphs: the register says ×2; measured **seven Console sites + two marketing**, with a real divergence · LIVE

The 08-26 register's F8 DUP-4 entry names two sites. Measured at HEAD, a
`clamp → round → '★'.repeat(filled) + '☆'.repeat(5-filled)` contract is
independently reimplemented at:

`src/app/(authenticated)/dashboard/requests/AttributedReviews.tsx:173-183` ·
`src/components/approval/approval-client.tsx:198-204` (`formatStars`) ·
`src/components/dashboard/kpi/ReputationHeroBand.tsx:51-58` (`Stars`) ·
`src/components/dashboard/reviews/EditReplyDrawer.tsx:177-178` (inlined,
`Math.round` called twice) · `src/components/dashboard/reviews/PastReplyCard.tsx:148-153`
(`Stars`) · `src/components/dashboard/reviews/ReviewFeedCard.tsx:457-461`
(`formatStars`, body byte-identical to approval-client's) ·
`src/components/dashboard/timeline/TimelineContent.tsx:206-212`
(`ReviewRating`). Plus two marketing copies
(`sections/how-it-works/WatchArtifact.tsx:18-20`,
`ui/MarqueeBackground.tsx:65`) and **an already-shared component nobody
outside its folder uses**, `ReviewStars`
(`sections/features/FeatPrimitives.tsx:40-46`, 5 consumers, all in
`sections/features/`).

`approval-client.tsx:198` is a **self-aware copy** — its comment says *"Matches
the defensive helpers in the dashboard cards"* while importing nothing.

**A real divergence hides inside "the same pattern":**
`AttributedReviews.tsx:182` and `PastReplyCard.tsx:152-153` render the empty
stars as `'★'.repeat(...)` styled dim; the other five use the literal `'☆'`
glyph. Same intent, different visual mechanism, different screen-reader text.

**LIVE.** Safe to unify the **seven Console sites** behind one
`starGlyphs(rating)`. The two marketing copies stay separate — different
design system. → **H5-B**

### X8 — Two pages of `docs/directory/*.md` sit at EXACTLY the 3,000-word cap · LIVE

```
3000 docs/directory/lib-platform.md
3000 docs/directory/lib-reviews-responses.md
2995 docs/context/refusal-ledger.md
```

`src/__tests__/reference-shape.test.ts:83-110` asserts `<=` 3,000. `ci:directory-map`
requires **one row per production file** under `worker/` + `src/lib/`, and a
row is several words.

`lib-platform.md` inventories `src/lib/kpi/` and siblings;
`lib-reviews-responses.md` inventories `src/lib/approval/` and siblings.
**Adding any new production file under a folder either page owns makes the two
gates mutually unsatisfiable in that PR.**

- **Is it wrong?** Not exactly — the escape hatch exists and is documented
  (`docs/agents/context-layout.md` §"How to add": *"a folder moved to a sibling
  page to stay under the cap is recorded there too"*).
- **Is it reachable?** **Yes, on the next new file in either folder group.**
- **The finding is the absence of a warning band.** The first signal is a red
  gate on an unrelated feature PR, and the fix — splitting a directory page and
  updating the Pages table — is not a one-line change a feature author expects
  to make. → **H9-B**

### X9 — `docs/directory.md` has two stale rows the admin retirement left behind · LATENT

The per-page docs were cleaned correctly. Verified negative, and worth
recording as credit: **no `docs/directory/*.md` carries a stale per-file row**
for any of the 18 deleted `src/components/admin/**` files (`AdminSidebar.tsx`,
`nav-counts-query.ts`, `StatTile.tsx`, `StatusBadge.tsx`, `FilterBar.tsx`,
`HealthBadge.tsx`, `LastUpdated.tsx`, `RelativeTime.tsx`, the three enrolment
widgets …) — every basename was grepped against `docs/directory.md` and all
`docs/directory/*.md`.

**The top-level index drifted:**

1. `docs/directory.md:39` still describes `app-admin.md` as covering
   *"overview, jobs, costs, notifications, runbook, `businesses/` (list,
   detail panels, new-business form), `locations/csv-import/`, flagged
   drafts, impersonation"* — **every one of those page groups was deleted.**
   The file it points at now opens *"After #1193, five pages remain"*
   (`docs/directory/app-admin.md:5`).
2. `docs/directory.md:115` describes `src/hooks/useAdminActionForm.ts` as
   replacing hand-rolled state in **five** admin surfaces
   (`ImpersonationStartClient`, `CsvImportClient`, `ManualRankingSection`,
   `PastDueExtensionPanel`, `SolicitationBatchPanel`). Four are deleted;
   `rg -ln 'useAdminActionForm' src/` returns the hook, its test, and
   **`ImpersonationStartClient.tsx` alone.** The hook's entire documented
   design rationale — *"the success channel is a TYPE PARAMETER because
   measured across the five it is four different things"* — now serves one
   caller.

**`ci:directory-map`'s `SCAN_DIRS` is `['worker','src/lib']`**, so neither row
fails any audit. **LATENT** (doc-only), but it misleads an agent following
CLAUDE.md's own instruction to check `docs/directory.md` first. → **H6**

### X10 — Dead export: `ErrorState` · LATENT

`src/components/admin/ui/states.tsx:22-38`. **Zero production importers.**
`from '@/components/admin/ui/states'` resolves only `EmptyState`
(`src/app/admin/impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx:4`)
and `TableSkeleton` (`src/app/admin/loading.tsx:1`); `<ErrorState` matches only
a **code comment** at `src/app/admin/error.tsx:35`. No test file for
`states.tsx`. Left behind by the retirement; `fallow` reports dead exports at
**0.0%**, which is the measurement gap — it counts exports with no importer in
its own graph, and this one is exported from a barrel that *is* imported.
→ **H6**

### X11 — `FeatReceipt` already exists and its sibling directory hand-rolls it four times · LIVE

The cheapest fix in the report, because **the owner is already written**.

`FeatReceipt` (`src/components/sections/features/FeatPrimitives.tsx:52-69`)
carries a docstring saying its purpose is exactly this: *"the three-cell
receipt strip (`.rw-dl-rec`) from data, so the chapters that show settings or
counts share one markup path."* Three consumers, **all inside
`sections/features/`** — `FeatAutopilot.tsx:45`, `FeatInsights.tsx:75`, `:110`,
`FeatSolicitor.tsx:63`.

The sibling directory `sections/how-it-works/` independently hand-rolls the
identical three-cell `.rw-dl-rec` markup **four times**:
`GateArtifact.tsx:68-81` · `PostArtifact.tsx:40-53` ·
`TriageArtifact.tsx:21-34` · `JudgeArtifact.tsx:21-34`.

**LIVE** (every `/how-it-works` load). **Safe to unify — it is a cross-directory
import, not a refactor.** This is explicitly *not* the "collapse the seven step
artifacts into one component" that the 08-26 register forbids (X13); it is
narrower and is the same class of fix that register endorses. → **H5-B**

Riding along on the same page: the demo draft sentence *"Sarah, thank you.
That's genuinely wonderful…"* is defined but **not exported** at
`DraftArtifact.tsx:6-7` and independently retyped at `GateArtifact.tsx:20`,
`:87`, `HeroFlowArtifact.tsx:78`, `PostArtifact.tsx:35`, `JudgeArtifact.tsx:16`
— **six copies of one string on one page.** And
`String(Math.floor(secondsLeft/60)).padStart(2,'0')` is byte-identical at
`GateArtifact.tsx:59-60` and `WatchArtifact.tsx:36-37`.

### X12 — The edit-reply advisory panel: four files, one inline box · LIVE

`className="space-y-3 rounded-lg p-4"` with
`style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-recess)' }}`
at `DraftConflictPanel.tsx:25`, `:63`, `:100` · `RecoveryPanel.tsx:13` ·
`ReviewChangedPanel.tsx:13` — **byte-identical**, in a folder that has a
shared `.card` class available. A quoted-draft sub-pattern repeats at
`DraftConflictPanel.tsx:35`, `:74`, `:109` and `PreviewPanel.tsx:24`, and a
label caption at `DraftConflictPanel.tsx:32`, `:71`, `:106`,
`PreviewPanel.tsx:18`, `ReviewChangedPanel.tsx:20`.

**LIVE** (renders on every edit-reply drawer open). **Safe to unify** as a
local `AdvisoryPanel`/`QuotedDraftText` inside `edit-reply/`; no cross-system
implications. → **H5-B**

### X13 — Legacy outbox topic strings hand-typed at seven sites · LATENT

`'notify_owner_reconnect'` / `'notify_owner_connection_lost'` are typed as
literals at `worker/jobs/publisher/no-connection.ts:66` ·
`worker/jobs/publisher/edit-publish-tx.ts:209`, `:223` ·
`worker/jobs/publisher/publisher-error-handlers.ts:197`, `:211` ·
`worker/ingress/zernio/zernio.ts:133` ·
`src/lib/zernio/auth-error-fallback.ts:70`.

`worker/queues.ts:132-133` deliberately routes both onto `sendOwnerEmail`, and
`scripts/ci/outbox-seam-audit.ts:47-50` explicitly defers judging them
(*"`ci:outbox-topics`'s question, not this audit's"*).

**LATENT** — behaviourally correct everywhere. But it violates CLAUDE.md's own
working rule: *"No string literals for … job names — import the constant."*
**Safe to unify:** one exported constant pair, seven imports. The alias-routing
design stays untouched. → **H7**

### X14 — API error shapes: `errorResponse()` exists, has 75 uses, and **zero** of them are in admin · LIVE

```
$ rg -n 'errorResponse\(' src/app --type ts -g '!**/__tests__/**' | wc -l
75
$ rg -c 'errorResponse\(' src/app/api/admin
(no matches)
```

`errorResponse` is defined once (`src/lib/auth/route-helpers.ts:52`) and used
75 times across 23 files. Raw `NextResponse.json({error: …})` appears at
**181 production call sites in 44 files**, e.g.
`src/app/api/onboarding/start/route.ts:191, 198, 216, 239, 258, 262, 269, 273, 297, 313, 350`
and `src/app/api/dashboard/import-offer/route.ts:132, 155, 168, 172, 192, 194, 196, 204`.
Distinct `error:` string literals: **36 under `src/app/api/admin/`** (ADR 0028
measured 37 — essentially unchanged) and **177 across the whole API tree**. The
admin set mixes snake_case codes (`'invalid_body'`, `'not_found'`),
Title-Case sentences (`'Account not found'`) and full messages
(`'Daily demo generation limit reached (50/day)'`).

**ADR 0028 D5 explicitly declines to normalise the vocabulary**
(`docs/adr/0028-admin-api-contract.md:60-65`), and this pass does **not**
re-propose it. **What it does carry is the cheaper half:** ~16 route-local
`catch` blocks emit a JSON error with **no cache headers at all**
(`src/app/api/admin/costs/route.ts:39` · `nav-counts/route.ts:20` ·
`jobs/route.ts:45` · `businesses/[id]/route.ts:44`, `:110`), while
`internalError()` always attaches `NO_STORE_HEADERS`
(`admin-mfa-gate.ts:27-30`). **LIVE, low severity** — a misconfigured
intermediary could retain a stale error body. → **H7**

### X15 — Two parallel `getUser` + scope resolutions · SPECIALIZATION, forced by the framework

- Server-Component path: `src/lib/auth/require-owner-access.ts:97-117`
  (`getRenderAuthUser`), `:124-137` (`getRenderOwnerRow`),
  `src/lib/auth/get-request-scope.ts:57-106` — all `React.cache()`-wrapped.
- Route-Handler path: `src/lib/db/auth.ts:55-67` (`getCurrentUser`), `:87-105`
  (`loadAppUser`) — **not memoized, and structurally cannot share the cache**
  (`require-owner-access.ts:26-28` states `cache()` does not reach route
  handlers).

**SPECIALIZATION. New DO-NOT-UNIFY entry.** With the scope caveat in
F8: #1069's *"one `getUser`, one users read, one scope per owner page render"*
is true for the Server-Component tree only; a page render plus a client fetch
in the same navigation still pays two auth round trips.

### X16 — Two pollers share a self-acknowledged single-flight scaffold · LATENT

`worker/background/pollers/CleanupAbandonedSignupsPoller.ts:302-329` ≡
`worker/background/pollers/EmailChannelReconcilePoller.ts:241-263` — 28
identical lines including the `timer !== null` (not truthy) reasoning. The
second file's comments cross-reference the first (*"See
CleanupAbandonedSignupsPoller for the reasoning"*), so this is
self-acknowledged. Of the other 16 pollers, **none** shares this exact
scaffold (`grep -rl "runOnce().catch(logUnhandledPollError"` matches only
these two), and no shared poller-runner utility exists.

**LATENT, safe to unify for these two specifically.** Widening to all 18
pollers is an unverified judgment call and is **not** asserted here.

### X17 — `AgentTeamStrip` / `RestraintContent` scoped-fetch helper · LIVE, admitted

`src/components/dashboard/AgentTeamStrip.tsx:127-149` (`fetchAgentTeam`) and
`src/components/dashboard/restraint/RestraintContent.tsx:83-98`
(`fetchRefusalLog`) both build `URLSearchParams` from `scope` + `window`,
fetch, and validate. `RestraintContent.tsx:32` says outright: *"`AgentTeamStrip`
is the precedent for #1000 ST-1."*

**LIVE, safe to unify** as `fetchScopedWindow<T>(path, scope, window, validate)`.
A third candidate, `usePendingApprovals.ts:31`, differs enough (conditional
`scope`, no `window`) to leave out.

---

## 2. Verified negatives — recorded so the next pass does not re-discover them

| Claim | Result |
|---|---|
| A proliferation of JS `Card` primitives | **No.** `grep -rn '^\.card\s*{'` returns exactly one declaration (`console.css:1219-1225`). Island's equivalent is separately namespaced (`island.css:1349` `.rw-dl-card`). The 21 files spelling `className="card …"` are content in one shared CSS contract, not 21 containers |
| A third popover/disclosure copy | **No.** `pointerdown` listeners resolve only to `useDisclosurePopover.ts:86` and `InfoTip.tsx:107` (a deliberate second listener for a *different* state, justified at `:97-99`). `aria-haspopup`/`role="menu"` resolve only to `LocationPicker.tsx:66, :80` and `AccountMenu.tsx:93, :116`, both via `useMenuPopover` |
| Design tokens declared twice | **One**, and it is sanctioned. 270 declarations across 27 CSS files, 268 distinct names; only `--rw-font-mono` collides (`globals.css:159` vs `console.css:22-23`), documented at `console.css:15-21` as the sanctioned scoped-override mechanism |
| A duplicate relative-time formatter | **No.** `formatRelative` (`ReviewFeedCard.tsx:464`) is the only one in scope |
| Duplicated claim-before-send | **No.** `tryClaimAlert` (`NotificationFailoverPoller.ts:116-199`) is one function reused at `:365`, `:453`, `:576`. **Correct reuse** |
| An `ci:outbox-seam` violation | **No.** The one apparent collision — `DrainOwnerConnectWorker.ts:53-73` writing `PUBLISH_RESPONSE`, which has a helper — is a legitimate set-based `INSERT…SELECT…FROM` fan-out, annotated `-- topic-audit-ignore:` at `:73`. The `-- outbox-seam-ignore:` hatch has **exactly one use**, `NotificationFailoverPoller.ts:493`, matching CLAUDE.md:49 |
| `NOTIFY_ADMIN` raw sites | **Exactly 6**, matching CLAUDE.md:49: `zernio-ingest-shared.ts:184` · `process-review.ts:464` · `ingest-failed-hook.ts:211` · `review-lookup.ts:185` · `publisher-error-handlers.ts:303` · `publisher/failed-hook.ts:458` |
| `src/app/api/locations/{archive,promote-primary}/route.ts` (fallow flagged 28 lines) | **False positive.** Both already delegate to `readLocationActionRequest(sql, req, Schema)`; fallow matched Zod boilerplate around genuinely different business steps |
| `haltBatch` vs `adminHaltBatch` (`approval.ts:730-739` ≡ `:815-836`) | **Already ruled LEAVE** by 08-18 (W4) and 08-22's register. Re-verified at HEAD: same shape, shifted lines. **Not re-proposed** |
| Three ErrorState-shaped components | **SPECIALIZATION.** `admin/ui/states.tsx:22-38` (admin banner) · `dashboard/SegmentErrorState.tsx:22-78` (Next segment-boundary signature) · `approval/ApprovalErrorState.tsx:59-116` (presentational, two variants, because a consumed link is deliberately not an alarm) |
| The two skeletons | **Correct reuse.** `DashboardSkeleton.tsx` and `SettingsSkeleton.tsx` both key off one `@keyframes rw-skeleton-pulse` (`console.css:3041`) |
| `EngagementAlertWorker.ts:57-67` ≡ `OnboardingDripWorker.ts:141-150` | **Marginal.** `checkSubscription` is already shared across 14 call sites; only these two share both `workerType` and handling. Not worth a wrapper for 2 of 14 |

---

## 3. Additions to the DO-NOT-UNIFY register

Nothing here re-proposes an entry from the 08-18, 08-22, 08-24 or 08-26
registers.

| Pair | Why it stays separate | Evidence |
|---|---|---|
| **`requireAal2FromSupabase` (lenient) vs `requireCurrentAal2FromSupabase` (strict)** | Two security postures on purpose. The proxy's page/owner gate is lenient (`nextLevel==='aal2' && currentLevel!=='aal2'` → challenge); the admin API gate and `page-gate` are strict (`currentLevel==='aal2'` exactly). ADR 0025 §Context names the split as accepted. **Unify the proxy's inline COPY of the lenient one; never merge the two functions** | `src/lib/auth/mfa.ts:16-27` vs `:29-40`; the inline copy at `src/proxy.ts:260-271`; strict use at `admin-mfa-gate.ts:85-86`, `page-gate.ts:75` |
| **`getQrRedirectRow` vs `getLocationsForAccount`** | Two trust models in one file. The first is an unscoped pre-auth join for an unauthenticated scan, explicitly allowlisted as `pre-auth-token`; the second is the owner-scoped read. A "one location read" refactor would hand the public route an owner-scoped function or the owner surface an unscoped one | `src/lib/locations/repo.ts:198-209` vs `:64` |
| **The Server-Component vs Route-Handler auth paths** | `React.cache()` structurally cannot span the boundary, and the file says so. A shared owner would have to drop memoization for the page tree or fake it for routes | `src/lib/auth/require-owner-access.ts:26-28`, `:97-137` vs `src/lib/db/auth.ts:55-105` |
| **`OutreachWithheldReason` vs `RenderWithholdReason`** | Two enums, overlapping on `lint_failed`/`moderation_high`, both mapping into `outreach_withheld`. Merging would let a dispatch-only reason typecheck at a render site. Both maps are independently total | `src/lib/refusals/vocabulary.ts:300-321` (the written reason), `:314` vs `:331` |
| **The `occurredAt: 'transaction_time'` sentinel vs a bound `Date`** | Five lanes decide *inside* the stamping transaction and join a `DEFAULT NOW()` partner; four decide at render/dispatch time, outside it. ADR 0023's "One timestamp can still drift" draws exactly this line. Making them uniform breaks one half | `approval.ts:651`, `suspension.ts:347`, `persist.ts:998`, `:1162`, `auto-policy-downgrade.ts:224` vs `dispatch.ts:1483`, `batch-builder.ts:733` |
| **The `ON CONFLICT` clause re-spelled in both refusal write arms** | Postgres cannot infer a partial index through a parameterised predicate. The duplication is **required**, and it is the only one in the repo whose two copies are machine-diffed by a test | `src/lib/refusals/write.ts:914-915` and `:1102-1103`; the diff test `write.test.ts:645-666`; the reason `:932-937`, `:1143-1150` |
| **`autonomy-suspended-notice/context.ts` vs the other five** | Account-first, not business-first, because autonomy suspension is account-scoped per invariant #11. It is the one family member whose context query *should* differ | `worker/jobs/autonomy-suspended-notice/context.ts:59-116` vs `escalation-notice/context.ts:102-137` |
| **`--rw-danger` vs `--rw-error`** | Genuinely different colors per design system (`#A64033` vs `#b3261e`). Unify the **12px error-caption rule shape**; never the color token | `tokens.css:129` vs `globals.css:103`; the rules at `wizard.css:199-203` vs `auth-island/auth-island.css:177` |
| **`.aggregate-empty` vs `.error-state`** | Both are "centered column: icon → title → sub-copy," for an inline no-data placeholder and a full segment fatal boundary | `console.css:2991-3015` vs `:1868-1921` |
| **`.period-tab` vs `.tab` base sizing** | Documented deliberate parallel (`console.css:523-524`: *"mirror[s] `.tabs`/`.tab`, sized for the TopBar action slot"*). **Share the byte-identical `:hover`/`.active` sub-rules; keep the sizing split** | `console.css:532-548` vs `:1548-1561`; identical `.active` bodies at `:550` and `:1563`; the composed alternative already exists at `:1570-1579` |
| **`AggregateIntelligenceBriefCard`'s `SingleLocationBrief` vs `IntelligenceBriefCard`** | The comment at `:69-76` states it is near-verbatim and *"DELIBERATELY not folded"*, pinning the one behavioural delta (the "Insights agent" label) | `kpi/IntelligenceBriefCard.tsx:11-42` vs `aggregate/AggregateIntelligenceBriefCard.tsx:77-111` |

### One correction to a prior register entry

The 08-26 register's **X5** cites `AdminSidebar.tsx:72-97` as one of the four
disclosure copies. **`src/components/admin/AdminSidebar.tsx` no longer
exists** — deleted by `f747cb7b6` (#1193/#1264). That citation is stale.
The X5 entry's *rule* still stands for the remaining three; only the fourth
member is gone.

---

## 4. Sources

**Pass artifacts read:** `docs/reviews/PATHFINDER-2026-08-26/02-duplication-report.md`
in full (register `:903-922`) · `00-features.md` · `08-next-session-prompt.md`
· `09-arch-log-entry.md` · `SCOPE.md` · `01-flowcharts/F11-purge-verification.md`
(as the F7 baseline).

**Tools:** `npx fallow dupes --top 80` (64 groups, 2,185 lines) and
`npx fallow health`, both at HEAD. **Every fallow lead in scope was verified
by reading the cited file**; two were rejected as false positives
(`locations/{archive,promote-primary}`) or generated
(`docs/admin-api/admin-api.d.ts`, 19 groups).

**Orchestrator-re-run verifications** (the "a citation is not a verification"
rule — these four were re-run independently of the subagent that first
reported them): the 48-site `businesses ⋈ accounts` count · the five
`claim*Delivery` functions and the 440-line file · the four
`boundedErrorClass` copies and their bodies · the three
`isRetryableStripeError` implementations and their bodies · the absent bounce
handling in `worker/jobs/auto-post-notice/` · `errorResponse`'s 75 uses and
zero admin uses · the two at-cap directory pages · `docs/directory.md:39` and
`:115` · `FeatReceipt`'s three consumers.

**Gaps.** (1) No test suite was executed; every "no guard catches this" claim
rests on reading the guard's scope literal. (2) `scripts/*.ts` self-duplication
(`ws8-staging-smoke.ts` ×4, `health-bundle-differential.ts`/`wedge-repro.ts`,
`mint-admin.ts`/`revoke-admin.ts`) was out of scope — `scripts/` is not
`scripts/ci/`. (3) Widening X16's poller scaffold to all 18 pollers was not
evaluated. (4) `src/app/**` directory-doc rows were spot-checked, not audited.
