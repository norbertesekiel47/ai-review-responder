# Spec & correctness review — `fix/1352-operator-posting-block-context`

Range: `cb90d3f5e..9bfc3491f` (40 files, +2964/−147).
Axis: does the code do what the locked contract says, and only that?
Read: intake JSON, plan rev 2 (both appendices), deviations D1–D9,
blast-radius.md, `docs/reviews/finding-checklists/spec-correctness.md`.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| high | `scripts/ws8-staging-smoke.ts:522` | ADR 0034 makes the documented staging gate scenario `12-expansion-denial-gate-closed` fail deterministically; the script, its docblock and the Phase D runbook all still assert the old behavior, and no deviation records it. |
| medium | `src/lib/admin/business-detail/mappers.ts:188` | Admin readiness still composes `tierGrantsAutopilot() && autopilotPurchasable()`, so the admin diagnostic reports `autopilot_unavailable` for a paused-sale Autopilot account the owner route now lets expand — contradicting ADR 0034's "means exactly one thing in both lanes". |
| medium | `docs/adr/0034-readiness-autopilot-entitlement-is-tier-only.md:133` | The ADR classifies the admin business-detail mapper among `autopilotPurchasable()` callers that are "all genuinely about buying". It is not — it is the second feed of `buildAutoApprovalReadiness`'s `autopilotAvailable`, the exact expression the ADR narrowed. |
| low | `docs/adr/0034-readiness-autopilot-entitlement-is-tier-only.md:126-130` | The ADR says the Posting block glossary sentence "is now false … it is outside this change's edit surface". That file is in `allowed_edit_surface` and *was* corrected on this branch, so the consequence bullet is self-contradicting and stale at birth. |
| low | `docs/superpowers/plans/fix-1352-operator-posting-block-context-intake.json:42` | `edge_cases[0]` cites `AutoApprovalClient.tsx:726` and `existing_patterns_to_follow[3]` cites `proposals.ts:368-400`; this branch's own edits moved both targets (rule now at `:705`, `CardFacts` now at `:383`). The checklist's most-repeated class. |

---

## F1 — ADR 0034 breaks staging smoke scenario 12 (high)

`scripts/ws8-staging-smoke.ts:486-533`, `scenarioExpansionDenialGateClosed`:

```
['expansion_blocked_error', thrown === 'AutoApprovalExpansionBlockedError'],
['autopilot_unavailable_reason', blockReasons?.includes('autopilot_unavailable') === true],
['no_policy_row_written', policies.length === 0],
```

It seeds `tier: 'autopilot', status: 'active'` with `AUTOPILOT_PURCHASABLE`
closed and drives `patchAutoApprovalSettings` with `threshold: 5`. Its own
docblock (`:481-484`) states the premise:

> Runs on an AUTOPILOT account so the only thing withholding
> `autopilot_unavailable` is AUTOPILOT_PURCHASABLE itself.

After this branch that premise is false by construction —
`settings.ts:1223` derives `autopilotAvailable` from `tierGrantsAutopilot`
alone, and an Autopilot account is entitled. `readiness.ts:40` therefore never
pushes `autopilot_unavailable`, so the `autopilot_unavailable_reason` check
fails whatever else happens. This is the same fact the branch's own new test
asserts (`settings.test.ts:592`, `an Autopilot account is expansion-ready while
AUTOPILOT_PURCHASABLE is false`).

Not speculative about the runtime flag either. The recorded evidence line
(`docs/runbooks/evidence/2026-07-22-agentic-staging-phase-d-evidence.md:42`)
shows this scenario last ran with
`blockReasons=[auto_approval_disabled|autopilot_unavailable|provider_moderation_not_validated]`,
so with the runtime flag off the error still throws — but without
`autopilot_unavailable`. With the runtime flag on, nothing throws and a policy
row is written, failing all three checks.

`docs/runbooks/agentic-staging-phase-d-purchasability.md:95` lists
`12-expansion-denial-gate-closed` in the ordered battery, immediately under a
**Stop rule: any `FAIL` line → stop the phase**. `staging_deploy` is one of this
intake's `required_approvals`, so this lands directly in the path the branch
must walk.

`scripts/ws8-staging-smoke.ts` appears in blast-radius.md line 90 as an importer
of `settings.ts`. The blast-radius sweep found it; the semantic check the
document itself asks for ("verify semantic impact per caller") was not done for
this caller. No deviation entry (D1–D9) mentions it, and the ADR's "cost, stated
plainly" section does not list it.

Fix is one of: update the scenario's checks and docblock to the ADR 0034
behavior (the scenario still has value — it can assert the *contraction* still
works and that a Copilot account is denied), or retire it and amend the runbook
battery. Either way it must be recorded, because the runbook's stop rule turns a
silent staleness into a blocked phase.

## F2 — the third readiness lane still folds in purchasability (medium)

`src/lib/admin/business-detail/mappers.ts:184-193`:

```ts
const readiness = buildAutoApprovalReadiness({
  runtimeEnabled,
  autopilotAvailable:
    tierGrantsAutopilot(accountRow?.subscription_tier)
    && autopilotPurchasable(),
  …
});
```

The reviewer's brief asks whether leaving this is inconsistent or correct
because it is a different fact. It is inconsistent, and the concrete scenario is
short:

- Autopilot account, `AUTOPILOT_PURCHASABLE=false`, everything else ready.
- `GET /api/settings/auto-approval` → `readiness.blockReasons: []`, owner widens
  the dial successfully. (This is the branch's stated `observability` signal.)
- `/admin/businesses/<id>` → readiness diagnostic shows
  `autopilot_unavailable`.

An admin asked "why can this owner not expand?" reads a reason that no longer
binds, on a page whose entire purpose is to explain the owner route's gate. That
is the #1352 defect class one layer over: two surfaces disagreeing about one
account's eligibility.

The file's own comment at `:182-184` documents one deliberate divergence
(`impersonated` is omitted because the diagnostic is observational, not a gate).
That reasoning does not extend to purchasability — omitting an *admin-session*
input is not the same as folding in a *sales* input the gate no longer reads.

I am **not** claiming this must be fixed in this branch. `mappers.ts` is outside
`allowed_edit_surface` and widening the surface a seventh time is worse than the
inconsistency. But the branch treats the divergence as closed (ADR §Decision:
"`autopilot_unavailable` now means exactly one thing in both lanes"; §Consequences:
"The two lanes agree about one word") when a third lane still disagrees. The
minimum is an ADR paragraph naming it and a follow-up ticket — which is exactly
the checklist's accepted remedy for `feat/1088-chart-readability` G5.

## F3 / F4 — two ADR 0034 statements that do not hold (medium / low)

**F3, `:131-134`.** "`autopilotPurchasable()` keeps its remaining callers, which
are all genuinely about buying: `/pricing`, the onboarding plan picker,
`/api/account/settings` plan presentation, `assertTierPurchasable`, and the
admin business-detail mapper." The first four are genuinely about buying; I
checked each (`src/app/(public)/pricing/page.tsx:19`,
`src/app/onboarding/pay/page.tsx:112`, `src/app/api/account/settings/route.ts:115`,
`src/lib/payments/tier-purchasability.ts:27`). The fifth is the readiness feed in
F2. Listing it as "about buying" is what allowed F2 to pass unremarked.

Two Stripe ingress callers (`worker/ingress/stripe/subscription-updated.ts:463`,
`worker/ingress/stripe/checkout-completed.ts:678`) are omitted from the list
entirely. Those two *are* genuinely about buying, so the omission is only an
incompleteness, not an error.

**F4, `:126-130`.** The ADR records as an open consequence that the Posting
block glossary entry "still says readiness 'folds in `autopilotPurchasable()`' …
That sentence is now false and needs the discriminator above; it is outside this
change's edit surface." Both halves are wrong:
`docs/context/core-reviews-responses.md` is `allowed_edit_surface` entry 102, and
line 10 of that file at HEAD already reads "…until **ADR 0034** made readiness'
`autopilot_unavailable` tier entitlement only; the discriminator is now
`provider_moderation_not_validated`." The work the bullet says is outstanding is
in the same commit range as the bullet. A later reader takes it as a live TODO.

---

## What I verified and found sound

### 1. The 24 `tests_to_add` titles — 24/24 present verbatim, 24/24 assert their claim

Every title was matched by fixed-string grep across `src`, `tests`, `worker`,
`scripts`, then each body read. No duplicates, no title on a body that tests
something else. Locations:

| title | file:line |
|---|---|
| snapshot carries the account Posting block… | `context.test.ts:331` |
| …preserve buildAutoApprovalPostingStatus order | `context.test.ts:338` |
| …never derived from readiness block reasons | `context.test.ts:354` |
| off by default with no armed override states off… | `context.test.ts:372` |
| blocked but unarmed … correctionOwed is false | `context.test.ts:383` |
| off-by-default … armed location override | `context.test.ts:399` |
| snapshot distinguishes all locations off from armed override outside | `context.test.ts:412` |
| buildOperatorPrompt receives every sentence in builder order | `context.test.ts:428` |
| system prompt tells the model to state the Posting block… | `prompt.test.ts:83` |
| system prompt says set to post and never posts… | `prompt.test.ts:102` |
| system prompt gates every mention on correctionOwed… | `prompt.test.ts:112` |
| policy proposal that arms auto-posting carries… | `proposals.test.ts:590` |
| policy proposal that turns auto-posting off carries none | `proposals.test.ts:612` |
| the card renders one owner sentence per reason | `ProposalCard.test.tsx:207` |
| the card still allows Apply while blocked | `ProposalCard.test.tsx:228` |
| every reason has exactly one owner sentence | `posting-block-copy.test.ts:6` |
| all five sentences byte-for-byte unchanged | `posting-block-copy.test.ts:18` |
| settings page and Proposal card render the same sentence | `AutoApprovalClient.test.tsx:419` |
| Autopilot expansion-ready while AUTOPILOT_PURCHASABLE false | `settings.test.ts:592` |
| Copilot still carries autopilot_unavailable | `settings.test.ts:621` |
| paused-sale Autopilot cannot expand when AUTO_APPROVAL_ENABLED false | `settings.test.ts:666` |
| readiness still carries auto_approval_disabled | `readiness.test.ts:44` |
| pending armed proposal in the transcript renders current sentences | `reads.integration.test.ts:639` |
| rereading adds and removes sentences as settings change | `reads.integration.test.ts:688` |

Two are worth calling out as *stronger* than their titles promise:

- `reads.integration.test.ts:639` asserts on the real `getConversationForOwner`
  result and then cross-checks `summary.pendingProposals` — it proves the
  transcript reader and the pending reader agree, which is exactly the hole D2
  was refuted on.
- `reads.integration.test.ts:688` reads the same row three times across a flag
  flip and separately asserts the stored `after` column did not move. That is a
  real discrimination between read-time and frozen-at-preparation, not a
  restatement.

The one soft spot: `prompt.test.ts:102` (`…when a Posting block is present`)
builds its prompt from the *unblocked* fixture snapshot. The rule it asserts is a
static prompt line so the assertion is correct, but the title's conditional
clause is not exercised. Non-blocking; listed in the appendix.

### 2. `correctionOwed` is the only suppression switch — confirmed

`src/lib/agents/operator/context.ts:221-237`. `blocked`, `reasons` and
`sentences` are computed unconditionally; `correctionOwed` is the only field
gated on the armed test. `sentences: postingBlockSentences(reasons)` is always
the full list.

The tests do not cheat by emptying the data. `context.test.ts:383` (`a blocked
but unarmed snapshot preserves every Posting block sentence while correctionOwed
is false`) runs the *same fixture* as `:372` and asserts
`reasons`, `sentences.length === reasons.length` and
`sentences === reasons.map(POSTING_BLOCK_COPY[...])` all survive while
`correctionOwed` is false. `:412` goes further and asserts the two snapshots
differ *only* in `correctionOwed`.

The prompt side matches: `prompt.ts:78-79` carry both directions ("when
correctionOwed is true … state each string verbatim" / "when false, say nothing
… even when snapshot.posting.blocked is true"), and `prompt.test.ts:112` asserts
*every* rule mentioning "Posting block" also mentions `correctionOwed`, plus that
none of them matches `/do not propose|withhold the proposal|refuse the
proposal|ask the owner to wait/i`. That last loop is the assertion that keeps
non_goal 4 ("the Operator does not refuse to prepare or Apply") honest at the
prompt layer.

`correctionOwed`'s predicate is byte-equivalent to the settings page:
`AutoApprovalClient.tsx:684-686` is the armed-override filter and `:705` is
`data.posting.blocked && (account.threshold !== null || overrideNames.length > 0)`.
Both cited line numbers resolve at HEAD in `context.ts:213-215` and in
`docs/directory/lib-owner-operator.md:25`.

### 3. The three-condition predicate and both routes — confirmed

`proposals.ts:393-395`:

```ts
const corrected = context.posting.blocked
  && context.status === PROPOSAL_STATUS.PENDING
  && storedAfter.threshold !== null;
```

Each condition is separately required and separately pinned:

- `blocked` → `proposals.test.ts:906-910` (unblocked account, same pending armed
  row, `[]`) — and it asserts `FROM accounts` *was* queried so the empty result
  is the predicate, not a missing read.
- `status === PENDING` → `proposals.test.ts:886-891` (APPLIED + armed + blocked
  → `[]`).
- `storedAfter.threshold !== null` → `proposals.test.ts:612` (`after` unarmed →
  `[]`, with the `FROM accounts` read asserted present).

Both routes carry the context. `cardFacts` (`:449-421`) takes `context` and
forwards it at `:462`; `restoreCardFacts` (`:477-495`) takes it and forwards at
`:493`. `withoutFriction` returns `postingBlockSentences: []` for voice, pinned
by `proposals.test.ts:894-904`. A restore that re-arms therefore carries the
line — the specific branch-divergence the reviewer flagged.

`policyCardFacts`'s `CardFacts` Pick at `:383-386` gained
`postingBlockSentences`, so a missing field is a compile error, not a silent
`undefined`.

### 4. `mapStoredRows` — confirmed

`proposals.ts:595-617`.

- Empty read issues no statement: `if (rows.length === 0) return [];` at `:599`,
  ahead of both `readRestoreSources` and `getAutoApprovalPostingStatus`. Pinned
  by `proposals.test.ts:913-918`, which asserts `sqlCalls` has length 1 (the
  proposal SELECT only).
- No `Promise` combinator: the two reads are plain sequential `await`s at `:604`
  and `:608`, with an explicit comment and a
  `react-doctor-disable-next-line react-doctor/server-sequential-independent-await`.
  I grepped the changed files for `Promise.all|Promise.allSettled|Promise.race|
  Promise.any` — no occurrences.
- Once per batch, never per row: `posting` is read outside `rows.map`. Pinned by
  `proposals.test.ts:857-861` asserting `sqlCalls.length === 2` with the
  `accounts` read carrying the account id.
- `getAutoApprovalPostingStatus` (`settings.ts:205-210`) is a single primary-key
  `SELECT … FROM accounts WHERE id = $1 LIMIT 1` via `loadSettingsAccount`, not
  the full settings response. Correct, and correctly tenant-keyed.

### 5. Invariants — all clear

- **#3** — nothing in the diff approves or posts. `postingBlockSentences` is a
  display projection; `ProposalCard.tsx:202-204` adds no `disabled` condition,
  pinned by `ProposalCard.test.tsx:228` which clicks Apply and asserts `onApply`
  fired. ADR 0034 widens who may *write settings*, not who may post — the
  publisher gates (`tierGrantsAutopilot`, judge, trust dial, veto window) are
  untouched and the ADR states the delta plainly at `:85-92`.
- **#1** (not on the list, but at risk here) — `proposals.ts` gained a *runtime*
  import of `@/lib/auto-approval/settings`, which transitively reaches
  `postgres`. Every client-side importer of `proposals.ts` is `import type`:
  `ProposalCard.tsx:4`, `RulesTimeline.tsx:4`, `useOperatorConversation.ts:7`,
  `useProposalWrites.ts:4`, `TurnBody.tsx:3`. Boundary intact.
- **#13** — no `NEXT_PUBLIC_*` anywhere in the diff.
- **#14** — the Operator reads `auto_approval_policies` only through
  `getAutoApprovalSettings` / `getAutoApprovalPostingStatus` on the server;
  `ProposalCard.tsx` receives finished strings.
- **#15** — no `@/lib/db/server` import anywhere under
  `src/lib/agents/operator/` (the four hits are header comments asserting the
  rule). `getAutoApprovalPostingStatus(db, accountId)` takes its executor
  explicitly, and `buildSnapshot` keeps its `db` parameter.
- **No review text / response text / reviewer name** — `SnapshotPosting` is
  `boolean | reason-code[] | string[] | boolean`; the `string[]` is
  `POSTING_BLOCK_COPY`, five constants. The type has no field those could
  occupy, which is how `docs/context/owner-operator.md:13` describes it.

### 6. `non_goals` — no code or doc claims otherwise

Judge **health**, `archived_location`, `active_zernio_connection_missing` and
every per-draft gate are named as residuals in the glossary
(`core-reviews-responses.md:10`) and nothing in the diff reads
`isJudgeHealthy` or the per-location gates. The prompt guards the inverse claim
too: `prompt.ts:80` ("A configured rule is a setting, not a guarantee: safety
checks and service availability still apply to every reply"), asserted by
`prompt.test.ts:102`. The settings-page non_goal holds: the only change to
`AutoApprovalClient.tsx` is deleting the local `POSTING_BLOCK_COPY` and
importing the shared one; `describePolicyStatus` is untouched.

### 7. D7 — the red-team pin refresh is sound

Verified mechanically, not taken on the deviation's word.

- Parsed `OPERATOR_FRONTEND_ASSERTION_SITES` at `cb90d3f5e` and at HEAD: 14
  records both sides, **identical order**, identical ids. Field-by-field diff:
  13 records differ, and the differing key set is exactly `{testSha256}` (4
  records) or `{line, testSha256}` (9 records). `mutantSha256`, `originalOid`,
  `target`, `test`, `file`, `sourceLine`, `family`, `header`, `messagePrefix`,
  `query`, `matcher`, `messageLines` are untouched on every record. `rt-0144`
  is unchanged, matching the deviation's "1 of 14 fresh".
- Recomputed the file hashes at HEAD:
  `OperatorClient.test.tsx` → `b52a6dfe…2fda1`,
  `RestoreWorkflow.test.tsx` → `c690e988…3595`,
  `completion-materialization.test.ts` → `d4517642…24b` — all three match their
  new pins exactly.
- Resolved all 14 `(file, line)` pairs against HEAD: every pinned `sourceLine`
  is byte-identical to the line now at that number. 14/14.

So the refresh moved position and file identity only, and the three-record copy
in `scripts/ci/__tests__/red-team-status.test.ts:1998/2058/2033` matches. The
residual risk the deviation names honestly — the mutants were not re-run — is
bounded by exactly this: assertion text unchanged, mutant unchanged, target file
unchanged (`useOperatorConversation.ts` `originalOid 93f076f8…` and
`ProposalCard.tsx` `originalOid b38870fb…` — note the latter *is* stale as a blob
oid since `ProposalCard.tsx` changed, see the appendix). I accept the refresh on
this axis.

---

## Weakened checks — mandatory sub-brief

I searched the diff for deleted assertions, narrowed tests, raised caps, relaxed
types, widened allowlists, removed guards and `toContain` replacing exact
matches. Six candidates; all six justified.

**1. `settings.test.ts:587` — `blocks expansion when the sale gate closes but
still allows contraction` rewritten to `an Autopilot account is expansion-ready
while AUTOPILOT_PURCHASABLE is false`.** *Justified.* The old test asserted
exactly the behavior ADR 0034 names as wrong. The rewrite is not a deletion: it
asserts the expansion now *succeeds* (`canExpand: true`, `blockReasons: []`,
`accountDefault.threshold === 4`, **and** `dbState.accountDefault` actually moved
— so it proves the write, which the old test never did). The branch also adds
two replacement guards on the paths that must still refuse: `:621` (Copilot,
asserting no row written and no audit) and `:666` (paused sale + runtime off,
driving a real write and asserting `auto_approval_disabled`, no
`INSERT INTO auto_approval_policies`, no audit). Net coverage is higher, not
lower.

**2. `settings.test.ts:970` — `blocks NULL-to-50 but allows NULL-to-1 …`
rewritten to `allows NULL-to-50 and NULL-to-1 …`.** *Justified*, same reason.
The two collateral changes read as relaxations but are not: `toHaveBeenCalledTimes(1)`
→ `(2)` is a consequence of the first patch now succeeding, and
`toHaveBeenCalledWith` → `toHaveBeenLastCalledWith` is *stricter* (it pins which
call carries the payload). The deviations note the blocked-expansion path is
still pinned by the suspended-policy twin; I confirmed that twin exists in the
same describe.

**3. `policy-apply.integration.test.ts:354` — `readinessBlockReasons:
['auto_approval_disabled', 'autopilot_unavailable']` → `['auto_approval_disabled']`.**
*Justified.* This is the frozen-at-preparation stamp; with `autopilotAvailable`
now tier-only and the fixture on Autopilot, `autopilot_unavailable` is genuinely
absent. The assertion stayed an exact `toMatchObject` array equality rather than
being loosened to `toContain`, which is the right call — a `toContain` here would
have hidden the very change.

**4. The `#1314 "THE TRAP"` guard re-keyed from `autopilotPurchasable` onto
`provider_moderation_not_validated` (`settings.test.ts:2569-2591`).**
*Justified, and the strongest version available.* The guard's job is to kill a
loader that forwards a readiness value into `tierGrantsAutopilot`. It needs an
input that is a readiness input and *not* a posting input. After ADR 0034,
`autopilot_unavailable` no longer is one (readiness and posting now agree about
the tier), so the old discriminator is genuinely dead — keeping it would have
produced a test that passes for the wrong reason. `providerModerationValidated`
is such an input (`readiness.ts` consumes it, `buildAutoApprovalPostingStatus`
has no such field), so the mutant still dies. The branch also keeps the old test
under a corrected title asserting both facts now agree, which documents the
change rather than hiding it. The narrow residual: a bug that specifically
forwarded `blockReasons.includes('autopilot_unavailable')` into
`tierGrantsAutopilot` is no longer caught — but after ADR 0034 that forwarding is
*behaviorally equivalent* to the correct code, so there is nothing left to catch.

**5. `docs/context/core-reviews-responses.md` and
`docs/directory/lib-reviews-responses.md` trimmed to fit the 3000-word cap
(2997 and 2999).** *Justified — compression only, no content lost.* I diffed the
bolded term/row keys before and after on both files: **identical sets**, zero
removals, one addition (`posting-block-copy.ts`). Spot-reading the reworded
bullets, the edits are grammatical compression ("a provider adapter that ingests
reviews and normalizes them" → "ingesting … and normalizing them"), not claim
deletion. `ci:directory-map` completeness holds: the new module has its row at
`lib-reviews-responses.md:37`.

**6. `apply.test.ts:69-72` — `getAutoApprovalPostingStatus` added to an existing
whole-module `vi.mock` as a non-recording stub.** *Justified and correctly
reasoned.* The suite makes positional `sqlCalls[n]` assertions; a stub that
issued a query would shift every index and silently rewrite what those
assertions mean. The stub returns `{ blocked: false, reasons: [] }`, which is
the neutral value for a suite that asserts nothing about posting sentences. The
module was already fully mocked, so this widens no surface.

No raised caps, no relaxed types (`POSTING_BLOCK_COPY` went from
`Record<Reason, string>` to a `readonly` mapped type — *stricter*), no widened
allowlists, no removed guards, no `toContain` substituted for an exact match.

---

## Low-confidence appendix (not in the table)

- **`prompt.test.ts:102` title over-promises its fixture.** `system prompt says
  set to post and never posts *when a Posting block is present*` builds from the
  unblocked `snapshot` (`posting: { blocked: false, … }`). The rule is a static
  prompt bullet so the assertion is sound, but nothing in the case involves a
  block. Retitling to what it proves would match the checklist's
  `feat/1087` precedent; leaving it is defensible.
- **`ProposalCard.test.tsx:207` does not count `<li>` elements** despite the
  comment "One `<li>` per reason". It asserts both sentences render and no reason
  *code* leaks. Duplicates would still fail (`getByText` throws on multiple
  matches), so the gap is narrow.
- **`listAppliedProposals` pays for an `accounts` read twice per page**
  (`proposals.ts:710` and `:718`), and the first of those reads is provably
  wasted: that page is `status = APPLIED` only, so `policyCardFacts` can never
  produce a sentence from it. Correct, just not free. Architecture/async axis.
- **`lockProposalForAccount` (`proposals.ts:820-830`) now issues an extra round
  trip while holding `FOR UPDATE`** on `agent_proposals`. A shared read of
  `accounts` cannot deadlock against it, but the lock is held marginally longer.
  Async axis.
- **`rt-0039` and `rt-0041` still carry `originalOid b38870fbe…` for
  `ProposalCard.tsx`, which this branch changed** (now `b110064bb`). D7 says
  "`originalOid` … untouched", which is true of the refresh but means those two
  records now pin a blob that is no longer at that path. Whether
  `mutation-runner.mjs` validates `originalOid` against HEAD is a red-team-axis
  question, not mine — flagging it because D7 explicitly invites the challenge and
  frames `originalOid` stability as evidence of soundness when for these two it
  is evidence of the opposite.
- **A `set_account_veto_window` proposal on an already-armed blocked account will
  carry the Posting block sentences**, because condition (3) tests the stored
  `after` threshold, not "does this operation arm posting". I read this as
  correct (the card states a posting configuration that will not happen) and the
  `user_visible_behavior[2]` wording "a policy operation that arms auto-posting"
  as loose rather than exclusive, but a reviewer could read it the other way.

---

## Verdict on the axis

The contract is implemented field by field and the test surface genuinely pins
it. `correctionOwed`, the three-condition predicate, both `policyCardFacts`
routes, the empty-read discipline, every invariant and every `non_goal` check
out. The defects are all on the ADR 0034 half's *blast radius* rather than on the
#1352 fix: one operational script that will fail on the staging deploy this
branch requires, one third readiness lane the ADR asserts does not exist, and two
ADR statements that do not survive a read of the tree they describe.
