# Review — SPEC & CORRECTNESS axis

Branch: `fix/batch-e-screens-vs-runtime`
HEAD reviewed: `825f0fbbf9f0275b98148ba70ee44da2e315be6a`
Fork point: `d79bc765ce630ea651efe67ec6a7b3488c5afa86`
Every file read through `git show 825f0fbbf:<path>`; the diff taken as
`git diff d79bc765..825f0fbbf`. Working tree verified clean (`git status --porcelain`
empty, `git diff --stat 825f0fbbf` empty) before and after every command run, so no
red-team mutation is in any result below.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| medium | `worker/boot-flag-summary.ts:37` | The eleven-flag boot record omits `AUTOPILOT_PURCHASABLE`, the sixth and final step of the documented ordered go-live flip, and the omission is recorded nowhere |
| medium | `src/lib/auto-approval/posting-status.ts:3` | The Posting block's own definition is broader than its five members: `active_zernio_connection_missing` is a persistent structural refusal that is not a member and is named as a residual nowhere |
| low | `src/lib/accounts/tier-config.ts:163` | `tierChangeDirection` derives direction from `indexOf` on an array that `satisfies` permits to be a SUBSET of the tiers; a future tier missing from it yields a confident, silently inverted direction with every test green |
| low | `src/lib/auto-approval/__tests__/posting-status.test.ts:82` | The builder-level trap test is vacuous — it cannot fail for the reason its comment names, because the builder has no purchasability input at all |
| low | `worker/__tests__/boot-flag-summary.test.ts:107` | The only emit test uses a fake logger, so the docblock's "nothing is redacted" claim is never exercised against the real `createWorkerLogger` sanitizer, which silently drops keys by substring |

### medium — `worker/boot-flag-summary.ts:37`

`buildBootFlagSummary` declares "the five autonomy flags that gate acting on a
customer's behalf". The repo's own definition of the autonomy flag set is six:
`.claude/skills/flag-flip/SKILL.md:3` and `:17` and
`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md:421` both give
the ordered prod flip as `TRIAGE_ENABLED` → `ESCALATION_ENABLED` →
`JUDGE_ENABLED`+`GOVERNOR_ENABLED` → `AUTO_APPROVAL_ENABLED` → **`AUTOPILOT_PURCHASABLE`**.

The worker reads it: `autopilotPurchasable()`
(`src/lib/payments/tier-purchasability.ts:8`) is called by
`worker/ingress/stripe/checkout-completed.ts` and
`worker/ingress/stripe/subscription-updated.ts`.

Concrete failure scenario: an operator performs the last step of the go-live
sequence and sets `AUTOPILOT_PURCHASABLE=true` on Railway. #1173's whole premise —
"reading Railway variables back is refused because the response carries plaintext
secrets, so this log line is the only way to confirm a flag flip actually reached
the process" (`worker/boot-flag-summary.ts:3-6`) — still holds for that flip, and
the new boot line cannot confirm it. Exactly the state the branch exists to end.

There is a defensible design reason to exclude it — `autopilotPurchasable()` is
not a `flags.ts` `readFlag` accessor and composes with `AUTO_APPROVAL_ENABLED`, so
printing it would report a composed value rather than the raw env — but the module
docblock records only the `SOLICITATION_WATCH_ENABLED` exclusion
(`worker/boot-flag-summary.ts:34`), and neither the intake, the plan nor
`fix-batch-e-screens-vs-runtime-deviations.md` names it. An unrecorded scope
reduction against a list CLAUDE.md-adjacent docs own.

Compounding, and this is the part that makes it undetectable later:
`worker/__tests__/boot-flag-summary.test.ts:10`'s `DECLARED_FLAG_KEYS` is a
transcription of the production list, not an independent source. So
`boot flag summary contains exactly the eleven declared flag keys` can catch a
rename or a stray key, but by construction can never catch a *missing* flag.
intake `non_goals[4]` explicitly defers a registry + `ci:` audit, which is fine —
but the promised test reads as completeness protection and provides none.

### medium — `src/lib/auto-approval/posting-status.ts:3`

The module's own definition: "A **Posting block** is a structural, account-wide
condition that makes the Auto-approval lane decline every draft, independent of the
policy row." The same sentence is now the glossary term
(`docs/context/core-reviews-responses.md`, the `Posting block` entry) and the
directory row (`docs/directory/lib-reviews-responses.md`).

`active_zernio_connection_missing`
(`worker/jobs/response-generation/auto-approval.ts:373`) satisfies that definition
and is not a member. Concrete failure scenario: a single-location account on
Autopilot with every flag on, an armed `4–5★` account default, and a Zernio
connection that went inactive — the documented `account.disconnected` webhook
(CLAUDE.md gotcha → `.claude/rules/reviews-import.md`). `posting.blocked` is
`false`, `describePolicyStatus` falls through to the last branch
(`AutoApprovalClient.tsx:735`), and the headline reads "4–5★ reviews post a reply
automatically 15 minutes after you're notified" while `evaluateAutoApprovalCandidate`
blocks every draft. That is the #1314 contradiction, on the screen #1314 was filed
against.

The plan names exactly one residual — `JUDGE_ENABLED=true` with a dead sweep
(plan §T1, lines 136-146; deviations R1b) — and that reasoning is sound: three
fleet-wide queries per render for a transient answer is the right trade, the
boundary between *structural/configured* and *operational/health* is drawn where
the plan says it is, and `judge_disabled` is correctly a member because
`applyJudgeGateInTx` (`worker/jobs/publisher/judge-gate.ts:42`) refuses on
`!judgeEnabled()` before anything else. But it is **not** the only residual. The
Zernio-connection gate is neither transient nor fleet-wide: it is one indexed
per-location read, it persists until an owner reconnects, and it is absent from the
plan, the intake `non_goals`, and all ten deviation entries.

For the record, `archived_location`
(`worker/jobs/response-generation/auto-approval.ts:372`) is legitimately excluded:
`loadActiveLocationSettings` (`src/lib/auto-approval/settings.ts:1091`) filters
`b.archived_at IS NULL`, so an archived location never appears on the page and can
produce no contradiction.

### low — `src/lib/accounts/tier-config.ts:163`

```ts
const fromIndex = SUBSCRIPTION_TIER_ORDER.indexOf(from);
const toIndex = SUBSCRIPTION_TIER_ORDER.indexOf(to);
if (toIndex === fromIndex) return 'same';
return toIndex > fromIndex ? 'up' : 'down';
```

`SUBSCRIPTION_TIER_ORDER` is `as const satisfies readonly SubscriptionTierValue[]`,
which constrains the *members* but permits a SUBSET. Adding a third tier to
`SubscriptionTier` without touching the order array makes `indexOf` return `-1`:
`tierChangeDirection(COPILOT, NEW_TIER)` returns `'down'` and the card renders
"Downgrade to <new tier>", while the reverse returns `'up'`. Typecheck green, all 23
tier-config/BillingPanel direction tests green, no runtime error. The replaced price
comparison degraded more gracefully because it read a real price for the new tier.

The intake invariant "tier order has exactly one owner in
`src/lib/accounts/tier-config.ts`" is satisfied; what is missing is that nothing
pins the owner *complete*. A one-line exhaustiveness pin
(`expect([...SUBSCRIPTION_TIER_ORDER].sort()).toEqual(Object.values(SubscriptionTier).sort())`)
closes it.

### low — `src/lib/auto-approval/__tests__/posting-status.test.ts:82`

```ts
it('does not report a reason for an autopilot tier whose sale is paused', () => {
  const status = buildAutoApprovalPostingStatus({ ...passingInput(), tierGrantsAutopilot: true });
```

`passingInput()` already sets `tierGrantsAutopilot: true`, and the builder's input
type has no purchasability field at all, so the spread is a no-op and the body is
byte-equivalent to `reports no reason and blocked false when every structural gate
passes` two tests above. The test cannot fail for the reason its comment names —
there is no state of `posting-status.ts` in which a paused sale is visible to it.

Protection for the trap does exist and is real, one layer up:
`src/lib/auto-approval/__tests__/settings.test.ts:2489` (`loadAutoApprovalSettings
returns posting.blocked false and readiness.blockReasons containing
autopilot_unavailable…`) sets `AUTOPILOT_PURCHASABLE=false` against the real loader,
and D5 records the orchestrator independently re-applying
`tierGrantsAutopilot(tier) && autopilotPurchasable()` and observing that test fail by
name. So this is a promised title that contributes nothing, not a hole.

### low — `worker/__tests__/boot-flag-summary.test.ts:107`

`logBootFlagSummary calls the supplied logger once with Feature flags and all eleven
flag booleans` passes `{ log: vi.fn() }`. Nothing in the branch exercises the real
`createWorkerLogger('[worker]')` that `worker/index.ts:625` actually passes.

`createWorkerLogger` routes every object arg through `sanitizeAnalyticsProperties`
(`src/lib/shared/logger.ts:97` → `src/lib/analytics/events.ts:111`), which **drops**
any key where `isBlockedPropertyKey` matches — including the substring rules
`lowerKey.includes('token' | 'secret' | 'password')`
(`src/lib/analytics/events.ts:71-73`). A dropped key is silent: the record simply
does not carry it.

Verified: none of the eleven current keys matches, so
`worker/boot-flag-summary.ts:31`'s claim ("these are booleans, so nothing is
redacted") is true **today**. It is asserted by no test. A twelfth flag named, say,
`REFRESH_TOKEN_ROTATION_ENABLED` would disappear from the only operator-verifiable
boot record with the whole suite green. One assertion against a spied `console.log`
with the real logger closes it.

---

## Verification of the seven specific claims

**1. The trap — `autopilot_unavailable` must not reach the posting fact. VERIFIED
end to end, builder → loader → client.**

- Builder: `buildAutoApprovalPostingStatus`'s input type has **no** purchasability
  field (`posting-status.ts:29-35`); the tier input is named `tierGrantsAutopilot`
  so the readiness value cannot be passed positionally or by shape.
- Loader: `buildPostingStatus` (`src/lib/auto-approval/settings.ts:1218`) calls
  `tierGrantsAutopilot(account?.subscription_tier)` **directly**, not the
  `autopilotAvailable` local that `buildReadiness` (`:1196`) composes as
  `tierGrantsAutopilot(...) && autopilotPurchasable()`. The two are computed in
  separate functions; no value flows between them.
- Client: the blocked branch (`AutoApprovalClient.tsx:684`) reads
  `data.posting.blocked` / `data.posting.reasons` only. `grep` over the component
  confirms `readiness` is referenced only by `ReadinessNotices` and the expansion
  controls; the headline never reads it.
- Asserted at both ends: `settings.test.ts` "returns posting.blocked false and
  readiness.blockReasons containing autopilot_unavailable…" and
  `AutoApprovalClient.test.tsx:236` "headline still claims automatic posting for an
  autopilot tier whose sale is paused". Both pass; the loader one is the
  discriminating test, and D5 records it catching the exact trap mutation.

**2. The Judge exclusion. Boundary is where the plan says; reasoning sound; the
residual is NOT the only one.**

`judge_disabled` is correctly a member — `applyJudgeGate`/`applyJudgeGateInTx`
(`worker/jobs/publisher/judge-gate.ts:22` and `:42`) test `!judgeEnabled()` first and
downgrade, which is CLAUDE.md invariant #3 verbatim. Excluding `isJudgeHealthy`
(`src/lib/responses/judge-health.ts:73`) is sound on the stated grounds and the
structural-vs-operational line is drawn consistently. But see the medium finding
above: `active_zernio_connection_missing` is a second, unstated residual, and it is
structural rather than operational, so the plan's own criterion does not exclude it.

**3. Admin contract isolation. VERIFIED.**

`AutoApprovalReadiness` and `AutoApprovalReadinessBlockReason` are byte-unchanged in
`src/lib/auto-approval/types.ts` (the diff adds only the new types below them and one
`posting` field on `AutoApprovalSettingsResponse`). `docs/admin-api/admin-api.d.ts` is
not in the diff. `pnpm ci:admin-contract` → `PASS: 37 Admin API routes; 19
byte-identical artifacts; canonical gate provenance verified.` The loader test
additionally pins `Object.keys(result.readiness).sort()` to the six existing keys, so
a future leak of a posting reason into readiness fails by name.

**4. Presentation-only, #1054. VERIFIED.**

`confirmTierChange` (`src/components/dashboard/settings/BillingPanel.tsx:387`) posts
`JSON.stringify({ accountId: accountData.accountId, newTier: selectedTier })` and an
`Idempotency-Key` header — no `direction`, no `isDowngrade`. The preview call
(`:364`) posts `{ accountId, newTier, preview: true }`. Neither is touched by the
diff. Invariant #9a intact: `displayedBaseCents = isCurrent ?
accountData.billing.basePriceCents : option.basePriceCents` (`:464`) is unchanged, so
the *current* plan card still reads the STORED grandfathered price; the stored price
was removed only from the direction decision (`:415` and `:455`). The trialing
downgrade path is correct against invariant #11: the warning is ungated on `trialing`
(`:185`), and D8 records that gate being deliberately added and then removed.

**5. Branch order in `describePolicyStatus`. As specified; no state falls through
wrongly.**

Order at `AutoApprovalClient.tsx:670` → `:684` → `:702`: suspended, then blocked,
then off. Enumerated the full state space (suspended × blocked × threshold ×
overrides):

| suspended | posting.blocked | threshold | overrides | branch | correct |
|---|---|---|---|---|---|
| yes | any | any | any | suspended (red, `role="alert"`) | yes — edge_cases[2] |
| no | yes | set | any | blocked | yes |
| no | yes | null | ≥1 | blocked, override wording | yes — edge_cases[4] |
| no | yes | null | 0 | plain off | yes — edge_cases[3], the "already true" case |
| no | no | null | 0 | plain off | unchanged |
| no | no | null | ≥1 | override-posts | unchanged |
| no | no | set | any | on | unchanged |

Multiple reasons need no precedence (`:691` maps every reason to its own `<div>`);
edge_cases[1] holds. Banner tone: `banner-attn` + `role="status"` for blocked,
`banner-red` + `role="alert"` reserved for suspension (`:757-763`). `.banner-attn`
exists (`console.css:1267`) and `.banner-attn .banner-cta:hover` (`:1300`) already
styles the CTA in that variant, so the retained action is not left unstyled.

**6. `canTurnOff: account.threshold !== null`. No action is withheld that would have
worked.**

The only new `false` is the override-only case (`threshold === null`, overrides
present). Pre-change, that state hit the override branch at `:711-716`, which
*already* returned `canTurnOff: false`. So the blocked branch withholds nothing that
was previously offered, and the stated reason is correct: `set_account_manual` clears
only the account-default threshold and would leave the overrides armed. Asserted by
`blocked override-only headline does not offer an account-default turn-off action`
and `blocked headline keeps the turn off auto-posting action`.

**7. T3 wiring. The AST test is strong; two narrow gaps, neither a defect today.**

`worker/__tests__/boot-flag-summary.test.ts:137` parses `worker/index.ts` with the
TypeScript compiler and asserts: exactly one `logBootFlagSummary` call; its parent is
an `ExpressionStatement` (not a condition operand); the nearest enclosing function is
the declaration named `main`; every node between is a `Block` or a `TryStatement`
(kills `if (false)`, a `catch`, a loop, a callback); and at least one `TryStatement` is
present. Verified against the source: the call is at `worker/index.ts:625`, last
statement of the startup `try`, with no early `return` or `throw` on any preceding
line (`:610-624` are all assertions that `process.exit(1)` via the `catch`), and
`main()` is invoked at `:995`.

Two things the test does not cover — both contrived, neither a defect on this branch:
(a) it never inspects the *argument*, so `logBootFlagSummary(noopLogger)` would pass;
(b) `main()`'s own invocation is not asserted. The substantive gap is the sanitizer
one, filed as the last low finding above.

---

## Intake conformance

**`tests_to_add` — 53/53 present verbatim.** Checked programmatically: every one of
the 53 titles appears character-for-character in the seven test files the diff
touches. All seven suites green at `825f0fbbf` (`posting-status` +
`boot-flag-summary` + `tier-config`: 40/40; `AutoApprovalClient` + `BillingPanel` +
`settings`: 174/174).

**`user_visible_behavior` — 10/10 delivered.** Item 8 (the downgrade autonomy
warning) I checked for truthfulness as well as presence: the copy claims "Every reply
waits for your approval from the moment the plan changes", and
`worker/jobs/publisher/auto-policy-publish.ts:600` re-checks
`tierGrantsAutopilot(lane.entitlement.subscription_tier)` at publish time, so an
already-approved row sitting in its veto window really is downgraded rather than
posted after a tier change. The claim holds.

**`edge_cases` — 15/16 covered, 1 behaviourally correct but untested.**
`past_due inside the 7-day grace: … so no posting block is reported` has no test on
the grace path itself. The loader test proves the *allowed* outcome only via an
EXPIRED `past_due` lifted by a live `past_due_extension` flag. The behaviour is right
(`checkSubscription` at `src/lib/shared/subscription-guard.ts:49` returns
`{allowed:true}` inside the grace) and that predicate owns its own suite, and the
loader test does prove all three inputs propagate — so the risk is genuinely low.
Noted, not filed.

**`invariants` — 9/9 hold.** #3: no gate in
`evaluateAutoApprovalCandidate`/`publisher` is touched; the diff is read-path,
presentation and logging only. #12: `worker/index.ts` gains one call and loses three
imports; the flag list lives in the module. #13: `pnpm ci:static-policy` passes, no
`NEXT_PUBLIC_*` added, the fact reaches the browser only through the settings
response. #15: `posting-status.ts` imports no DB client; `buildPostingStatus` takes
the already-loaded row and issues no query.

**Edit surface.** Every changed path is in `allowed_edit_surface`.
`docs/agents/change-ledger.md` is listed but untouched — allowed, not required.

**Verification commands.** All five run clean at `825f0fbbf`: the two vitest suites,
`ci:directory-map` (631 files, no stale rows), `ci:static-policy` (1274 files),
`ci:admin-contract` (PASS).

---

## Weakened checks — mandatory section

`pnpm ci:weakened-checks` → **`weakened-checks-audit: passed (no finding)`**.
Zero FAIL rows and **zero REVIEW rows**, so there is no row for which protection
could have been lost.

Independently confirmed rather than taken from the audit's word, because the audit
resolves its base as `origin/main` (`scripts/ci/merge-ledger-audit.ts:157`) and a
wrong base is the way this gate silently passes:

- `git merge-base origin/main HEAD` = `d79bc765…` = the stated fork point, so the
  audit read the whole branch diff.
- Per-file `expect(` delta across every touched test file — all non-negative, none
  removed:
  `AutoApprovalClient.test.tsx` +29/−0 · `BillingPanel.test.tsx` +15/−0 ·
  `tier-config.test.ts` +8/−0 · `context.test.ts` +0/−0 ·
  `posting-status.test.ts` +9/−0 · `settings.test.ts` +14/−0 ·
  `boot-flag-summary.test.ts` +17/−0.
- No test file deleted, no `.only`/`.skip`/`xit`, no new `eslint-disable`,
  `@ts-expect-error`, `@ts-ignore` or other suppression, no `DIFF_COVERAGE_MIN`
  change, no quality-config file (`vitest.config.ts`, `eslint.config.mjs`,
  `lefthook.yml`, `.fallowrc.jsonc`) in the diff.

**Conclusion: no protection was lost anywhere on this branch.** Nothing to relocate,
nothing to justify by allowlist.

### Can the new tests pass while the promised behavior is wrong?

Four places, all filed above or here:

1. `boot flag summary contains exactly the eleven declared flag keys` — YES, for a
   *missing* flag. `DECLARED_FLAG_KEYS` is a transcription of the production list.
   (medium finding 1.)
2. `logBootFlagSummary calls the supplied logger once…` — YES, for a key the real
   sanitizer drops. (low finding 5.)
3. `does not report a reason for an autopilot tier whose sale is paused` — YES,
   always: it is vacuous. (low finding 4.) The loader-level trap test is the one that
   actually discriminates, and it does.
4. `tierChangeDirection` suite — YES, for a tier absent from
   `SUBSCRIPTION_TIER_ORDER`. (low finding 3.)

Everything else discriminates. The two most likely wrong-but-green implementations
were both checked and both fail by name: a card direction re-implemented as a live
catalogue-price comparison (caught by `billing cards retain upgrade and downgrade
labels when both catalogue prices are equal` — D8 records the orchestrator running
exactly that mutation, 1 failed / 22 passed), and a loader forwarding the readiness
`autopilotAvailable` into `tierGrantsAutopilot` (caught by the trap loader test, D5,
2 failed / 91 passed).

### D5 / D7 / D8 — the "cannot start RED" claims, interrogated

All three claims hold on inspection; I re-derived each rather than accepting them.

- **D5 (nine T1 titles).** Correct in kind. A test referencing `data.posting` cannot
  be authored before `AutoApprovalPostingStatus` exists — it would be a compile
  ERROR, which the TDD rule distinguishes from a RED. The mutation list is the right
  set and it includes the trap. The claim is not self-reported: D5 records the
  orchestrator independently re-applying two mutations and observing the named tests
  fail. Of the nine, one (`does not report a reason for an autopilot tier whose sale
  is paused`) is worse than "cannot start RED" — it can never fail at all; filed.
- **D7 (two T3 titles).** Correct. Both titles pin `readFlag`'s `=== 'true'`
  comparison, which lives at `src/lib/config/flags.ts:22` — outside T3's lease, and
  the plan forbids a second `readFlag` site. Verified independently: `readFlag` is
  `process.env[name] === 'true'` and is documented NOT memoized (`flags.ts:16`), which
  is why the near-miss cases (`'True'`, `' true'`, `'true '`) are real assertions and
  not tautologies. Mutating the `TRIAGE_ENABLED` slot to
  `Boolean(process.env.TRIAGE_ENABLED)` is the correct local substitute; escalating
  rather than widening the lease was right.
- **D8 (four T2 titles).** Correct, and the reasoning on the two card-label titles is
  the important one — today's catalogue order agrees with autonomy order, which is
  exactly why the equal-and-reversed price tests exist. I re-derived that
  independence directly: `tierChangeDirection` reads only
  `SUBSCRIPTION_TIER_ORDER.indexOf`, never `TIER_CONFIG`, so no catalogue price can
  move it, and the equal-price test would fail a price-based body. The `aria-label`
  query correction was made while RED and re-confirmed RED, so it did not weaken the
  assertion.

### Trust boundary — wrong tenant, missing authorization, replayed/stale input

The change crosses one trust boundary: a new server-computed field on the
authenticated owner endpoint `GET|PATCH /api/settings/auto-approval`.

- **Wrong tenant.** No new query and no new tenant surface: `buildPostingStatus`
  consumes the `SettingsAccountEntitlementRow` already loaded by
  `loadSettingsAccount(db, input.accountId)` (`settings.ts:1170`), whose `WHERE id =
  ${accountId}::uuid` is unchanged. `accountId` still comes from the route's owner
  resolution (`src/app/api/settings/auto-approval/route.ts:25`, `:41`). `db_touching:
  false` is accurate and `ci:tenant-scope`/`ci:rls-audit` have nothing new to cover.
- **Missing authorization.** Both handlers return `owner.response` before reaching
  the loader; the diff adds no reachable path around that.
- **Replayed / stale input.** The posting fact is derived per request from live flag
  accessors and the same-request account row; it is never persisted, never accepted
  from the client, and carries no token or nonce, so there is nothing to replay. The
  PATCH lane returns it from the same in-transaction reload (`settings.ts:210`), so it
  cannot go stale relative to the write it reports on.

No negative test is owed on any of the three, and the branch promises none. Verified
the field cannot arrive `undefined` on the client: the PATCH response path
(`AutoApprovalClient.tsx:272` casts the body unvalidated) is fed by
`patchAutoApprovalSettingsInTransaction`, which ends in the same
`loadAutoApprovalSettings` — so `data.posting.blocked` has no path to a TypeError.

### Compromises the review record does not already name

1. `AUTOPILOT_PURCHASABLE` excluded from the boot summary (medium finding 1) — the
   module records only the `SOLICITATION_WATCH_ENABLED` exclusion.
2. `active_zernio_connection_missing` excluded from the Posting block (medium
   finding 2) — only Judge health is named as a residual.
3. The glossary and directory rows inherit the module's over-broad definition
   sentence, so the compromise in (2) is now written into two docs as though the
   enumeration were exhaustive.
4. With `currentTier === null` (a non-launch tier), `direction` is `null` and *both*
   cards now read "Upgrade" (`BillingPanel.tsx:462`), where the old price comparison
   produced a mix. The buttons are disabled and the "unavailable" note renders, so
   nothing is actionable — but intake `edge_cases[8]` says "no direction is computed",
   which is true of the variable and not of the rendered verb. No test covers it.
5. The new blocked banner can render up to six detail lines (five reasons plus the
   closing sentence). Production today has every autonomy flag off, so the realistic
   first render is 2–3 lines; at 390px this is still a taller banner than any state
   the page had before. Flagged for the design axis, not adjudicated here.

---

## Low-confidence appendix (not findings)

- **Owner Operator consistency.** `src/lib/agents/operator/context.ts` consumes the
  same `AutoApprovalSettingsResponse` and now receives `posting` but projects only
  the raw dials (`projectPolicyStates:95`, `toRuleSummary:126`). The model composes
  the owner-facing sentence from those dials, so it may still describe a policy as
  posting while the settings page two clicks away says nothing posts. I cannot
  demonstrate a specific wrong sentence without running the model, and the intake
  scopes the operator to a test-fixture amendment only, so this is an observation.
- **Plan citation drift.** The plan cites `settings.ts:1177` for `buildReadiness`;
  at `825f0fbbf` it is at `:1183`, moved by this branch's own insertion. Every other
  citation I resolved is exact:
  `auto-approval.ts:345`, `judge-gate.ts:41` (the docblock; the function is `:42`),
  `readiness.ts:20`, `settings-guards.ts:23` and `:66`, `judge-health.ts:73`,
  `judge-flags.ts:3`, `auto-approval/flags.ts:7`, `config/flags.ts:21`,
  `business-detail-types.ts:206`, `mappers.ts:184`, `console.css:1267`. A plan
  describes the pre-state, so this is not really drift.
- **`TIER_CONFIG` mutated in a test.** `tier-config.test.ts:105` reassigns
  `TIER_CONFIG.copilot`/`.autopilot` and restores in `finally`. Correct as written,
  and it is the only honest way to pin price-independence, but it makes the exported
  map writable-by-convention; a future `Object.freeze` would break it.
- **Stale comment.** `worker/index.ts:603` still reads "Log per-flag status so
  operators can see at a glance what's enabled" above the try. Still true, just now
  describing a structured record rather than a prose line.
