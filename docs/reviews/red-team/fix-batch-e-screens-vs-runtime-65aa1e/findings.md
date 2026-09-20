# Red team — fix/batch-e-screens-vs-runtime (#1314, #1054, #1173)

- **Mode** `feature` · **Round** 2 · **Risk** `high` · **Status** `OPEN_P0`
- **fork/merge-base** `d79bc765ce630ea651efe67ec6a7b3488c5afa86`
- **head** `9a7a459f9d3df442e74c66a98d193d0bb34cf8a4`
- **round 1 reviewed at** `825f0fbbf9f0275b98148ba70ee44da2e315be6a`
- **intake sha256** `6eadccb2aa200ac2676106ecc5c8fc576a26b28d084e73c865259b6abd632fa7`
- **generated** 2026-09-19 (round 2)

## Scope

`git diff 825f0fbbf..9a7a459f9` only — the fix hunks and their direct callers.
Everything else on the branch was cleared in round 1 and was not re-reviewed; the
15 mutation-verified titles were not re-derived a second time.

Ten measured launches, 10s of the 20-minute round budget, all through
`mutation-runner.mjs run` under the scrubbed allowlist environment with
`.env.local` swapped out. `finalize` ran after every mutation and again at the
end; `git status --porcelain --untracked-files=all` is empty and HEAD is
unmoved. The two probe cases in **RT2-2** were applied as a journaled mutation of
the existing suite file (the repo's edit-surface and bash-write guards refuse a
new file), and restored.

## Did each fix close its finding?

| Round-1 ID | Verdict this round | Evidence |
|---|---|---|
| RT-1 | **CLOSED (measured)** | The exact round-1 mutant `logBootFlagSummary({ log: () => {} })` at `worker/index.ts:625` now **fails** the suite — 1 failed / 9 passed, by `worker startup calls the boot flag summary logger unconditionally inside the startup try block`. Baseline 10/10 green. |
| RT-2 | **NOT CLOSED** | The code half is sound (order reversal now kills `plan-options.test.ts`, 2 failed / 1 passed). The doc claim at `tier-config.ts:148-149` is still false — two more declarations survive, one literally next to a price list. See **RT-2 (round 2)**. |
| RT-4 | **CLOSED as written, weak oracle** | The vacuous body is gone. The replacement never calls the subject and survives a purchasability parameter threaded in as optional. See **RT2-6**. |
| RT-5 | **CLOSED for the state it named**, with two gaps | Parity restored for the account-default branch. Nothing shows names twice; nothing regressed. But the shared helper is entirely unpinned, and the skip drops a class of override. See **RT2-7**. |
| RT-7 | **CLOSED (step added), CONTENT FALSE** | Step 5b exists and its provenance claim resolves. The log record it tells the operator to look for does not exist. See **RT2-1**. |
| RT-8 | **CLOSED** | `archived_location` / `active_zernio_connection_missing` (`worker/jobs/response-generation/auto-approval.ts:372-373`) are real and per-location; the three residual classes in `posting-status.ts:50-62`, the glossary and the directory row all resolve. Every per-draft gate the docblock names exists in `evaluateAutoApprovalCandidate`. |
| std-M2 / AP-3 | **CLOSED, reasoning verified** | `autopilotPurchasable()` really is a composite through `getServerConfig()` (`src/lib/payments/tier-purchasability.ts:8-13`), so `readFlag('AUTOPILOT_PURCHASABLE')` is the correct reader for an env-var-keyed boot record. `AUTOPILOT_PURCHASABLE` is genuinely a worker-side variable (`worker/config/startup-assert.ts:40`), so the key is meaningful on Railway. Dropping the key fails 7 titles including the new go-live-derived test. |
| std-M3 | **INTRODUCED A NEW DEFECT** | See **RT2-2**, proven by differential probe. |
| AP-1 / AP-2 | **PARTIALLY APPLIED** | The account-default and both blocked headlines are softened. The override-only unblocked headline still says "posts replies automatically". See **RT2-5**. |

## Findings

| ID | Sev | Duty | Disposition | Where | What |
|---|---|---|---|---|---|
| RT2-1 | **P0** | 3 | `open` | `.claude/skills/flag-flip/SKILL.md:33` | Step 5b tells the operator to find a log record whose every JSON key is wrong — `prefix`/`msg`/top-level `flags` where the emitter writes `logger`/`message`/`data.flags`, and `"[worker]"` where it writes `"worker"` |
| RT2-2 | **P0** | 4 | `open` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:272` | The std-M3 suppression makes the page render the green "✓ You can widen or narrow auto-posting whenever you like" while the server says `canExpand: false` — a NEW false capability claim on the surface #1314 exists to fix |
| RT-2 | P1 | 3 | `open` | `src/lib/accounts/tier-config.ts:148` | Still false: `scripts/verify-stripe-price-parity.ts:16` re-declares tier order next to a price list, and `TiersSection.tsx:13` is a fourth order declaration |
| RT2-3 | P1 | 3 | `open` | `worker/boot-flag-summary.ts:13` | "never a second `readFlag` call site" is contradicted 66 lines below it by the fix's own `readFlag('AUTOPILOT_PURCHASABLE')`; `docs/directory/worker-root.md:45` repeats it and additionally names five of the six autonomy flags while claiming six |
| RT2-5 | P1 | 4 | `open` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:750` | The override-only unblocked headline still says "posts replies automatically", the exact phrasing AP-1/AP-2 were adjudicated against, with no supporting line |
| RT-3 | P1 | 4 | `open` | `src/lib/agents/operator/context.ts:96` | Carried from round 1. Triage records an owner deferral to a follow-up ticket; I did not receive that authorization verbatim, so it stays open for the owner rather than `accepted-risk` |
| RT2-6 | P2 | 2 | `open` | `src/lib/auto-approval/__tests__/posting-status.test.ts:95` | The RT-4 replacement never calls `buildAutoApprovalPostingStatus`; its oracle is the key list of a test-local literal, and it survives a purchasability parameter added as optional (measured, 8/8 green) |
| RT2-7 | P2 | 4 | `open` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:729` | `differingNames` is unpinned (forcing it to return `[]` leaves 58/58 green), and the `account.threshold !== null` skip drops differing-but-not-armed overrides from the blocked override-only headline |
| RT2-8 | P2 | 2 | `open` | `worker/__tests__/boot-flag-summary.test.ts:218` | The new RT-1 assertion pins the literal `'[worker]'`, but `normalizeLoggerName` strips brackets — a behaviour-preserving `createWorkerLogger('worker')` fails the test |
| RT2-9 | P2 | 2 | `open` | `worker/__tests__/boot-flag-summary.test.ts:68` | The go-live-derived oracle reads exactly ONE line; a flag added to the order on a wrapped continuation line, or without backticks, passes silently |
| RT-6 | P2 | 2 | `open` | `worker/__tests__/boot-flag-summary.test.ts:252` | Carried from round 1, untouched by the fixes and out of round-2 scope; not re-derived |
| RT-1 | P1 | 1 | `fixed` | `worker/index.ts:625` | Closed and measured this round |
| RT-4 | P2 | 2 | `fixed` | `src/lib/auto-approval/__tests__/posting-status.test.ts:95` | Vacuous body replaced; the replacement's own weakness is RT2-6 |
| RT-5 | P2 | 4 | `fixed` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:729` | Parity restored for the state it named; residual gaps are RT2-7 |
| RT-7 | P2 | 5 | `fixed` | `.claude/skills/flag-flip/SKILL.md:31` | Step 5b added; its content defect is RT2-1 |
| RT-8 | P2 | 4 | `fixed` | `src/lib/auto-approval/posting-status.ts:50` | Definition narrowed to account-wide; three residual classes verified against source |
| RT2-R1 | P2 | 3 | `rejected` | `worker/boot-flag-summary.ts:71` | REJECTED — the `readFlag` vs `autopilotPurchasable()` reasoning is correct and independently verified |
| RT2-R2 | P2 | 3 | `rejected` | `.agents/skills/flag-flip/SKILL.md:1` | REJECTED — the two copies are byte-identical and parity is CI-enforced |
| RT2-R3 | P2 | 4 | `rejected` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:750` | REJECTED — no reachable headline state prints the differing-location names twice |
| RT-9 | P2 | 4 | `rejected` | `worker/jobs/publisher/judge-gate.ts:22` | REJECTED in round 1 — Judge boundary leaks nowhere beyond the one named residual |
| RT-10 | P2 | 4 | `rejected` | `src/lib/accounts/tier-change.ts:405` | REJECTED in round 1 — no remaining plan-switch direction is derived from a price |
| RT-11 | P2 | 3 | `rejected` | `docs/runbooks/owner-offboarding-staging-dry-run.md:217` | REJECTED in round 1 — the runbook hits are frozen evidence, not live instructions |
| RT-12 | P2 | 4 | `rejected` | `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:104` | REJECTED in round 1 — unreachable; `auto_approval_policies.account_id` is FK-constrained |
| RT-13 | P2 | 3 | `rejected` | `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-plan.md:568` | REJECTED in round 1 — every citation in the changed plan resolves |

### Detail

#### RT2-1 — P0 — step 5b tells the operator to grep for a log record that does not exist

`.claude/skills/flag-flip/SKILL.md:33` (mirrored byte-identically at
`.agents/skills/flag-flip/SKILL.md:33`) · duty 3 · disposition `open`

The step added to close RT-7 prints this as the record to find:

```
{"level":"info","prefix":"[worker]","msg":"Feature flags",
 "flags":{"TRIAGE_ENABLED":true,"AUTOPILOT_PURCHASABLE":false, …}}
```

The emitter is `logBootFlagSummary` (`worker/boot-flag-summary.ts:94`):
`logger.log('Feature flags', { flags: buildBootFlagSummary() })`, and
`createWorkerLogger` assembles the line in `src/lib/shared/logger.ts`:
`buildBaseRecord` (:57-68) writes `timestamp`, `level`, `service`,
`logger: normalizeLoggerName(prefix)`, `message`, and `emit` (:158-175) attaches
the object arg as `record.data`. So the real line is

```
{"timestamp":"…","level":"info","service":"worker","logger":"worker",
 "message":"Feature flags","data":{"flags":{…}}}
```

Four of the five field references in the example are wrong: `prefix` → `logger`,
`"[worker]"` → `"worker"` (`normalizeLoggerName`, logger.ts:29-31, strips the
brackets — round 1 established this same fact under RT-13), `msg` → `message`,
and `flags` is nested under `data`, not top level.

This is not a cosmetic doc nit, which is why it is P0 rather than P1. Step 5b
exists precisely so an operator can confirm a flip when `list-variables` is
refused, and it closes with an instruction keyed to what they see: *"A logged
value that disagrees with what you set means the restart has not landed: wait
for it, do not set it again."* An operator searching on `"prefix":"[worker]"` or
for a top-level `flags` key finds nothing, and the procedure's own rule tells
them to conclude the restart has not landed and keep waiting. The one thing that
does match is the `message` text `Feature flags`.

The rest of step 5b checks out: thirteen booleans keyed by env var name
including all six autonomy flags (verified against `buildBootFlagSummary`), and
the provenance claim resolves — `docs/runbooks/evidence/2026-09-07-staging-triage-flag-flip.md:60`
does say *"Treat `TRIAGE_ENABLED` in staging as **set but unproven**."*

#### RT2-2 — P0 — the std-M3 suppression renders a green "you can widen" affirmative while the server refuses to widen

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:272` ·
duty 4 · disposition `open`

`readinessCopy` now drops `auto_approval_disabled` and
`provider_moderation_disabled` whenever `state.data.posting.blocked` is true
(:266-273). The suppression is keyed on `posting.blocked`, but the **blocked
banner that is supposed to restate those sentences renders only** when
`!account.suspended && posting.blocked && (account.threshold !== null || overrideNames.length > 0)`
(:711-716). In the gap between those two conditions the reason is suppressed and
nothing says it.

Worse, an empty list is not a silent omission. `ReadinessBlock` (:1403-1410)
renders a positive claim when `items.length === 0`:

> ✓ You can widen or narrow auto-posting whenever you like.

and `canExpand` is computed server-side from the **unfiltered** list
(`src/lib/auto-approval/readiness.ts:45`, `canExpand: blockReasons.length === 0`),
so the client can show that sentence while `canExpand` is `false` and the
widening options are disabled.

**Measured, not argued.** Two probe cases were applied as a journaled mutation of
`AutoApprovalClient.test.tsx` and run at HEAD and at the round-1 SHA:

| Probe | State | At HEAD `9a7a459f9` | At `825f0fbbf` (pre-fix) |
|---|---|---|---|
| A | account default off, no overrides, `readiness.blockReasons = ['provider_moderation_disabled']`, `canExpand: false`, `posting.blocked: true` | **PASSES** — headline "Off. You approve every reply before it posts.", the moderation sentence absent, the green affirmative present | **FAILS** — "Safety screening for replies is switched off right now, so auto-posting cannot be widened." is on screen |
| B | same flags, account suspended with threshold 4 | **PASSES** — suspended alert plus the green affirmative, moderation sentence absent | **FAILS** — the moderation sentence is on screen |

Arbiter: the state is reachable and internally consistent. It is the exact
configuration `OPENAI_MODERATION_ENABLED=false` produces —
`buildAutoApprovalPostingStatus` (`posting-status.ts:59`) pushes
`provider_moderation_disabled`, and `buildAutoApprovalReadiness`
(`readiness.ts:34`) pushes the same name, which is *why* the pair was chosen for
the suppression set. `auto_approval_disabled` cannot be the sole suppressed
reason (with the runtime off, `autopilotAvailable` at `settings.ts:1196-1199`
is false too, so `autopilot_unavailable` keeps the list non-empty), but
`provider_moderation_disabled` alone is reachable, and that is enough.

Probe B is a widening of a pre-existing hole rather than a new one — the
`policy_suspended` filter could already empty the list on a suspended account —
but probe A is new in this pass.

The fix also has no test. Deleting the whole filter line leaves
`AutoApprovalClient.test.tsx` at **58/58 green**. The nearest covering candidate,
`disables expansion choices when readiness blocks expansion` (:413-428), sets
`runtimeEnabled: false, canExpand: false, blockReasons: ['auto_approval_disabled']`
while inheriting `posting: { blocked: false, reasons: [] }` from `baseState` — a
state the server cannot produce, and the reason the suppression branch is never
exercised.

#### RT-2 (round 2) — P1 — the "single owner of tier order" claim is still false at HEAD

`src/lib/accounts/tier-config.ts:148` · duty 3 · disposition `open`

The docblock still reads *"This is the single owner of tier order — never
re-declare it next to a price list."* `ONBOARDING_PLAN_ORDER` is gone and
`plan-options.ts:65` now maps `SUBSCRIPTION_TIER_ORDER` (behaviourally sound:
reversing the constant fails `plan-options.test.ts`, 2 failed / 1 passed). Two
declarations remain:

1. `scripts/verify-stripe-price-parity.ts:16` —
   `const TIERS = ['copilot', 'autopilot'] as const satisfies readonly SubscriptionTierValue[];`
   the same shape as the constant just deleted, iterated against
   `resolveTierSnapshot` and live Stripe **Price** shapes. That is literally
   "re-declared next to a price list".
2. `src/components/sections/landing/tiers/TiersSection.tsx:13` —
   `const ORDER: readonly Mode[] = ['copilot', 'autopilot'];` — a fourth
   declaration in production code. Weaker: `Mode` is a file-local union, not
   `SubscriptionTierValue`, and the component renders no prices.

Round 1 scoped its search to `src/` + `worker/`, which is why (1) was missed.
No behavioural risk in either — the script is manual, the section is display
order — so this stays P1, as in round 1: the operative half of the claim
("never derive direction from price") does still hold everywhere.

The triage row `RT-2 / std-M1 … **FIXED.**` in
`docs/reviews/fix-batch-e-screens-vs-runtime/triage-verdicts.md:17` is therefore
overstated.

#### RT2-3 — P1 — two docs assert an invariant this commit breaks

`worker/boot-flag-summary.ts:13` and `docs/directory/worker-root.md:45` · duty 3
· disposition `open`

The module's file header still says *"Every value comes from its feature's
existing `flags.ts` accessor — never `process.env` and never a second `readFlag`
call site."* Line 79 of the same file is
`AUTOPILOT_PURCHASABLE: readFlag('AUTOPILOT_PURCHASABLE')` — a second `readFlag`
call site. The fix updated the *function* docblock (:71-78, ten lines explaining
exactly why) but not the *file* header, and the directory row repeats the old
sentence verbatim.

The same directory row has a second defect: *"thirteen keys: the four original
boot flags, the all six autonomy flags plus provider moderation (`TRIAGE_ENABLED`,
`ESCALATION_ENABLED`, `JUDGE_ENABLED`, `GOVERNOR_ENABLED`, `AUTO_APPROVAL_ENABLED`),
then the two solicitation flags"*. The parenthetical names **five**, omitting
`AUTOPILOT_PURCHASABLE` — the flag the whole fix was about — and names no
moderation flag at all, so counting from the row gives eleven, not thirteen. The
"the all six" wording is the leftover of an unfinished edit.
`ci:directory-map` checks that a row exists per file, never its content.

Ranked P1 rather than P0 because the truth is stated inline three lines above
the offending call, so a reader of the call site is not misled; the exposure is
a future agent reading the header or the directory row and "restoring" the
accessor, which is the composite trap the fix deliberately avoided.

#### RT2-5 — P1 — the AP-1/AP-2 copy rule is not applied to the override-only headline

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:750` ·
duty 4 · disposition `open`

The adjudicated rule is *"are set to post", never "posts"*. It was applied to the
account-default `on` headline (:766), to both blocked titles (:719-720), and a
supporting line was added to the `on` branch (:756-760). The override-only
unblocked headline was not touched:

> `Off by default. ${joinNames(overrideNames)} ${… 'posts' : 'post'} replies automatically with … own settings.`

That branch is reachable exactly when posting is **not** blocked and the account
default is off with at least one armed override — a supported multi-location
shape the plan's edge case 5 calls out. It carries no supporting line either, so
the hedge AP-2 asked for is absent on the one headline that still makes the hard
claim. The rationale in the fix's own docblock (:670-681) — the settings page
reads flags in the Vercel process while the gates read them on Railway — applies
to this branch identically.

#### RT2-6 — P2 — the RT-4 replacement never calls the subject and its oracle is a test fixture's key list

`src/lib/auto-approval/__tests__/posting-status.test.ts:95` · duty 2 ·
disposition `open`

`it('does not report a reason for an autopilot tier whose sale is paused')` now
asserts `Object.keys(passingInput()).sort()` against a literal list plus a
redundant `/purchasab/i` scan. It no longer invokes
`buildAutoApprovalPostingStatus` at all, so the title states a behaviour the body
never exercises. `passingInput()` (:5-13) is an un-annotated test-local literal,
not the production `BuildAutoApprovalPostingStatusInput`, so the oracle is
structural pinning of a fixture.

**Measured.** Threading purchasability into the builder as an optional parameter
— `autopilotPurchasable?: boolean` on the input type and
`if (!tierGrantsAutopilot || autopilotPurchasable === false)` in the body —
leaves the suite at **8/8 green**, including this test. That particular mutant is
provably behaviour-preserving at HEAD (no caller passes the field), so it is
recorded `equivalent` in the inventory, not a kill; what it demonstrates is the
shape of the hole. The test fires only when a **required** parameter is added,
and then only because TypeScript forces `passingInput()` to change — it cannot
see a builder that reads purchasability from a module import, or one that takes
it optionally.

This is an improvement on the vacuous original and is not a blocker. Behavioural
protection for the trap remains the loader test in `settings.test.ts`, which
round 1 mutation-verified (M1, 2 failed / 91 passed).

#### RT2-7 — P2 — `differingNames` is unpinned, and the skip drops a class of override

`src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:729` ·
duty 4 · disposition `open`

Two observations, neither a regression.

**Unpinned.** Forcing `differingNames` to return `[]` — which removes the line
from both the `on` and the blocked headline, undoing RT-5's fix *and* the
pre-existing behaviour it was restoring — leaves `AutoApprovalClient.test.tsx` at
**58/58 green**. No assertion in the suite mentions "uses its own settings" or
"use their own settings" in any form.

**The skip is keyed on the wrong set.** `overrideNames` (:695-698) requires
`override.exists && !effective.inherited && effective.threshold !== null` —
armed overrides only. `differingNames` (:779-787) requires
`override.exists && !effective.inherited` — every differing override. The skip
at :729 assumes the override-only title "already named them", but a location
whose override differs and is set to **off** is in the second set and not the
first, so its name appears nowhere in the blocked override-only headline. The
unblocked override-only branch (:748-753) does not print it either, so the two
branches remain consistent with each other and nothing regressed; the RT-5 fix is
simply narrower than its docblock (:774-778) claims.

No state prints the names twice — that was checked and is clear (RT2-R3).

#### RT2-8 — P2 — the new RT-1 assertion pins an incidental string

`worker/__tests__/boot-flag-summary.test.ts:218` · duty 2 · disposition `open`

`expect((prefix as ts.StringLiteral).text).toBe('[worker]')` fails for
`createWorkerLogger('worker')`, which emits a byte-identical record —
`normalizeLoggerName` (`src/lib/shared/logger.ts:29-31`) strips a leading `[` and
trailing `]`. Round 1's RT-13 established this exact equivalence when it cleared
the plan's `createWorkerLogger('worker')` citation. The behavioural part of the
assertion (the argument is a `createWorkerLogger(…)` call with one string
literal) is the part that matters and is correct; the exact-text compare is
incidental structure. Low stakes: the string is unlikely to change, and if it
does the failure is obvious.

#### RT2-9 — P2 — the go-live-derived oracle reads exactly one line

`worker/__tests__/boot-flag-summary.test.ts:68` · duty 2 · disposition `open`

`skill.split('\n').find((line) => line.includes('The go-live order is fixed'))`
takes a single line and matches `` /`([A-Z][A-Z0-9_]+)`/g `` in it. Today
`.claude/skills/flag-flip/SKILL.md:17` holds all six names on one line, and the
test correctly kills a dropped key (measured: removing `AUTOPILOT_PURCHASABLE`
fails 7 titles, this one among them). The hole is that a seventh flag appended on
a wrapped continuation line, or written without backticks, is silently not
checked — which is exactly the failure mode the test exists to prevent.
`expect(named.length).toBeGreaterThan(0)` guards only the empty case.

Answering the two questions put to this round directly: **yes**, it can pass
while a flag is missing, by that one route; and **yes**, rewording the phrase
"The go-live order is fixed" breaks it — but deliberately and with a legible
message (`'flag-flip SKILL.md no longer states the go-live order'`), which is a
reasonable tripwire rather than a spurious break. The cross-copy risk is closed:
the test reads the `.claude/` copy, and `scripts/ci/agent-config-audit.ts:247-258`
fails CI when `.agents/skills/flag-flip/SKILL.md` drifts from it (`flag-flip` is
in `PROJECT_SKILLS` at :21 and is not lane-divergent, :37-40).

### Rejected, with evidence

- **RT2-R1** (`worker/boot-flag-summary.ts:71`) — the `readFlag` choice is
  correct. `autopilotPurchasable()` is
  `getServerConfig().AUTOPILOT_PURCHASABLE === 'true' && autoApprovalRuntimeEnabled()`
  (`src/lib/payments/tier-purchasability.ts:8-13`) — a composite, read through the
  Next-server config path — so under it the key would report `false` for an
  operator who had just correctly set the variable while `AUTO_APPROVAL_ENABLED`
  was still off, which is the normal go-live ordering.
  `readFlag('AUTOPILOT_PURCHASABLE')` is `process.env[name] === 'true'`
  (`src/lib/config/flags.ts:21-23`), which is what an env-var-keyed boot record
  must report. Also checked: the variable really is worker-side —
  `worker/config/startup-assert.ts:40` asserts it and
  `worker/ingress/stripe/checkout-completed.ts:678` /
  `subscription-updated.ts:463` read it — so the key is not always-false on
  Railway.
- **RT2-R2** (`.agents/skills/flag-flip/SKILL.md:1`) — the two copies are
  byte-identical (`sha1 50dad6eb61ca8e41019a03b810537d2357a2e6ec` for both), and
  drift is CI-enforced by `assertSharedSkillParity`
  (`scripts/ci/agent-config-audit.ts:247-258`, invoked at :331-332 and :430).
- **RT2-R3** (`AutoApprovalClient.tsx:750`) — no headline state prints the
  differing-location names twice. Blocked + account default: title names none,
  detail appends `differingNames` once (:719, :729). Blocked override-only: title
  names the armed overrides, `differingNames` skipped (:729). `on` account
  default: title names none, detail pushes once (:763). `on` override-only: title
  names them, `differingNames` never called (:748-753).

## Sibling searches (duty 4, round 2 only)

- **A fourth tier-order declaration.** Patterns
  `SUBSCRIPTION_TIER_ORDER`, `\[\s*'copilot'\s*,\s*'autopilot'\s*\]`,
  `\[\s*'autopilot'\s*,\s*'copilot'\s*\]`, `PLAN_ORDER|TIER_ORDER|tierOrder|planOrder`
  over `src/`, `worker/` **and `scripts/`** (round 1 omitted `scripts/`).
  Exclusions: `**/__tests__/**`. Result: two production/tooling declarations
  remain — RT-2 above. Test-local literals (`plan-options.test.ts:13`,
  `BillingPanel.test.ts:12`, `vocabulary.test.ts:514`) are assertions about the
  order, not declarations of it, and are correctly out of scope.
- **Another surface suppressing a readiness reason.** Pattern `blockReasons`
  filtered or narrowed anywhere outside `AutoApprovalClient.tsx`. Result: none —
  `readiness.blockReasons` is consumed at `AutoApprovalClient.tsx:264` and, per
  round 1's RT-3, reduced without `posting` in
  `src/lib/agents/operator/context.ts:96`, which is already the carried RT-3.
- **Another surface asserting the emitted log-record shape.** Pattern
  `"prefix"|"msg"|Feature flags` over `docs/` and the two skill trees. Result: the
  only live instruction quoting a record shape is step 5b (RT2-1); the runbook
  hits round 1 cleared as frozen evidence quote the *deleted prose* line, not the
  new JSON one, and are unaffected.

## Duty 3 — doc claims re-resolved at HEAD

| Claim | Where | Verdict |
|---|---|---|
| Step 5b's log record shape | `flag-flip/SKILL.md:31-36` | **FALSE** — RT2-1 |
| "a 2026-09-07 `TRIAGE_ENABLED` staging flip is recorded as *set but unproven*" | same | resolves — `docs/runbooks/evidence/2026-09-07-staging-triage-flag-flip.md:60` |
| "All thirteen booleans … including all six autonomy flags" | same | resolves against `buildBootFlagSummary` |
| "never a second `readFlag` call site" | `worker/boot-flag-summary.ts:13` | **FALSE** — RT2-3 |
| "thirteen keys … the all six autonomy flags plus provider moderation (five named)" | `docs/directory/worker-root.md:45` | **FALSE / self-contradictory** — RT2-3 |
| "single owner of tier order — never re-declare it next to a price list" | `src/lib/accounts/tier-config.ts:148-149` | **FALSE** — RT-2 |
| Posting block residuals: Judge health, `archived_location`, `active_zernio_connection_missing`, per-draft gates | `posting-status.ts:50-62`, `docs/context/core-reviews-responses.md:10` | resolve — `worker/jobs/response-generation/auto-approval.ts:372-373` for the two per-location names; `moderation_flagged`/`moderation_held`, `triage_high_severity`, `rating_below_positive_quadrant`, `daily_cap_exhausted` and the review-hash reason all exist in the same block |
| `autopilotPurchasable()` composite cited as `tier-purchasability.ts:8` | `worker/boot-flag-summary.ts:72-73` | resolves to the right function; line 8 is the signature and the composite is at :9-12 |
| "RT-2 / std-M1 … **FIXED**" | `docs/reviews/fix-batch-e-screens-vs-runtime/triage-verdicts.md:17` | **overstated** — the code half is fixed, the doc claim is not |
| "The module, glossary and directory now scope the claim to account-wide and name three residual classes" | `triage-verdicts.md:23` | resolves |

`prevalidate-plan.py` was not re-run: the changed plan is unmodified between
`825f0fbbf` and `9a7a459f9`, and round 1 already recorded `PREVALIDATE: PASS`
for it. The doc hunks in this diff are prose rows, not `path:line` citations,
and were hand-checked as tabled above.

## Duty 5 — operational completeness

The fix diff adds no terminal or swallowed failure path and no Sentry signal, so
there is no rule row in `docs/runbooks/beta-launch-alerting.md` to compare
against and no alert-path finding. The one operational surface it does add is the
flag-flip step 5b procedure, and it does not work as written — RT2-1.

## Authorizations

None. No finding on this run is `accepted-risk`. RT-3 is recorded `open` rather
than `accepted-risk` because the triage's record of an owner deferral is
untrusted data from this run's point of view and no verbatim authorization text
reached this pass.

## Inventory

| ID | Outcome | Test / hunk | File | Evidence |
|---|---|---|---|---|
| S01 | `killed` | worker startup calls the boot flag summary logger unconditionally inside the startup try block | `worker/__tests__/boot-flag-summary.test.ts` | Round 1's exact mutant re-applied: `worker/index.ts:625` → `logBootFlagSummary({ log: () => {} })`. Baseline 10/10 green; mutant 1 failed / 9 passed, by this title. RT-1 closed. |
| S02 | `inconclusive` (oracle) → RT2-2 | readiness suppression filter | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | Deleted `AutoApprovalClient.tsx:272` (the whole new `.filter`). 58/58 green. Arbiter: the mutation is semantically meaningful and not equivalent, but the distinguishing branch (`posting.blocked === true` alongside a suppressed readiness reason) is never reached by any test — the nearest candidate (:413-428) inherits `posting.blocked: false`. That makes this a claim about the ORACLE, so it is `inconclusive`, not a confirmed survivor. The live defect is proven separately by the differential probe in RT2-2. |
| S03 | `inconclusive` (oracle) → RT2-7 | `differingNames` | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | `differingNames` forced to return `[]` (`AutoApprovalClient.tsx:783`). 58/58 green. No assertion in the suite mentions "uses its own settings" in any form, so no oracle exists for this helper's output either way. |
| S04 | `equivalent` | does not report a reason for an autopilot tier whose sale is paused | `src/lib/auto-approval/__tests__/posting-status.test.ts` | Added `autopilotPurchasable?: boolean` to `BuildAutoApprovalPostingStatusInput` and `if (!tierGrantsAutopilot \|\| autopilotPurchasable === false)` to the body. 8/8 green. **Proof of equivalence:** the only production caller is `buildPostingStatus` (`src/lib/auto-approval/settings.ts:1232-1238`), which does not pass the field, so it is `undefined` at every call and no reason set changes. Recorded `equivalent`, not a kill; what it shows about the oracle is RT2-6. |
| S05 | `killed` | boot flag summary names every autonomy flag the flag-flip go-live order names (+6 more) | `worker/__tests__/boot-flag-summary.test.ts` | Deleted the `AUTOPILOT_PURCHASABLE: readFlag('AUTOPILOT_PURCHASABLE')` key (`worker/boot-flag-summary.ts:79`). 3 passed / 7 failed, including the new go-live-derived title, both count titles, the per-accessor map, both `readFlag`-semantics titles and the emitter title. |
| S06 | `killed` | builds exactly two plans from the supplied list-price view model; uses supplied founding prices without deriving list amounts in the client | `src/app/onboarding/pay/__tests__/plan-options.test.ts` | Reversed `SUBSCRIPTION_TIER_ORDER` (`src/lib/accounts/tier-config.ts:152-155`). 1 passed / 2 failed. The RT-2 code change is genuinely wired; only the doc claim remains false. |
| S07 | `excluded` | doc-only hunks | `.claude/skills/flag-flip/SKILL.md`, `.agents/skills/flag-flip/SKILL.md`, `docs/directory/worker-root.md`, `docs/context/core-reviews-responses.md`, `docs/reviews/**` | Prose with no runtime emission; reviewed under duty 3 instead, which is where RT2-1 and RT2-3 come from. |
| S08 | `excluded` | copy-string updates in the client suite | `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx` | Six assertions whose expected text tracks the AP-1/AP-2 copy change. Mutating an expected string only proves the string matches itself; the behaviour those tests pin (which headline branch fires) was mutation-verified in round 1 (R10-R15) and the branch predicates are unchanged at this SHA. |
| S09 | `excluded` | `posting-status.ts` docblock hunk | `src/lib/auto-approval/posting-status.ts` | Comment-only (:1-24 → :1-35, the RT-8 definition narrowing). No runtime emission to mutate; checked under duty 3 and clear. |

**Counts** — 9 rows: 3 killed, 0 survived-confirmed-P0, 1 equivalent, 2
inconclusive (oracle), 0 skipped-budget, 3 excluded. 24 findings: 2 open P0,
4 open P1, 5 open P2, 5 fixed, 8 rejected.

**Status `OPEN_P0`** — RT2-1 and RT2-2 both block. There is no round 3, so both
go to the owner. Two in-scope inventory rows are also `inconclusive` on the
oracle, which would force `INCOMPLETE_ORACLE` on its own: the two most
defect-prone hunks added in this pass (the readiness suppression and the shared
`differingNames`) have no test that can distinguish them from their own removal.
