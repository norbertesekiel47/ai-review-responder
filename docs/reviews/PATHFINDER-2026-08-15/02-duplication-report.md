# Pathfinder 2026-08-15 — duplication report (Phase 2)

**Method deviation, recorded.** The skill fans out two duplication subagents
(within-feature, cross-feature). This pass did not: all seven Phase-1 chart
agents were tasked to return duplication evidence with `file:line` as part of
their contract, and did. Re-deriving it with two fresh agents holding *less*
context than the charts already produced would have cost tokens to lower
quality. Synthesis below is the orchestrator's, from seven chart reports plus
independent verification of every finding marked **[verified]**.

Evidence base: 671 nodes / 3,908 lines across `01-flowcharts/`.

Severity key — **H** correctness or security risk · **M** real maintenance cost
or a live divergence · **L** cosmetic.

---

## A. Within-feature duplication

### A1 [verified] **H** — `HealthBadge` has two implementations, and they differ in type safety

| Location | Keying | Unknown level renders as |
|---|---|---|
| `src/components/admin/ui/HealthBadge.tsx:12`,`:18` | `Record<ChurnScore['level'], string>` | **compile error** |
| `src/app/admin/businesses/[id]/BusinessDetailClient.tsx:33`,`:38` | `Record<string, string>` + `?? healthy` / `?? level` | **silently green "Healthy"** |

The shared component's own comment states the intent: *"adding a level there is a
type error here rather than a silent grey pill"* (`HealthBadge.tsx:10-11`).
Importers of the shared owner are only `BusinessesClient.tsx` and
`OverviewClient.tsx` — the business **detail** page, the third health surface,
uses the private copy.

This is the exact failure mode spec §5.1 named ("would disagree with the Health
column on `/admin/businesses`"), reintroduced one file from the fix. The private
copy carries a confident comment explaining why it is not `StatusBadge`
(`BusinessDetailClient.tsx:40-44`) — accurate when written, now a stale rationale
guarding a duplicate, which is why review did not catch it.

**Doc-truth consequence:** `.claude/CLAUDE.md`'s *"Health presentation has ONE
owner, `src/components/admin/ui/HealthBadge.tsx`"* is false as written.

### A2 **M** — churn math spelled twice inside F1

- metrics CTE: `business-summary.ts:223-269` vs `business-detail/queries.ts:218-259`
  (identical notification/response CTEs, the ≥3-notification rule, 7d/35d windows)
- `responseTimeTrend` + `computeChurnRiskScore` composition:
  `business-summary.ts:116-131` vs `business-detail/mappers.ts:261-276`
- `isSubscriptionTier` guard + identical throw string:
  `business-detail-service.ts:44` vs `mappers.ts:258`

#833 collapsed the *base* query to one owner and stopped there. The churn
metrics sitting beside it stayed doubled. Same score, two derivations — A1 is
the presentation half of this same split.

### A3 **M** — two write paths to the same four `businesses` voice columns

`api/settings/route.ts:42-48`,`:23-26`,`:69` and
`api/settings/voice/route.ts:117-122`,`:105-108`,`:178` write the same columns
with **different gates** and independently-maintained column maps and zod
fields. A column added to one is silently absent from the other.

### A4 **M** — `resolveCheckoutContext`'s unscoped `onboarded_by` read

`plan-activation.ts:765` reads `onboarded_by` from the business passed in:
```sql
SELECT account_id, onboarded_by FROM businesses WHERE id = ${businessId}::uuid
```
The documented owner 350 lines above is primary-scoped (`:399-404`) and its
comment names this exact mistake: *"An unscoped read of onboarded_by would be
just as wrong the other way — the coupon decision would depend on an arbitrary
location."* The function's own docstring (`:752`) states the invariant it can
violate.

**[verified] NOT live.** Sole consumer is `select-plan/route.ts:215`
(onboarding). Adding a location requires `canAddLocationForAccount` →
`subscriptionGrantsFullAccess`, so a `pending_payment` account cannot hold a
second business; at the only moment this runs, `businessId` *is* the primary.
Correct today **by a precondition enforced in a different module**. It breaks on
a second call site or if pre-payment locations are ever permitted.

### A5 **M** — residual 2-wide DB fan-out in F2

`aggregate-service.ts:114-129` and `:177-182` each start two DB operations before
awaiting either; site 2 runs the 8-query `fetchPerLocationAggregateSlices`
concurrently with `getAccountRecentReviews`. Every sibling read holds one slot
and carries a do-not-revert comment.

Post-#773 this is **bounded latency, not a wedge** — the admission chokepoint
queues the excess. The `Promise.allSettled` shape is also serving **Per-widget
degradation** (fatal + degradable), a locked term. The finding is the
*unexplained asymmetry*: nothing states whether these two are a considered
exception or an oversight.

### A6 **L** — F2 presentation duplication
`SingleLocationBrief` (`AggregateIntelligenceBriefCard.tsx:69-104`) is
near-verbatim `IntelligenceBriefCard` (`kpi/IntelligenceBriefCard.tsx:11-42`)
plus an unused `displayName` prop; skeleton markup ×4 and error card ×3 despite
`DashboardStatePanel.tsx:52` already owning both.

### A7 **L** — F5/F3/F4 small repeats
`buildPatch` + `dirtyCount` (`useSettingsForm.ts:45`,`:152` vs
`useLocationVoiceForm.ts:113`,`:205`); org-default SELECT ×3
(`dashboard/channels/route.ts:59`, `settings/channels/page.tsx:71`,
`business-channels-service.ts:115`); `telegramAvailable`/`whatsappAvailable`
byte-identical (`route.ts:22` vs `page.tsx:32`); `/settings` default spelled
twice (`page.tsx:4`, `SettingsSidebar.tsx:42`).

### A8 **L** — dead exports in the auth seam
`withRateLimit` (`route-helpers.ts:31`) and `withSession` (`:81`) have **zero
production callers** in a module imported by 83 routes.

---

## B. Cross-feature duplication

### B1 [verified] **H** — trial eligibility is spelled twice and the two disagree

| Site | Predicate |
|---|---|
| `plan-activation.ts:774` (`resolveCheckoutContext`) | `trialEnabled() && onboarded_by === null` |
| `billing/checkout/route.ts:156` | `trialEnabled() && selfServeSignupEnabled() && status === PENDING_PAYMENT && onboarded_by === null` |

Two routes, two answers to "is this account trial-eligible," neither deferring to
the other. The billing route's inline copy is the stricter and its comment
explains each added term — good reasoning that never made it back into the
shared function. F5↔F6.

### B2 [verified] **H** — `onboarded_by`'s primary-scoped subquery has three spellings

- `plan-activation.ts:399-404` — primary-scoped, archived-excluded (**documented owner**)
- `billing/checkout/route.ts:102-107` — second primary-scoped spelling
- `plan-activation.ts:765` — third spelling, **not scoped by `is_primary`** (A4)

The checkout copy's comment (`:92-94`) cites `dashboard/route.ts` as a peer
reader; `dashboard/route.ts:112` records that branch as **deleted**. A stale
comment pointing at a reader that no longer exists.

**Doc-truth consequence:** the field has **6 read sites carrying 5 distinct
meanings** — comp eligibility, trial eligibility (×2 spellings), poller refs
guard (reverse direction), drip sign-off, provisioning attribution.
`.claude/CLAUDE.md` says "three unrelated meanings"; the `#821` log entry says a
"fourth." Both undercount, on the field CLAUDE.md calls *"the single most likely
thing to bite next."*

### B3 **M** — `createBusinessTx`'s twin insert paths, still open

`runAdminTx:222-346` and `runSelfServeTx:348-474` remain two ~125-line siblings
with two 21-column `businesses` INSERTs (`:275-321` / `:402-448`) synchronized by
comment only (`:273-274`, `:399-401`). Tracking doc
`docs/future-plans/2026-08-14-unify-create-business-insert-paths.md:6` —
**"Status: open, not scheduled."** Carried from the #821 log entry; re-confirmed
live, not re-litigated.

### B4 **M** — funnel destination logic re-spelled outside its pure owner

`resolveFunnelEntry` (`funnel-entry.ts:81`) replaced three disagreeing deciders
and is deliberately pure. Three re-spellings now shadow it:
`finish-signup:215-218` (a private `demoEnabled ? start : pay` that matches rows
1/3 only by state coincidence), `onboarding/start/page.tsx:67` and
`onboarding/pay/page.tsx:90` (shadowing rows 1/2 and 4/5). F5 internal, but it
degrades the single-owner property #821 paid for.

### B5 **M** — offboarding enforced twice; F4 writes through F3

Offboarding gate at `(authenticated)/layout.tsx:99-121` **and**
`DashboardContent.tsx:103-114` (F2 internal, server + client).
`ChannelsTabClient.tsx:42` (F4's UI) writes through F3's `PUT /api/settings` —
a cross-feature write path neither feature's chart owns end-to-end.

### B6 **L** — `formatRelative` twice across features
`BusinessesClient.tsx:32` (F1) vs `ReviewFeedCard.tsx:334` (F2).

---

## C. Enforcement-surface findings (not duplication, but structural)

Recorded here because Phase 3 acts on them; full derivation in
`01-flowcharts/s1-auth-gate-seam.md`.

### C1 [verified] **H** — `ci:admin-aal2`'s floor is file-level, and an unused import clears it

`scanRouteFile` (`scripts/ci/admin-aal2-audit.ts:85`) binds
`code = stripComments(text)` for the **whole file**; both rules are
`code.includes(...)`, never verb-scoped:

- deny `:100` — file must not contain `resolveOwnerActor`
- allow `:109`/`:110` — file must contain `requireAdminWithAal2` **or** `resolveAdminActor`

Three consequences, each verified:

1. **An unused import satisfies the allow rule.** In
   `src/app/api/admin/businesses/route.ts`, line 9 is
   `import { requireAdminWithAal2 } …`. Delete the real call at `:56` and the
   audit still passes. *(That file is correct today — its POST does gate at
   `:56`; the control simply would not notice if it stopped.)*
2. **Mixed-verb files launder the gate.** A legitimate `GET` calling the token
   clears `:109` for a sibling `POST` bound to a renamed owner resolver. The
   repo already has mixed-verb admin routes — including the F1/F5 split file
   above.
3. **The `resolveOwnerActor` alias claim in CLAUDE.md is wrong.** A same-file
   alias leaves the literal string and **trips** `:100`. The genuine evasion
   needs a *second file* (a renaming re-export) — confirmed by executing
   `scanRouteFile` against constructed inputs.

No pinned test covers indirection or the mixed-verb case
(`admin-aal2-audit.test.ts:11-261`).

### C2 **H** — the audit does not cover admin *pages* at all

`requireAdminPage`'s `aal2` parameter (`page-gate.ts:41`) **defaults to false**;
8 of 16 admin pages opt in. `scanRouteFile:90` scopes to
`src/app/api/admin/` — so no CI audit examines admin pages in either direction.

### C3 **M** — context that raises C1/C2's stakes

`proxy.ts:147`'s AAL2 enforcement is gated on `MFA_ENFORCEMENT_ENABLED`, which
is **Off** (`env-vars.md:609`). Admin AAL2 on `/api/admin/**` therefore rests
*entirely* on the per-route binding — the layer C1 shows is text-checked.

**Bounding the risk honestly:** residual exposure is **availability, not
privilege escalation**. `proxy.ts:144` blocks non-admins from `/api/admin/**`
and `requireRole` (`db/auth.ts:120`) 403s an admin against role `'owner'`. A
mis-binding breaks the route rather than opening it. The dangerous variant is
admin mutations moving **off** the `/api/admin` prefix, which both the proxy
prefix check and the audit's `:90` scope would miss.

### C4 **M** — four hand-rolled Supabase client preambles beside a single owner
`page-gate.ts:44`, `require-owner-access.ts:44`, `(authenticated)/layout.tsx:63`,
`proxy.ts:50` each construct `createServerClient` inline while
`cookieBackedServerClient` (`db/auth.ts:26`) exists as the owner. Also
`(authenticated)/layout.tsx:95` checks `account_id` but never `role`.

---

## D. DO-NOT-UNIFY — confirmed still deliberate

Verified this pass; **no finding above proposes touching these.**

| Pair | Why it stays two |
|---|---|
| `resolveAdminActor` / `resolveOwnerActor` (`resolve-actor.ts:65`/`:114`) | Body-`businessId`-behind-MFA vs session-`locationId`-behind-role is a **tenant-isolation boundary**. Inherited from the 2026-08-10 register. |
| F3 `settings/billing` vs F6 checkout | Invariant #9a: stored `accounts` quota/price (grandfathered) vs the immutable **Checkout attempt** snapshot. Two read models by design; `quota.ts:85-88` confirmed. |
| `autoApprovalThresholdLabel` shared / the two `AutoApprovalReadinessBlockReason` maps **not** shared (`auto-approval/types.ts:31` vs `:18-23`) | Different registers, both exhaustive over one union. #827 made this call explicitly. |
| The three multi-location checks (`multi-location-mode.ts:8`/`:15`/`:19`) | Invariant #9b — mode / visibility / eligibility. **See E1: a client re-derivation already violates this.** |
| `primary_onboarded_by` as scalar subquery, not JOIN predicate (`plan-activation.ts:399`) | A JOIN predicate would collapse `COUNT(b.id)` and mis-price every multi-location attempt. |
| Admin channel *read* on `requireRoleOr401`, not AAL2 (`admin/businesses/[id]/channels/route.ts:30`) | GET-only; "admin API ⇒ AAL2" is false by contract, not by omission. |

---

## E. Invariant violations found (not duplication — recorded for Phase 3)

### E1 [verified] **M** — invariant #9b collapse in a client hook

```
src/lib/locations/multi-location-mode.ts:12   featureEnabled && activeLocationCount > 1   ← owner
src/hooks/useLocationVoiceForm.ts:196         locations.length > 1                        ← flag dropped
```

Also crosses invariant #13 (browser deciding flag-dependent state locally).
Reachable failure: an account with >1 active location and the flag **off**
renders multi-location voice UI. Presentation-only in this hook — a correctness
bug, not a security one — but it is the precise shape two invariants forbid, in
a file no audit covers (`ci:static-policy`'s check is file-local by its own
admission, `static-policy-audit.ts:139-148`).

---

## F. Not findings — checked and cleared

- **F6's "snapshot never live env" property HOLDS.** All 12 Stripe parameters plus
  the idempotency key traced to the durable snapshot;
  `create-checkout-session.ts` contains zero `process.env` / `readFlag` /
  `getServerConfig` reads (grep-confirmed). The one env read on the path,
  `NEXT_PUBLIC_APP_URL` at `plan-activation.ts:218`, runs at **freeze** time and
  persists into `checkout_attempt_success_url` — correct side of the boundary,
  and a sanctioned raw read (`static-policy-audit.ts:42`).
- **F1's read paths are fully sequential** per #773 — pinned by
  `pool-fanout-sequential.test.ts` + `admin-read-single-inflight.test.ts`.
- **The at-risk list is filtered THEN capped** (`overview-service.ts:171`→`:172`→`:179`),
  matching spec §5.1. The known bug shape is absent.
- **Invariant #14 holds three ways** — sole route, sole SQL-owning module, and
  `ci:static-policy` (`static-policy-audit.ts:139-148`).
- **Invariant #1 holds in F2** — no LLM/Stripe/Zernio/SerpAPI call anywhere in
  the dashboard read stack.
- **F4 owner-shim-binds-`resolveAdminActor`** — reported by the F4 agent as a
  second audit hole; **rejected**. That route would demand admin + AAL2 and
  reject owners: an availability bug running the safe direction, not a tenant
  escape.
