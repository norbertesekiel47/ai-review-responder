# Red team — fix/1352-operator-posting-block-context

| | |
|---|---|
| Mode | feature (**round 2**) |
| Risk | high |
| Fork / merge-base | `cb90d3f5ee1ae7b827da5446792f344703af3d5e` |
| Round-1 HEAD (superseded) | `9bfc3491f49464e5c804274dbc2b086116222821` |
| HEAD | `188b31dd3d68ccfc132ccaef0ce3d1093e738f1b` |
| Intake SHA-256 | `f01c796c90d76796b6992afd6e0b507e97dda033e974ddd8c63a2791f7b12d5d` |
| Generated | 2026-09-21T07:20Z |
| Status | **OPEN_P1** |
| Budget spent | ~25 s of 1200 s, 13 of 400 launches, 12 journaled mutations (all restored) |

> **This file replaces round 1's report in place.** Round 1's findings are preserved
> below with an explicit round-2 disposition each. The round-1 sidecar was stale by
> construction — its `head_sha` named a commit the fixes moved past — so every number
> here was re-measured at `188b31dd`.

**Scope.** `git diff 9bfc3491f..HEAD` and its direct callers only, per the round-2
charter. Unchanged code that round 1 already covered was not re-opened.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| P1 | `docs/directory/lib-owner-operator.md:30` | The `proposals.ts` row was missed by the doc sweep: it still presents "never for an empty read" as the only case where the Posting-block read is skipped (FIX 3 added a second), and never mentions `postingBlockNowSentences`. |
| P1 | `src/lib/agents/operator/prompt.ts:88` | Rule 2 was narrowed to permit answering a direct question while `correctionOwed` is false; rule 5's "and only when `correctionOwed` is true" was not, so the two rules contradict each other for a suspended account asked directly. |

No P0. Round 1's P0 is closed and re-measured.

---

## Round-1 findings — disposition

| id | sev | round-2 disposition | how it was re-verified |
|---|---|---|---|
| RT-01 | P0 | **fixed** | The identical `> 0` -> `> 1` mutation was re-run. It now **kills**. |
| RT-02 | P1 | **fixed** | The identical context-neutering mutation was re-run. It now **kills**. |
| RT-03 | P1 | **fixed** | Row rewritten; re-resolved clause by clause against `prompt.ts` at HEAD. |
| RT-04 | P1 | **fixed** | The replacement fixture's combination was **proven reachable** at HEAD. |
| RT-05 | P2 | **fixed** | Absence proxy replaced by an ordered exact-list equality plus an all-five-reason loop. |

### RT-01 (P0) — closed, and the same shape did not reappear on the new field

`ProposalCard.test.tsx:246` now carries, inside the n = 1 test:

```tsx
expect(screen.getByText(POSTING_BLOCK_COPY.judge_disabled)).toBeInTheDocument();
```

Round 1's exact mutation re-applied at HEAD (`ProposalCard.tsx:218`, `length > 0` ->
`length > 1`, inventory `RT2-M01`) now **fails** the test:

```
TestingLibraryElementError: Unable to find an element with the text:
Our reply review step is switched off right now, and nothing posts without it.
```

The fix also introduced a **second** gate of the identical shape at line 229
(`postingBlockNow.length > 0`). It was mutated the same way (`RT2-M02`) and also
**killed** — `Unable to find an element with the text: /This rule is saved, but your
account is not set up to post replies automatically right now/`. The defect was not
re-created one field over.

### RT-02 (P1) — closed, and the new test proves it is really the restore branch

`proposals.test.ts:747` seeds an applied source row that was **armed -> off**, so
restoring it re-arms auto-posting, and reads it back through a pending restore row.
Before asserting the sentences it proves the route:

```ts
expect(view!.describe).toMatch(/^Restore: Account default now/);
expect(view!.restoreSourceProposalId).toBe(RESTORE_SOURCE);
```

Without those two lines the test could pass through the ordinary `cardFacts` branch.
Round 1's mutation (`restoreCardFacts` -> `{ ...context, posting: { blocked: false,
reasons: [] } }`, `RT2-M03`) now **fails** at `proposals.test.ts:765`
(`expected [] to deeply equal [ Array(1) ]`). A mocked suite is the right oracle
here: the branch is a pure argument-threading decision, not a DB behaviour.

### RT-03 (P1) — closed; the row no longer makes a countable or universal claim

The rewritten row separates the two families and matches HEAD exactly:

| row clause | prompt.ts at HEAD |
|---|---|
| true => say not set up + sentences verbatim | `:84` OK |
| false => volunteer nothing, but a direct question may be answered | `:85` OK |
| never withholds a proposal | `:87` OK |
| suspension first, neither replacing the other | `:88` OK |
| "an always-on wording rule ... gated on nothing" | `:86` — contains neither `Posting block` nor `correctionOwed` OK |

It also replaced the literal `2026-09-20.1` with the constant **name**, removing a
second staleness trap of the same family. `prevalidate-plan.py`: **PASS**, 1 citation
checked, 0 unresolved.

### RT-04 (P1) — closed, and the replacement is reachable, not merely plausible

The re-keyed fixture pins `readiness.blockReasons: ['provider_moderation_not_validated']`
beside `posting: { blocked: false, reasons: [] }`. Round 2 did not take reachability on
trust:

| side | input | source |
|---|---|---|
| readiness reason | `providerModerationValidated` | `readFlag('AUTO_APPROVAL_PROVIDER_MODERATION_READY')` — `flags.ts:15-17`, `readiness.ts:42` |
| posting reason | `providerModerationEnabled` | `readFlag('OPENAI_MODERATION_ENABLED')` — `flags.ts:11-13`, `posting-status.ts:62` |

Two **independent** env flags. `OPENAI_MODERATION_ENABLED=true` with
`AUTO_APPROVAL_PROVIDER_MODERATION_READY=false` on an otherwise-clean Autopilot
account produces exactly this pair, and no arm of `buildAutoApprovalPostingStatus` is
forced by it — unlike the deleted `autopilot_unavailable` fixture, where
`!tierGrantsAutopilot` forced `autopilot_tier_required` and `blocked: true`.
**The combination is reachable; RT-04's replacement models a real account.**

### RT-05 (P2) — closed with the named behavioural replacement

The document-wide `.op-readiness li` selector now also spans the readiness list and
the new `postingBlockNow` list. That coupling can only make the assertion fail more
loudly; it cannot make it pass vacuously. Not a new fragility.

---

## New round-2 findings

### RT-06 (P1) — the directory row for `proposals.ts` was not swept

`docs/directory/lib-owner-operator.md:30`:

> *"`mapStoredRows` is the ONE place all seven reads converge, so it reads the
> account-wide **Posting block** there — once per batch via
> `getAutoApprovalPostingStatus`, sequentially (one pooled connection, no `Promise`
> combinator), and **never for an empty read**."*

That trailing clause is offered as the **sole** exception, and at the round-1 HEAD it
was. FIX 3 (`proposals.ts:641-650`) added a second: a **non-empty** batch in which no
row is `PENDING` or `APPLIED` issues no `FROM accounts` statement either, and every
row in it is built from the neutral `{ blocked: false, reasons: [] }`. Inventory row
`RT2-M09` measures precisely that skip — forcing `usable = true` makes
`a batch no row could use issues no Posting block read at all` fail on
`sqlCalls` length 2. A reader of this row concludes every non-empty batch issues the
account read. At HEAD that is false.

Separately, the row is the **code map** for this file and never mentions
`postingBlockNowSentences` — a new public field on `ProposalView` with its own
three-condition predicate, its own mutual-exclusivity contract, and the
optional-on-view / required-on-`CardFacts` asymmetry, all of which this row's existing
sentences spell out for the sibling field.

`ci:directory-map` cannot catch either: it audits row **existence** per production
file, and `proposals.ts` still has a row. The same wave rewrote the `prompt.ts` row
six lines above (RT-03) and the `context.ts` docblock, so this is a missed file inside
a sweep that was performed.

**Not P0.** The skip is behaviour-preserving — see `RT2-M07`'s proof that a neutral
status and a genuinely unblocked account both yield `[]` — so the false clause
misleads about mechanism, not about anything an owner sees.

### RT-07 (P1) — rule 2 was narrowed, rule 5 was not

`prompt.ts:85`, rewritten by this fix:

> *"When `snapshot.posting.correctionOwed` is false, never volunteer a Posting block ...
> **If the owner asks directly** whether anything is stopping replies from posting
> automatically, or asks what a proposed change would do, **you may answer from
> `snapshot.posting.sentences`**, stating each string you use verbatim and adding
> nothing."*

`prompt.ts:88`, **untouched** by this fix:

> *"When the account default is suspended, state the suspension first. Then, **and
> only when `snapshot.posting.correctionOwed` is true**, state each Posting block
> sentence once."*

"Only when X" is an exclusivity claim over the very act rule 2 now permits when X is
false. For a **suspended** account with `correctionOwed = false` whose owner asks
directly, rule 2 says the model may state the sentences and rule 5 says it may not.

The branch's own test encodes the un-narrowed form — `prompt.test.ts` asserts that
every rule containing `Posting block` also contains `correctionOwed`, which rule 5
satisfies in exactly the shape that conflicts — so the suite cannot notice.

Suspension is not a corner case: `policy_suspended` is a Governor outcome, and the
Operator is the surface an owner uses to ask what is wrong. Minimal correction: give
rule 5 the same carve-out, or scope its "only when" to the unprompted composition it
is actually about.

**Honest tension, for the arbiter.** The known-and-accepted list says the chat
sentence is a prompt rule with no enforcement and that only the CARD half is
reportable. This finding is *not* that the chat half is unguaranteed — it is that the
artifact this fix edited now contradicts itself. An arbiter who reads the accepted
item as covering all prompt-text quality may reject it on that basis. It is P1, not
P0, because nothing enforces either rule: the blast radius is one ambiguous model
instruction.

---

## The new surface — what was attacked and what held

### 1. `postingBlockNowSentences`, three conditions, three mutations

| condition | mutation | outcome |
|---|---|---|
| row is `APPLIED` | `blockedNow = armedUnderBlock` | **killed** — `proposals.test.ts:744`, the PENDING row would carry both lists |
| stored `after` is armed | `blockedNow = context.posting.blocked && status === APPLIED` | **killed** — `proposals.test.ts:736`, an applied rule turning posting OFF would carry the notice |
| account is blocked | `blockedNow = storedAfter.threshold !== null && status === APPLIED` | **equivalent (proven)** |

The third is a **claim about the mutant, not about the oracle**, and does not block:
`buildAutoApprovalPostingStatus` (`posting-status.ts:65`) returns
`{ blocked: reasons.length > 0, reasons }`, so `blocked === false` implies
`reasons === []`; the neutral value FIX 3 substitutes is likewise
`{ blocked: false, reasons: [] }`; and the guarded expression maps `[]` to `[]`
either way (`posting-block-copy.test.ts:39`). The conjunct is redundant by
construction. Round 1 reached the same proof for the sibling `corrected` predicate.

### 2. "A server path that produces a `ProposalView` without the field" — none found

Searched: every `ProposalView` mention outside tests (`TurnBody.tsx`, `reads.ts`,
`useProposalWrites.ts`, `useOperatorConversation.ts`, `RulesTimeline.tsx`,
`ProposalCard.tsx`) plus `mapStored`. Result:

- **`mapStored` is the only construction site**, and it spreads `...card`, which is
  `CardFacts`. All three producers of `CardFacts` — `withoutFriction`,
  `policyCardFacts`, `restoreCardFacts` (which returns one of the other two) — set the
  field. A new branch returning a `CardFacts` literal without it is a compile error,
  as claimed.
- **No serializer strips it.** `useProposalWrites.ts:24` `writtenProposal` is a cast,
  not a schema parse; `withPatchedProposal` (`useOperatorConversation.ts:148`)
  substitutes the row whole. Nothing picks fields between the server and the card.
- **The `?? []` fallback is genuinely exercised**, not merely asserted in a comment:
  the proposal fixtures in `RestoreWorkflow.test.tsx:40` and `OperatorClient.test.tsx`
  **omit** the field. Mutating `proposal.postingBlockNowSentences ?? []` to a non-null
  assertion (`RT2-M10`) fails 14 of 29 tests across those two suites. The
  optionality claim is measured.

### 3. Mutual exclusivity — no state produces both, and the "neither" states are intended

`corrected` and `blockedNow` share `armedUnderBlock` and differ only in the required
row status; a row has one status, so **both non-empty is unreachable by
construction**, and `RT2-M05` proves the status conjunct is observed rather than
merely written. The states that show **neither** while armed and blocked are
`rejected`, `stale`, `superseded` and `failed` — the pre-existing
"history gets no correction" rule, unchanged by this fix, and for `failed` the card's
own Refresh-plan offer produces a fresh PENDING proposal that does carry the warning.

### 4. FIX 3 — no row state needs the value and is skipped

`usable` admits exactly `PENDING` and `APPLIED`; `policyCardFacts` produces a
non-empty list for exactly `PENDING` and `APPLIED`. The predicates are the same set,
and both directions are measured: narrowing `usable` to `PENDING` only (`RT2-M08`)
kills on the applied card losing its notice, and widening it to always-true
(`RT2-M09`) kills on the skipped statement. When skipped, the neutral status flows to
rows that would produce `[]` regardless — see the RT2-M07 proof. **No silent drop
found.** The only casualty is the doc row (RT-06).

`asProposalStatus` throwing on an unknown status (`schema.ts:52`) moves one statement
earlier under the new predicate; it threw in `mapStored` before. No behavioural change.

### 5. `mappers.ts` — the ADR 0034 pin holds

Reverting to `tierGrantsAutopilot(...) && autopilotPurchasable()` (with the import
restored, so the mutant compiles) **kills** the new test:
`expected [ 'auto_approval_disabled', ...(3) ] to not include 'autopilot_unavailable'`
at `business-detail.test.ts:455`. The Copilot half of the boundary is pinned by a
second case, so the fix cannot be half-reverted.

---

## Sound searches that found nothing

### Sibling cases — `buildAutoApprovalReadiness` has exactly three callers

Pattern searched: `buildAutoApprovalReadiness` and `tierGrantsAutopilot` across
`src/` and `worker/`, excluding `**/__tests__/**`. Three readiness callers:
`settings.ts` (`buildReadiness`, tier only), `solicitation-settings.ts:194` (tier
only, and the ADR's cited precedent), `mappers.ts:191` (tier only after the fix).
**There is no fourth feed of `autopilotAvailable`.** Zero siblings — a valid negative
result, not an omission.

### `autopilotPurchasable()` callers — the ADR's list is exact and exhaustive

Six call sites at HEAD, and the ADR's "four ... two more" partition names all six:

| caller | ADR bucket |
|---|---|
| `tier-purchasability.ts:27` (inside `assertTierPurchasable`) | buying |
| `(public)/pricing/page.tsx:19` | buying |
| `onboarding/pay/page.tsx:112` | buying |
| `api/account/settings/route.ts:115` | buying |
| `worker/ingress/stripe/checkout-completed.ts:678` | alert only |
| `worker/ingress/stripe/subscription-updated.ts:463` | alert only |

`worker/boot-flag-summary.ts:72` reads the **raw env var** and says so in its own
comment ("deliberately NOT `autopilotPurchasable()`"), so it is not a caller; round 1's
wider list was of `AUTOPILOT_PURCHASABLE` readers, a different set.
`plan-presentation.ts` receives the boolean as an input field and never calls it.
`assertTierPurchasable` is reached from `plan-activation.ts:392,425` and
`tier-change.ts:135,696`, which is the Checkout + `POST /api/billing/tier-change` pair
the env-vars row claims; `TierNotPurchasableError` and
`autopilot_activated_while_unavailable` both exist verbatim. **ADR 0034's caller list
and the `AUTOPILOT_PURCHASABLE` row are both correct at HEAD.**

### `ws8-staging-smoke.ts` scenario 12 — read as code, both directions covered

No gate runs this script, so it was read rather than mutated. **If expansion were
wrongly ALLOWED**, all four checks fail: `thrown === 'none'` fails
`expansion_blocked_error`; `blockReasons` stays `null`, so
`null?.includes(...) === false` evaluates `undefined === false` -> **false** and fails
`no_autopilot_unavailable_reason`; `(null?.length ?? 0) > 0` fails
`other_block_reason_present`; and the written row fails `no_policy_row_written`. **If
ADR 0034 were half-reverted**, `autopilot_unavailable` reappears in `blockReasons` and
`no_autopilot_unavailable_reason` fails. The rewritten scenario is not vacuous in
either direction, and `other_block_reason_present` is exactly the guard that stops the
negative check passing on an empty list.

### Phase D runbook + env-vars row re-resolved

Every reason the runbook names — `auto_approval_disabled`,
`provider_moderation_disabled` / `provider_moderation_not_validated`,
`subscription_not_writable`, `policy_suspended` — exists in `readiness.ts:39-46`, and
"Governor" maps to `policy_suspended` (`readiness.ts:18-22`). Paths cited
(`src/lib/payments/tier-purchasability.ts`, `src/lib/auto-approval/flags.ts`) resolve.
`prevalidate-plan.py` on the four changed docs: ADR 0034 **PASS**,
`lib-owner-operator.md` **PASS**, Phase D runbook **PASS**, `env-vars.md` **1 issue** —
`11858d51`, a Railway deployment id in the pre-existing `OWNER_OPERATOR_ENABLED` row,
untouched by this branch and not a git commit. Not a finding.

### Operational completeness

FIX 3 removes a query on some paths and adds no failure path; the new field is a pure
read-time projection. No new `process.env` read, no migration, no flag, no
`NEXT_PUBLIC_*`. Nothing belongs in `docs/runbooks/beta-launch-alerting.md`.

---

## Protocol notes

- **Budget.** 13 launches, ~25 s of the 1200 s round budget. 12 mutations journaled,
  **all restored**; `git status --porcelain` is empty except these two artifacts.
- **Three file-scope runs.** `RT2-M10`, `RT2-M11` and `RT2-M12` were executed at test-file
  scope rather than with `-t`, so `assert-one-test` was not applied to them. All three
  are **kills**, for which file scope is conservative, and the failing test titles and
  assertion messages are recorded on each inventory row. Recorded rather than hidden.
- **Round 1's `skipped-budget` row is resolved.** Round 1 declined to mutate
  `OWNER_OPERATOR_PROMPT_VERSION` as circular. It is not: the same test asserts the
  version label AND that `operatorSystemPromptHash()` has moved, so a stale label
  beside a moved hash is caught. Mutated (`RT2-M12`) and killed.
- **The live-DB lane was not re-run, and is not recorded as inconclusive.**
  `reads.integration.test.ts` is unchanged by the round-2 fix set and outside its
  scope; the orchestrator's gate at this HEAD ran both integration suites and both
  PASS (`.feature/gate-status.json`). Recorded `excluded` with that reason.
- **Round 3 is not available.** `round-start` refuses a third round without an owner
  authorization already in this sidecar. Both open P1s therefore go to adjudication as
  they stand.

---

## Low-confidence appendix

Recorded for completeness; below the >= 80 % bar and deliberately not in the table.

- **The #1352-at-confirmation lead-in is rendered in the card's softest type.**
  `POSTING_BLOCK_NOW_LEAD` uses `.op-note` (`operator.css:115` —
  `--rw-app-micro`, `--rw-app-text-soft`), the same token as the "Affects N locations"
  footnote, while the sentences beneath it use `.op-readiness` (`--rw-app-body`,
  `--rw-app-text-muted`). The one line that concedes the account cannot post is the
  least prominent thing on the card. A design judgement, not a verifiable defect, and
  outside a verifier's remit.
- **`expect(lead).toHaveTextContent(/right now/)`** (`ProposalCard.test.tsx:252`) is
  tautological — `lead` was just selected by a regex that contains that substring. It
  costs nothing and catches nothing.
- **`expect(silence).not.toMatch(/say nothing about a Posting block/)`** is an
  absence-of-one-literal proxy of the family RT-05 was about, though here it is paired
  with four positive `toMatch` assertions on the new wording, which is what actually
  measures the narrowing.
- **Scenario 12's precondition is now vestigial.** It still refuses to run when
  `AUTOPILOT_PURCHASABLE === 'true'`, but after ADR 0034 the gate's state no longer
  affects any of its four checks. Harmless; the scenario's name and guard now describe
  a dependency it does not have.
- **The `context.ts` row in `lib-owner-operator.md` still calls `correctionOwed`
  "the sole suppression switch"** while the source docblock it mirrors now says it
  "governs UNSOLICITED correction only ... and is not a gag", and the `prompt.ts` row
  four lines below records the direct-question carve-out. Strictly the row is still
  true (it is the only such switch) — filed here rather than folded into RT-06 for that
  reason.

## Authorizations

None.
