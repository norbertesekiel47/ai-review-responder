# Standards & maintainability review — `admin-invite-funnel` (round 1)

**Reviewer role:** repo standards, maintainability, abstraction quality.
**Diff under review:** `git diff 2b3c872ab9229807cd7aa93259daa85ccdedd012..HEAD` — 116 files, +7158/-1636.
**Skill:** `thermo-nuclear-code-quality-review`, plus `.claude/CLAUDE.md` invariants/working rules, `CONTEXT.md` L121-126 glossary, `codebase-design` vocabulary, Fowler smell baseline.
**Not in scope for me:** spec fidelity (spec agent), approach-level design challenges (design agent). Accepted deviations D-1…D-16 are not re-litigated; unrecorded debt they left behind is.

---

## Headline

This is, on balance, a *good* branch. The dominant act is deletion — a 4-section admin form, a whole prefill route + hook, two form sections, a synthetic dashboard view-state, a dead-end handoff screen, 14 flag gates, and a 15-field Zod schema down to 3. `resolveFunnelEntry` is a genuinely deep, pure module that collapsed three disagreeing owners into one. The migrations are careful and the reasoning-in-comments density is high.

Three things keep it from a clean bill:

1. **The biggest available code-judo move was left on the table.** The diff removed every structural reason `createBusinessTx` needed two transaction bodies, then kept both — ~115 lines of duplicated INSERT SQL whose column ORDER is now held in sync by a comment.
2. **The new "single owner" module is only half-owning its decision.** `resolveFunnelEntry` is pure and table-testable, but its most load-bearing input (`hasPlace`) is hand-spelled at every one of its five call sites, and the module's own doc comment names the duplication rather than removing it.
3. **One concept has three spellings inside this one diff.** "The account's primary business" is written correctly in `plan-activation.ts` (`is_primary = TRUE AND archived_at IS NULL … LIMIT 1`) and incorrectly in the new dashboard aggregate join (no `archived_at` filter, no `LIMIT`), against a partial unique index that explicitly permits archived rows to keep `is_primary = TRUE`.

Plus a `paymentUrl` survivor the deviations file does not record, and a glossary term the branch banned and then re-coined in a live runbook.

---

## Findings (≥80% confidence)

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | HIGH | `src/lib/onboarding/create-business.ts:222-346` / `:348-474` | `runAdminTx` and `runSelfServeTx` are now ~115 lines of near-identical INSERT SQL; the diff deleted every reason they were separate. |
| 2 | HIGH | `src/app/api/dashboard/route.ts:399` | New aggregate `LEFT JOIN businesses … AND b.is_primary = TRUE` omits `AND b.archived_at IS NULL`, so it can fan out and read an archived location's place state. |
| 3 | HIGH | `src/lib/payments/plan-activation.ts:580-620` | `recordCouponDecision` re-solves in-transaction analytics containment with post-commit + swallow; the repo's canonical `tx.savepoint(sp => enqueueAnalyticsEvent(sp, …))` (import-consent.ts:563) gives containment *and* atomicity. |
| 4 | MEDIUM | `src/app/api/admin/businesses/[id]/resend-invite/route.ts:63` | Silent `} catch {` on the fail-closed strict rate limit — 503 with no log and no `reportCaughtError`. |
| 5 | MEDIUM | `src/lib/dashboard/types.ts:158` | `funnelUrl?: string \| null` is optional AND nullable AND widened to `string`, though the route always sends a non-null `FunnelEntryUrl`. |
| 6 | MEDIUM | `src/lib/onboarding/funnel-entry.ts:47` + 5 call sites | The `hasPlace` predicate is re-spelled at every `resolveFunnelEntry` call site; 15 copies now live in `src/`. |
| 7 | MEDIUM | `docs/runbooks/beta-onboarding-cofounder-guide.md:655` | The branch bans "beta discount code" in the **Beta comp coupon** glossary entry and then coins **Beta discount** as a runbook glossary term. |
| 8 | MEDIUM | `src/app/api/onboarding/select-plan/route.ts:331` | CONTEXT.md:125 asserts "`paymentUrl` is deleted, not renamed", but this route's success body is still literally `{ paymentUrl: … }`. |
| 9 | LOW-MED | `src/lib/onboarding/create-business.ts:118` | `CreateBusinessResult.paymentUrl` survives; D-12's stated cost of removing it ("touching self-serve signup callers") is not borne out — no production reader exists. |
| 10 | LOW | `src/lib/payments/plan-activation.ts:219` | `couponId` recomputes what `configuredCoupon` already holds; the ternary and the `?? null` are both dead. |
| 11 | LOW | `src/app/api/signup/place-prefill/route.ts:21` | `PrefillGuardRow.role` is projected and typed but never read — `WHERE u.role = 'owner'` already decided it. |
| 12 | LOW | `src/lib/payments/create-checkout-session.ts:90` | `isWellFormedCouponSnapshot` re-tests `typeof value === 'string'` against a `string \| null` parameter. |
| 13 | LOW | `src/app/onboarding/payment-success/page.tsx:33-63` | Fourth verbatim copy of the owner-page SSR guard preamble; the admin side already has `requireAdminPage(sql, …)`. |

---

## Detail

### 1. HIGH — `createBusinessTx`'s two transaction bodies are now the same function twice

`src/lib/onboarding/create-business.ts:222-346` (`runAdminTx`) and `:348-474` (`runSelfServeTx`).

Before this diff the split was earned: admin mode wrote real place fields, voice arrays, a chosen tier and an outbox row; self-serve wrote placeholders and enqueued nothing. **The diff deleted all of that.** The file's own doc comment now says it out loud:

> "Both modes write an identity-only businesses row with NULL place fields, empty voice arrays and the default tone, and NEITHER enqueues anything… The only content difference is `name`."

What survived is two copies of:

- a 10-column `INSERT INTO accounts` differing only in `display_name`;
- a **21-column** `INSERT INTO businesses` differing in 4 interpolated values (`name`, `owner_phone`, `onboarded_by`, and nothing else — `category`/`google_place_id`/`place_id_verified`/`google_maps_url`/`tone`/`products_services`/the four arrays/`website` are hardcoded identically in both);
- a 7-column `INSERT INTO users` differing only in `auth_id` and `phone`;
- one conditional `channel_enrollments` INSERT, admin-only.

Two smells, both from the Fowler baseline and both material:

- **Shotgun surgery.** Adding a `businesses` column, or changing a default, is now two edits in two 21-column lists that must stay in the same order. The code knows this — both copies carry the comment *"place_id_verified is passed as FALSE explicitly so the column INSERT order matches the self-serve path verbatim"*. A comment is not a mechanism.
- **Divergence risk with a real blast radius.** These are the rows every downstream invariant reads: `onboarded_by` (coupon eligibility, cleanup-poller exclusion, funnel routing), `is_primary`, the billing snapshot. A one-copy edit is silent until a beta tester is charged.

**Remedy (code judo, deletes rather than rearranges).** One `runCreateBusinessTx(sql, {accountId, businessId, userId, displayName, businessName, ownerName, ownerEmail, ownerPhone, authId, onboardedBy, priceVariant, billingSnapshot, enrollVerifiedEmail})`. The mode discriminator stays where it is useful — deriving those six values in `createBusinessTx` — and the SQL exists once. Net effect: roughly −110 lines, one column list, and the `CreateBusinessOptions` union goes back to being a small input mapper instead of a fork in the persistence layer.

While in there: the doc comment's claim that the rows differ only in `name` is itself now inaccurate (`owner_phone` and the `channel_enrollments` row also differ) — worth fixing in the same change, or it becomes the next reader's wrong premise.

### 2. HIGH — three spellings of "the account's primary business", one of them wrong

`src/app/api/dashboard/route.ts:399`:

```sql
LEFT JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
```

Migration `034_multi_location_schema.sql:358` creates the uniqueness guarantee as a **partial** index:

```sql
… WHERE is_primary = TRUE AND archived_at IS NULL;
```

So an archived row legitimately keeps `is_primary = TRUE`, and `src/lib/locations/promote-primary-tx.ts:9,25` documents exactly that. The repo-canonical predicate everywhere else is the pair — `worker/ingress/stripe/apply-subscription-state.ts:164`, migrations 063 and 064, and **this same PR's** `src/lib/payments/plan-activation.ts:394-399`, which spells it correctly *and* adds `LIMIT 1`.

**Concrete failure.** An account archives its original primary location and promotes a new one (`promote-primary-tx` sets `is_primary = FALSE` on the *active* primary only — an already-archived row is untouched). Two rows now satisfy `is_primary = TRUE`. The `LEFT JOIN` fans out, `const [accountRow] = await sql…` takes an arbitrary one, and `funnelUrl` — plus `past_due_at`, `trial_ends_at`, `flags`, `stripe_customer_id` on the same row — is resolved against whichever the planner returned first. The archived location's `place_id_verified`/`google_maps_url` then decide whether the owner is sent to `/onboarding/start` or `/onboarding/demo`.

**Remedy.** Match `plan-activation.ts` byte-for-byte: `AND b.archived_at IS NULL`, and prefer the scalar-subquery-with-`LIMIT 1` shape so a schema surprise cannot multiply the aggregate row. Better still: since this diff created a module that owns the funnel decision, give it (or `src/lib/db/account-guard.ts`, which already projects `is_primary`) the *one* "primary business projection" so the fourth spelling never gets written.

`src/app/api/auth/verify-otp/route.ts:170` carries the same missing `archived_at` filter. Its predicate is pre-existing (I am not charging the diff for it), but the diff made it newly load-bearing by feeding place state from that row into `resolveFunnelEntry` — worth fixing in the same pass.

### 3. HIGH — a bespoke re-solution of a problem the repo already closed with a savepoint

`src/lib/payments/plan-activation.ts:580-620`. `recordCouponDecision` runs **after** `applyTierSnapshot`'s `sql.begin` commits, and swallows failure. The justification in the comment:

> "Post-commit because `checkout_coupon_decision` is admitted by the `analytics_events.event_name` CHECK only once migration 106 is applied; emitting inside `sql.begin` would let an unapplied 106 abort the whole tier snapshot (the blast radius migration 102's header describes)."

That hazard is real, and the repo already has the canonical fix for it. `src/lib/reviews/import-consent.ts:563`:

```ts
await tx.savepoint((sp) => enqueueAnalyticsEvent(sp, input));
```

with ~40 lines of rationale at `import-consent.ts:81-90` and `:477-505` covering precisely this case (migration 102, #679 T1) — including the observation that a savepoint rollback leaves the parent transaction usable, and the trap of a mock handle without `.savepoint`.

The chosen alternative is strictly worse on the axis that matters here. Migration `106`'s own header says:

> "…that event is the ONLY durable signal that a beta tester's comp was silently skipped before they are charged."

Post-commit makes that one signal lossy: any crash, timeout, or isolate teardown between `COMMIT` and the `enqueueAnalyticsEvent` insert loses it, with nothing to reconcile against (the reason is deliberately not persisted — `checkout-attempt.ts:35-38`). The savepoint form is atomic *and* contained: an unapplied 106 rolls back to the savepoint, the tier snapshot commits, and the event is either written with the attempt or provably absent.

**Remedy.** Move the emission inside the existing `sql.begin`, wrapped in `tx.savepoint`, following `import-consent.ts`'s shape. The structured log line can stay post-commit (it is not durable state). Keep `reportCaughtError` on the savepoint's catch — that part is right.

I am flagging this as **canonical-pattern reuse**, not as a design challenge: the standard being violated is CLAUDE.md's "reuse existing helpers / no bespoke helper where a canonical one exists", and the comment's stated reason cites a hazard the repo demonstrably moved past.

### 4. MEDIUM — silent catch on new code

`src/app/api/admin/businesses/[id]/resend-invite/route.ts:63-68`:

```ts
} catch {
  return NextResponse.json(
    { error: 'Rate limiting unavailable — try again later' },
    { status: 503 },
  );
}
```

No binding, no log, no `reportCaughtError`. CLAUDE.md working rules: **"No silent catches."** The repo's posture for the identical call (`checkRateLimit(..., { strict: true })` → 503) is to report first — `src/app/api/onboarding/start/route.ts:260-263` and `:295-298`, `src/app/api/onboarding/business/route.ts` step 6. The consequence is concrete: an Upstash outage on the one admin action that puts mail in a customer's inbox produces zero Sentry signal, and the operator-visible symptom ("Rate limiting unavailable") reads like a cap, not an outage.

Same shape in the newly extracted `src/app/api/signup/place-prefill/route.ts:54-59`. That swallow is carried over from the pre-diff code, so it is not new debt — but the extraction was the moment to fix it, and the helper now hides it behind a name that reads as intentional.

### 5. MEDIUM — `funnelUrl` optionality is a shim with no consumer, and it discards the closed union

`src/lib/dashboard/types.ts:151-158`:

```ts
/** … Nullable so the screen keeps an honest "unavailable" branch for a payload
 *  that predates the field; the route always sends one. */
funnelUrl?: string | null;
```

Three problems, all verifiable:

- **"A payload that predates the field" is not a state that exists.** This is a pre-launch codebase with no external API consumer; the field shipped in the same change as both producers. D-11 deleted the `@deprecated paymentUrl` tombstone for exactly this reason ("a back-compat shim in a pre-launch codebase with no external consumer") — and D-10's own follow-up note named the remaining half of the job: *"which also lets `funnelUrl` become required."* The amendment landed, the fixture was updated, the optionality stayed. **That is unrecorded leftover debt from an accepted deviation** — the class of thing this review is asked to surface.
- **It buys two dead branches.** `src/components/dashboard/account-state/PendingPaymentScreen.tsx:15` (`{data.funnelUrl ? … : …}`) and `src/hooks/useSettingsForm.ts:72` (`json.funnelUrl ?? '/dashboard'`). Both routes compute it via `resolveFunnelEntry`, whose return type is the non-nullable `FunnelEntryUrl`, so neither fallback is reachable through the real producers.
- **The type boundary is widened for no reason.** `resolveFunnelEntry` deliberately returns a closed union (`funnel-entry.ts:31-40`: *"Deliberately a union rather than `string` so consumers type-check against the reachable destinations"*), and the wire type immediately throws that away for `string`. Nothing forces this — the union is a set of string literals and serialises fine.

**Remedy.** `funnelUrl: FunnelEntryUrl;` — required, non-nullable — and delete both fallbacks. `SignupStatusPayload.funnelUrl?: string` in `loginDestination.ts:35` is a *different* case and should stay optional: it is parsed from an untrusted fetch that `useLoginSubmit` soft-fails, and the shape check at `:74` is a security check, not an optionality workaround. That distinction is worth a one-line comment so the next reader does not "unify" them.

### 6. MEDIUM — the funnel module owns the decision but not its predicate

`src/lib/onboarding/funnel-entry.ts` is the good part of this branch. But its `hasPlace` input is re-derived by hand at every call site:

- `src/app/api/dashboard/route.ts:136` — `subRow.place_id_verified || subRow.google_maps_url !== null`
- `src/app/api/dashboard/route.ts:346` — `(accountRow.place_id_verified ?? false) || accountRow.google_maps_url !== null`
- `src/app/api/settings/route.ts:166`
- `src/app/api/auth/signup-status/route.ts:209` (and again at `:198` for `businessOnboarded`)
- `src/app/api/auth/verify-otp/route.ts:248`
- adjacent, and now a *fourth* variant: `src/app/onboarding/start/page.tsx:68` uses truthiness (`|| row.google_maps_url`) rather than `!== null`

Repo-wide there are now **15** hand-written copies of this predicate in `src/` (`rg "place_id_verified \|\|"`), of which 4-5 were added or made newly load-bearing here. And the module's doc comment at `:47-50` *documents* the duplication rather than removing it:

> "`hasPlace` — `place_id_verified || google_maps_url !== null` on the primary business. That is the repo's existing 'location captured' predicate; see `shouldUseDemoWizard` in `src/app/onboarding/business/guard.ts` …"

This is primitive obsession plus a missing model, and it is the same failure mode the funnel decision itself had before this branch: N spellings of one rule, drifting one at a time. CONTEXT.md holds the opposite posture for the analogous case — `suppressionMatchSql` is "owned by the one exported fragment … and never re-implemented at a call site".

**Remedy.** `funnel-entry.ts` exports `hasCapturedPlace(row: {place_id_verified: boolean | null; google_maps_url: string | null}): boolean`, and `resolveFunnelEntry` takes the row shape (or the caller passes `hasCapturedPlace(row)`). `shouldUseDemoWizard`'s `hasLocation` becomes a caller of it. Five call sites collapse to five identical one-liners with one definition behind them — and the `?? false` special case at `dashboard/route.ts:346` (the nullable-from-LEFT-JOIN variant) gets one home instead of being an ad-hoc coercion at the site that most needs care.

### 7. MEDIUM — glossary: **Beta discount** is a second name for **Beta comp coupon**, coined in the change that banned it

`CONTEXT.md:126` locks **Beta comp coupon** with `_Avoid_: promo code, discount code, beta discount code, trial`.

`docs/runbooks/beta-onboarding-cofounder-guide.md` — 405 lines rewritten by this branch — uses "the beta discount" at `:90`, `:320`, `:552`, and at `:655-656` formally defines it as a glossary entry of its own:

```
- **Beta discount** — the automatic 100%-off-for-3-months applied at checkout
  because the account came from an admin invite. There is no promo code to type…
```

A live runbook now teaches the co-founder a name the domain model forbids, and does so in a bolded definition list — the highest-signal place to plant a synonym. The rest of the guide's copy is careful ("nobody types a promo code, and there is no code to type" correctly rejects the *other* banned synonym), which makes this look like an oversight rather than a decision.

**Remedy.** "Beta comp" or "the beta comp coupon" throughout; the `:655` bullet becomes the glossary's own wording. Purely mechanical, one file.

### 8. MEDIUM — glossary: a live API field is still named `paymentUrl`

`CONTEXT.md:125`, on **Funnel entry**, states in bold: **"`paymentUrl` is deleted, not renamed"**, with `_Avoid_: payment URL / `paymentUrl` (the deleted predecessor)`.

`src/app/api/onboarding/select-plan/route.ts:331`:

```ts
return NextResponse.json({ paymentUrl: checkoutUrl }, { headers: NO_STORE });
```

consumed at `src/app/onboarding/pay/PlanPickerClient.tsx:101-102`. The route **is** on this diff (its `CheckoutCouponConfigurationError` mapping was added in the same PR), so the contradiction was in front of the change.

I accept the defence that *this* value is genuinely a Stripe Checkout Session URL and therefore not the deleted funnel field — but that defence is exactly why the glossary sentence needs to change or the field does. As written, CONTEXT.md makes a factual claim about the codebase that `rg paymentUrl` falsifies in one command, which is how a locked glossary loses its authority. Nothing in the deviations file covers this one (D-10/D-11 are the dashboard type; D-12 is `CreateBusinessResult`).

**Remedy, pick one:** rename the field to `checkoutUrl` (2 lines + 2 test fixtures, and it is the more honest name — it is a Session URL, not a payment URL), or amend CONTEXT.md:125 to say the *funnel* field was deleted and name the surviving Stripe-URL field explicitly so the next reader is not surprised.

### 9. LOW-MED — `CreateBusinessResult.paymentUrl` survives, and D-12's cost estimate is wrong

`src/lib/onboarding/create-business.ts:118` (declaration), `:184` (`const paymentUrl = null;`), `:219` (returned).

D-12 accepts leaving it:

> "Left deliberately: deleting it means touching self-serve signup callers for a cosmetic win."

A repo-wide grep does not support that. The complete reference set is:

- the declaration and the two lines that produce it (above);
- `src/lib/onboarding/__tests__/create-business.test.ts:327-339` — two assertions that it is `null`;
- `src/app/api/auth/__tests__/{signup,finish-signup}.test.ts` — mocked *return values* for `createBusinessTx`.

**No production code reads it.** Removing it touches one type, one `const`, one return, and test fixtures — the same class of edit D-11 was granted an amendment to make for the dashboard type. I am not re-opening the *decision* (it is owner-approved), but the recorded justification overstates the cost, and a future reader will trust it. Worth one line of correction in D-12 plus the follow-up ticket, or just doing it.

### 10. LOW — dead branching in the coupon decision

`src/lib/payments/plan-activation.ts:218-219`:

```ts
const configuredCoupon = primaryOnboardedBy !== null ? betaCompCouponId() : null;
const couponId = primaryOnboardedBy !== null ? (configuredCoupon ?? null) : null;
```

`betaCompCouponId()` returns `string | null` (`flags.ts:60-63`), so `?? null` is a no-op; and line 218 already yields `null` in the `primaryOnboardedBy === null` case, so the second ternary re-tests a settled condition. `const couponId = configuredCoupon;` is exactly equivalent — after which `configuredCoupon` has no other reader and the two lines collapse to one.

Small, but it sits in the four lines that decide whether a founding customer gets charged, immediately above a three-arm nested ternary computing `couponReason`. Legibility matters more here than average.

### 11. LOW — dead projection in a new auth guard

`src/app/api/signup/place-prefill/route.ts:20-23` declares `PrefillGuardRow { role: string; subscription_status: string }` and `:124-125` selects `u.role`, but the query's own `AND u.role = 'owner'` means the returned value can only ever be `'owner'` and is never read. Drop `role` from the interface and the SELECT; the row-presence check already carries the meaning (and the comment at `:118-123` already says so).

### 12. LOW — a type-narrowing check against its own parameter type

`src/lib/payments/create-checkout-session.ts:88-91`:

```ts
function isWellFormedCouponSnapshot(value: string | null): boolean {
  if (value === null) return true;
  return typeof value === 'string' && value.trim().length > 0;
}
```

`typeof value === 'string'` is unreachable-false given the signature. The doc comment above it explains an `undefined` case — but D-8 established that the driver cannot produce `undefined` for a projected column ("Loosening the production check to accept `undefined` would be branching around a state the driver cannot produce"), which is why the *fixture* was fixed instead. The residual check is the branch D-8 argued against, kept by accident. `return value.trim().length > 0;` says exactly what is meant.

### 13. LOW — a fourth copy of the owner-page SSR guard preamble

`src/app/onboarding/payment-success/page.tsx:33-63` adds another verbatim `createServerClient(url!, key!, { cookies: { getAll(){…}, setAll(){} } })` → `getUser()` → `SELECT u.role FROM users WHERE u.auth_id = $1` → role-branch block. The same ~30 lines exist in `src/app/onboarding/pay/page.tsx`, `src/app/onboarding/start/page.tsx`, and `src/app/onboarding/business/page.tsx`.

This is pre-existing duplication that the branch grew rather than created — but it grew it while *deleting* the one-line gate that used to stand in for it, so every future de-flagged owner page will add another copy. The admin side already has the canonical answer: `requireAdminPage(sql, { from, aal2 })` (used at `src/app/admin/businesses/new/page.tsx:14`). A `requireOwnerPage(sql, { from, allowedStatuses? })` mirroring it would delete ~90 lines across four files and give the owner-page role/state boundary one definition — which is also where finding 6's `hasCapturedPlace` and finding 2's primary-business projection would naturally live.

---

## Checks that passed — recorded so round 2 does not redo them

- **Invariant 1 (Vercel = UI only).** No new `openai`/`bullmq`/`postgres` runtime imports under `src/app/**` or `src/components/**`. The new SerpAPI call site is the pre-existing documented carve-out, and its header was correctly updated to absorb the deleted admin twin's justification.
- **Invariant 12 (entry points orchestrate).** `resend-invite/route.ts` is a clean orchestrator: gate → rate limit → one module call → error map. Every eligibility rule and provider decision lives in `src/lib/onboarding/resend-invite.ts`. The error class carries its own status, so the catch site has no branching ladder.
- **Invariant 13 (server-authoritative flags).** No new `NEXT_PUBLIC_*`. `funnel-entry.ts` takes `demoEnabled` as a parameter, which is the right seam — the browser learns a URL, never a flag. `betaCompCouponId()` reads through `getServerConfig()` inside the function, not at import.
- **Invariant 15 (explicit DB client).** `resend-invite.ts`, `funnel-entry.ts`, `plan-activation.ts` and `create-checkout-session.ts` all take `sql`/`supabase` as parameters; no `@/lib/db/server` import outside composition roots.
- **Invariant 3 / posting.** Nothing in this diff touches the approval or publish path.
- **`any`.** No production `any`. The `: any` occurrences are all in vitest `sql.begin` mock harnesses (`plan-activation.test.ts`, `create-business.test.ts`) — the established shape for mocking a postgres.js transaction handle in this repo.
- **Migrations 105/106.** Follow the `new-migration` conventions: numbered head, re-runnable, bounded `lock_timeout`, DROP-then-ADD so a reapply repairs a stale definition, the 077-absent-in-prod sequencing exception called out explicitly, 106 documenting the deploy-ordering hazard and the containment. 105's full re-spelling of the 60-line CHECK is unavoidable in Postgres.
- **String literals.** No new job-name, tier-id or review-status literals. `SubscriptionStatus`/`SubscriptionTier` constants are used at the new TS comparison sites (`resend-invite.ts:308`, `BusinessDetailClient.tsx:59`, `place-prefill/route.ts:135`, `start/page.tsx:62`).
- **New files vs `docs/directory.md`.** Both new production modules (`funnel-entry.ts`, `resend-invite.ts`) are documented. No new top-level directory.
- **Deletion hygiene.** `PendingAdminHandoffScreen`, `pending_payment_admin_handoff`, `useBusinessPrefill`, the admin prefill route, and the two form sections are gone *with* their cross-references (`console-admin-palette.test.ts` sweep rows, `static-policy-audit` allowlist lines, `docs/directory.md`, `docs/launch-checklist.md`, `docs/design/landing-page.md` — now `docs/design/landing/DESIGN.md`). The `place-prefill/route.ts:14` stale comment that D-9/D-14 both deferred **was** closed before the gate run — verified present in the diff.

---

## Low-confidence appendix — observations I would NOT stake 80% on

These are judgement calls, not standards violations. Recorded for the author, deliberately excluded from the findings table.

1. **`SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` gained two entries that may not have been necessary.** `src/app/api/onboarding/{business,start}/route.ts` write `subscription_status = 'pending_payment'` as a SQL literal plus an `-- enum:` comment plus two `scripts/ci/static-policy-audit.ts` allowlist lines. The dominant repo convention is bind-parameter interpolation — `${SubscriptionStatus.PENDING_PAYMENT}` — used at 11 sites including `create-business.ts` in this very diff, and it needs no comment, no allowlist entry and no CI carve-out. Both new sites are plain `WHERE` predicates on an `UPDATE`, so none of the `ON CONFLICT`/partial-index byte-for-byte constraints that force a literal elsewhere apply. **Why this is not in the table:** the allowlist + comment convention is explicitly sanctioned by the audit's own design and has 25 existing carve-outs, so "should have used the constant" is a preference about which sanctioned form to pick, and I have not read every existing carve-out to know whether some local reason (test assertion on emitted SQL text — which D-6 mentions) genuinely forces the literal here.

2. **`BusinessInfoSection.tsx` is now a one-input component** whose file header argues for its own existence ("One field, deliberately still a component… Collapsing only this one inline would leave the client half-orchestrating, half-rendering"). That is a defensible symmetry argument, and the symmetry with `OwnerInfoSection` is real. I lean toward inlining both into `NewBusinessClient` — three inputs and a submit button do not need a component tree — but this is taste, and the stated reason is coherent.

3. **`ResendInviteState` is three fields expressing four states.** `{submitting, message, error}` admits `{submitting: true, message: 'x'}`, which the reducer never produces. A discriminated union (`{status:'idle'} | {status:'submitting'} | {status:'success', message} | {status:'error', error}`) would make it unrepresentable. The reducer already enforces it at runtime, and the existing sibling mutation in the same hook (`clearBounceFlag`) uses a plainer shape — so "add a reducer here" was already a step up. Not worth a round-2 edit.

4. **`mapCouponRejection` returns `unknown` for the caller to `throw`.** `create-checkout-session.ts:404-419`. It reads slightly inside-out (a mapper that returns the thing you must remember to throw), and a `never`-returning `throwMappedCouponRejection` would be harder to misuse. But the current shape keeps the `.catch(e => { throw map(e) })` idiom that makes the pass-through case obvious, so it is arguably clearer as-is.

5. **Migration 106 has no explicit `BEGIN;`/`COMMIT;`** where 105 does. If the runner wraps each file in a transaction this is moot, and 106 says its shape follows 046→102, so it is presumably consistent with its siblings. I did not verify the runner's behaviour or read 102, so I am not asserting anything.

6. **`applyTierSnapshot`'s inner result shape churn.** The `sql.begin` callback now returns `{…, couponDecision}` on both the reuse and create paths, and the outer function strips the field before returning `TierSnapshotResult`. The exported type is unchanged (verified — `plan-activation.ts:58-67`), so nothing leaks; it is just one more shape a reader holds while following the function. An out-parameter (`let couponDecision` in the closure scope) would be flatter, but arguably worse. Genuinely a wash.

7. **`resolveFunnelEntry`'s `subscriptionStatus: string`.** The interface takes a bare `string` rather than a `SubscriptionStatusValue`, so a typo'd status silently falls through to `/dashboard`. Every caller passes a DB-read value that is `string`-typed anyway, so tightening it would just move the cast — which is why I am not flagging it. Worth remembering if the status columns ever get a branded type.

---

**Verdict on my axis:** REQUEST CHANGES — findings 1, 2 and 3. Findings 4-8 are cheap and should ride along. 9-13 are the author's call.

---

## Triage verdicts — round 1, 2026-08-14

Each high was verified against the code before triage; all three held.

| # | Sev | Verdict |
|---|---|---|
| 1 | HIGH | `create-business.ts` duplication — **ACCEPTED, DEFERRED by owner decision.** Real, and the column-order hazard is correctly characterised. Deferred because it is the highest-risk file on the branch and already proven end-to-end on staging; a ~230-line no-behaviour-change restructure would void that proof. Filed: `docs/future-plans/2026-08-14-unify-create-business-insert-paths.md`. |
| 2 | HIGH | Missing `archived_at IS NULL` on the aggregate primary join — **ACCEPTED, FIXED.** Confirmed against `034`'s partial unique index. The only finding this round that silently corrupts a live owner's payload. |
| 3 | HIGH | `recordCouponDecision` post-commit + swallow — **ACCEPTED, FIXED** via `tx.savepoint`. Half the reasoning corrected: the rollback direction cannot occur (gated on `result.kind === 'ok'`), but crash-after-commit is real — and the un-migrated-106 objection the original comment raised is answered by the savepoint rather than by the ordering, so the fix keeps both properties. |
| 4 | MED | Silent `catch {}` on the fail-closed invite rate limit — **ACCEPTED, FIXED** (`reportCaughtError` before the 503). |
| 5 | MED | `funnelUrl` optional + nullable + widened — **ACCEPTED, DEFERRED.** Type-only tightening, no behavioural effect; belongs with the D-12 cleanup rather than adding churn to a staging-proven branch. |
| 6 | MED | `hasPlace` hand-spelled at 15 call sites — **ACCEPTED, DEFERRED**, same follow-up. The predicate is identical at every site today, so this is rot-prevention, not a live defect. |
| 7 | MED | Glossary: **Beta discount** — **ACCEPTED, FIXED.** All four prose sites now say **Beta comp coupon**; the glossary entry retains the banned form only as an explicit "say this, not that". |
| 8 | MED | `select-plan` still returns `paymentUrl` — **ACCEPTED WITH A DIFFERENT FIX.** The route is right: that field holds a genuine Stripe payment URL. `CONTEXT.md`'s flat "`paymentUrl` is deleted, not renamed" was over-broad — the claim concerns the *dashboard's funnel-destination* field — so the doc was corrected, not the code. |
| 9 | LOW-MED | `CreateBusinessResult.paymentUrl` dead field — **ACCEPTED, DEFERRED.** The reviewer is right that D-12's stated cost does not hold; that correction is recorded in the follow-up doc. |
| 10 | LOW | Dead ternary at `plan-activation.ts:219` — **ACCEPTED, FIXED**; collapsed to one binding. |
| 11 | LOW | Unread `role` projection in `place-prefill` — **ACCEPTED, FIXED**; dropped from both the type and the SELECT. |
| 12 | LOW | `isWellFormedCouponSnapshot`'s `typeof` re-test — **REJECTED.** The function's own doc comment (`create-checkout-session.ts:85-86`) states an un-projected column arrives as runtime `undefined`, which `string \| null` does not express. Deliberate runtime narrowing, not redundancy — removing it would delete a real guard. |
| 13 | LOW | Fourth copy of the owner-page SSR preamble — **ACCEPTED, DEFERRED.** Extracting a `requireOwnerPage` twin of `requireAdminPage` is the right shape but touches four page files outside this round's risk budget; folded into the follow-up. |
