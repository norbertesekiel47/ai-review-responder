# Red team — fix/1352-operator-posting-block-context

| | |
|---|---|
| Mode | feature (round 1) |
| Risk | high |
| Fork / merge-base | `cb90d3f5ee1ae7b827da5446792f344703af3d5e` |
| HEAD | `9bfc3491f49464e5c804274dbc2b086116222821` |
| Intake SHA-256 | `96f2b873e6761ed25a35880393cc559c27a66b852f4492718ddc50529c75b751` |
| Generated | 2026-09-21T01:19:07Z |
| Status | **OPEN_P0** |
| Budget spent | 23 s of 1200 s, 21 of 400 launches |

> **Report path.** The task named `docs/reviews/red-team/fix-1352-operator-posting-block-context/`.
> The checker (`red-team-status.mjs`) derives the slug itself and expects `…-53402a/`.
> These artifacts are written where the checker looks, because that is the path the
> `reviewed` transition parses.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| **P0** | `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx:206` | The card's Posting block render gate is unverified at **one** sentence — the modal case and #1352's own scenario. `length > 0` → `length > 1` survives both card tests. |
| P1 | `src/lib/agents/operator/proposals.ts:498` | The **restore-card** branch of the fix has no covering test. Neutering it leaves all 56 tests in the four restore-touching suites green — and its own comment names exactly this risk. |
| P1 | `docs/directory/lib-owner-operator.md:26` | "Five rules state the **Posting block**, every one of them gated on `correctionOwed`" is false, and the sentence enumerates only four. |
| P1 | `src/lib/agents/operator/__tests__/context.test.ts:356` | A comment and fixture added on this branch assert the readiness behaviour that this branch's own ADR 0034 deleted; the fixture now models a state no account can reach. |
| P2 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:220` | `queryByText('judge_disabled')` is an absence-of-one-literal proxy for "no reason code leaks"; it passes trivially. |

---

## RT-01 (P0) — the guaranteed card is not guaranteed at n = 1

`ProposalCard.tsx:206`

```tsx
{proposal.postingBlockSentences.length > 0 && (
  <ul className="op-readiness">{proposal.postingBlockSentences.map(…)}</ul>
)}
```

**Mutation** `length > 0` → `length > 1`. Run against BOTH card tests that supply a
Posting block:

| test | sentences supplied | mutant result |
|---|---|---|
| `the card renders one owner sentence per Posting block reason` | 2, then 0 | **PASSED** (survived) |
| `the card still allows Apply while a Posting block is present` | 1 | **PASSED** (survived) |

**Arbiter confirmation.** Not equivalent: at exactly one sentence the mutant renders
nothing where HEAD renders the correction. Not an unexecuted branch: both tests
execute the gate. The first test renders two sentences (so `> 1` is still true) and
its negative case renders zero (so both predicates suppress); the second renders one
but asserts only that Apply stays enabled, so no assertion observes the n = 1 render.

**Why this matters here and not as a nitpick.** A single-reason Posting block is the
ordinary production shape — `JUDGE_ENABLED=false` alone, or Copilot alone — and
`judge_disabled` alone is literally the #1352 scenario (it is one of the two reasons
with no readiness analogue, which is the whole reason the field exists). The owner's
recorded step-1 decision is *"card guaranteed, chat guided"*: the card is the
deterministic half. That guarantee is unmeasured at its most likely arity.

**Production code at HEAD is correct.** The defect is in the test that claims this
coverage. One line fixes it: assert the sentence renders inside
`the card still allows Apply while a Posting block is present`, or drop the rendering
test to a single sentence.

## RT-02 (P1) — the restore-card branch is uncovered

`proposals.ts:493-498` threads the read context through `restoreCardFacts` with an
explicit comment:

> *"a restore that re-arms auto-posting is the same claim about posting, and a fix
> applied to only one branch leaves restore cards silent."*

**Measurement.** The restore branch was mutated to pass
`{ ...context, posting: { blocked: false, reasons: [] } }` into `policyCardFacts`,
neutering the Posting block on restore cards only. Whole-suite sweep over
`proposals.test.ts`, `ProposalCard.test.tsx`, `RestoreWorkflow.test.tsx` and
`apply.test.ts`: **4 suites, 56 tests, 56 passed, 0 failed.**

Nothing in the repository asserts `postingBlockSentences` on a restore card — not the
mocked suites, and not either live-DB case in `reads.integration.test.ts` (both seed
ordinary policy proposals). Recorded as an uncovered change rather than a confirmed
survivor, because no candidate test exercises the behaviour at all, which is the
protocol's own classification for this shape.

## RT-03 (P1) — a false universal in the directory page

`docs/directory/lib-owner-operator.md:26`:

> *"Five rules state the **Posting block**, every one of them gated on
> `snapshot.posting.correctionOwed`: speak only when it is true …, say nothing when it
> is false …, keep proposing the requested operation regardless, and state suspension
> first without either replacing the other."*

Machine check of `prompt.ts` at HEAD — five bullets added, classified by content:

| # | contains "Posting block" | contains `correctionOwed` |
|---|---|---|
| 1 | yes | yes |
| 2 | yes | yes |
| 3 (`Say "set to post", never "posts"`) | **no** | **no** |
| 4 | yes | yes |
| 5 | yes | yes |

Rule 3 is an unconditional phrasing rule. So either the count "Five" is wrong (the
sentence enumerates four) or the universal "every one of them gated on
`correctionOwed`" is wrong. The branch's own test encodes the correct scope — it
filters `rules.filter(r => r.includes('Posting block'))` before asserting
`correctionOwed` — so the doc contradicts the test written beside it.

## RT-04 (P1) — the branch left its own pre-ADR-0034 rationale in a test it added

`src/lib/agents/operator/__tests__/context.test.ts:355-357`:

> *"The real Autopilot-with-paused-sale case: readiness carries `autopilot_unavailable`
> (it folds in `autopilotPurchasable()`, which the runtime never reads) while the
> account posts perfectly well."*

ADR 0034 — on this branch — deleted that fold. `buildReadiness` (`settings.ts:1218`)
now passes `autopilotAvailable = tierGrantsAutopilot(account?.subscription_tier)`
alone. The branch corrected the same sentence in `posting-status.ts`, `context.ts` and
the glossary; this copy was missed.

The fixture is worse than a stale comment. `settings()` (`context.test.ts:108-123`)
pins `readiness.blockReasons: ['autopilot_unavailable']` together with
`posting: { blocked: false, reasons: [] }`. At HEAD `autopilot_unavailable` implies
`!tierGrantsAutopilot`, which forces `autopilot_tier_required` into `posting.reasons`
and `blocked = true`. **No account can produce that response.** The test still passes
and still checks a real structural property (the projection ignores readiness), but its
stated discriminator no longer exists — `posting-status.ts` at HEAD names
`provider_moderation_not_validated` as the surviving one.

## RT-05 (P2) — absence-of-one-literal proxy

`ProposalCard.test.tsx:220` —
`expect(screen.queryByText('judge_disabled')).not.toBeInTheDocument()`, commented as
"no reason code leaking to the owner". It excludes one of five literals and passes
trivially: the card is handed owner sentences and never receives a reason code, so
there is nothing that could leak. Behavioural replacement: assert the rendered list
equals the supplied sentence array exactly (which also catches an extra or reordered
line), or iterate every `AutoApprovalPostingBlockReason`.

---

## Sound searches that found nothing

These are reportable negative results, not omissions.

### D7 — the refreshed evidence pins (attacked hardest, per the task)

Three independent checks, all against HEAD:

1. **Only `line` and `testSha256` moved.** Both versions of
   `OPERATOR_FRONTEND_ASSERTION_SITES` were parsed and compared field by field:
   14 records, same ids, same order, **13 changed**, and in every changed record only
   `testSha256` and `line` differ (8 records moved line). `sourceLine`, `test`, `file`,
   `target`, `originalOid`, `mutantSha256`, `family`, `header` and `messagePrefix` are
   byte-identical. D7's claim is exact.

2. **The freshness replay matches D7's numbers.** Old pins against the merge-base tree:
   **14/14 fresh**. Old pins against HEAD: **1/14**. New pins against HEAD: **14/14**.
   `mutation-runner.mjs:626` confirmed to be the SHA-256 + pinned-line guard D7 names.

3. **Two refreshed sites were actually re-run** — both of the sites whose *target* file
   this branch edited, which is where the inference was weakest:

   | site | mutation | result | stack frame |
   |---|---|---|---|
   | rt-0041 | `ProposalCard.tsx:232` `disabled={busy}` → `disabled={false}` | **killed** | `RestoreWorkflow.test.tsx:218` — the refreshed line |
   | rt-0039 | `ProposalCard.tsx` Apply label forced to `'Confirm and apply'` | **killed** | `RestoreWorkflow.test.tsx:176` — the refreshed line |

   Both failures carried the site's pinned shape: rt-0041 produced
   `Error: expect(element).toBeDisabled()` + `Received element is not disabled:` with a
   `__VITEST_EXTEND_ASSERTION__` dependency frame; rt-0039 produced the exact
   `messagePrefix` `Unable to find role="button" and name "Apply"` with the
   `waitForWrapper` and `query-helpers.js` dependency frames. Each run resolved to
   exactly one project stack frame, at the refreshed line.

   **D7's inference holds. No P0 here.** The one apparent anomaly — `originalOid` for
   rt-0039/rt-0041 no longer matching HEAD's `ProposalCard.tsx` blob — is by design:
   `operatorRunMetadata` resolves `originalOid` from `proof.controlHead`, a historical
   SHA, not from HEAD.

### Missed sibling cases

- **No eighth path to a rendered card.** All seven exported readers in `proposals.ts`
  (`listProposalsForTurn`, `listProposalsForTurns`, `listPendingProposals`,
  `listProposalsByIds`, `listAppliedProposals`, `readProposalForAccount`,
  `lockProposalForAccount`) route through `mapStoredRows`, and `ProposalView` is
  constructed nowhere else. The doc's "all seven readers" count is exact.
- **No path bypasses `mapStoredRows`.** Every terminal transition in `apply.ts`
  (`recordApplied`, `recordTerminal`) re-reads through `readProposalForAccount` rather
  than spreading a stale view. Searched for `...proposal` / `...view` spreads across
  `src/lib/agents/operator/` and the operator UI — the only hits are
  `deriveRestoreInput`, `render.ts`'s scope attachment, and the client's
  `withPatchedProposal`, none of which fabricate a `ProposalView`.
- **No serializer drops the new field.** `/api/operator/conversation` returns
  `result.view` whole; there is no field-picking DTO between `mapStored` and the card.
- **`autopilotPurchasable()` has no second readiness-shaped caller.** All production
  callers enumerated: `tier-purchasability.ts` (owner), `pricing/page.tsx`,
  `onboarding/pay/page.tsx`, `plan-presentation.ts`, `api/account/settings/route.ts`,
  `admin/business-detail/mappers.ts`, `worker/boot-flag-summary.ts`,
  `worker/config/startup-assert.ts`, `worker/ingress/stripe/{checkout-completed,
  subscription-updated}.ts`. Every one is a sales/checkout or display surface. Nothing
  under `worker/jobs/publisher/` reads it, which is the ADR's central claim.
  `solicitation-settings.ts:194` already passed tier entitlement alone, exactly as the
  ADR states.

### Doc claims re-resolved against HEAD

- `AutoApprovalClient.tsx:705` (the armed-account predicate) and `:684-686` (the
  armed-override shape), cited in `context.ts` and `lib-owner-operator.md` — **both
  correct at HEAD**, byte-checked.
- `mutation-runner.mjs:626` — correct.
- ADR 0034's quoted `buildReadiness` snippet, its description of
  `autopilotPurchasable()` (`AUTOPILOT_PURCHASABLE === 'true' && autoApprovalRuntimeEnabled()`)
  and its `solicitation-settings.ts` precedent — all verified verbatim.
- Glossary **Posting block** in `core-reviews-responses.md` — updated correctly,
  including the ADR 0034 correction to its own prior headline example.
- `prevalidate-plan.py` run on all six changed docs: five PASS.
  `.claude/reference/arch-review-log.md` reports 13 issues, **all pre-existing** — the
  branch added one row, and none of the unresolved citations or stale commits is in it.
  The added row's own checkable claims (14/14 → 1/14 freshness, `mutation-runner.mjs:626`,
  "13 of 14 records", "only `line` and `testSha256`") were independently re-derived above
  and are correct.
- `ci:directory-map` passes; the new `posting-block-copy.ts` has its row in
  `docs/directory/lib-reviews-responses.md:37`.
- All **24** promised intake test titles exist in the tree (machine-checked).

### Operational completeness

- **No migration, no flag, no env var** — confirmed. No file under
  `supabase/migrations/`; no new `process.env` read; no new `NEXT_PUBLIC_*`. The
  intake's rollback plan ("revert the merge commit") is sufficient because nothing here
  is stateful.
- **No new operator-actionable terminal or swallowed failure path.**
  `getAutoApprovalPostingStatus` adds one primary-key `accounts` read to a function that
  already issues a `SELECT`; `buildPostingStatus(undefined)` returns `blocked: true` for
  a missing account row rather than throwing (`settings.ts:1246-1256`), so a vanished
  account degrades to "cannot post" instead of 500-ing an operator read. Nothing new
  belongs in `docs/runbooks/beta-launch-alerting.md`.
- **The accepted "card guaranteed, chat guided" limitation is not reported as a
  finding**, per instruction. RT-01 is reported because it is the *guaranteed* half
  failing to be verified, not the guided half being unguaranteed.

---

## Protocol notes

- **One budget overrun, in the conservative direction.** The test `a Posting block
  corrects neither history, a voice proposal, nor an unblocked account` received four
  mutations (RT-M01, RT-M03, RT-M04, RT-M18) against the documented cap of two per
  test. That is over-measurement, not under-measurement; three of the four killed and
  the fourth is a proven-equivalent. Recorded rather than hidden.
- **Live-DB lane not exercised.** No validated localhost `TEST_DATABASE_POOL_URL` was
  available, so the red-team environment set `REPWORTH_DISABLE_LIVE_DB_SUITES=1` and
  promised tests #23 and #24 (`reads.integration.test.ts`) never ran. They are the only
  tests covering the transcript reader end to end and the only proof that the derivation
  actually re-reads. Recorded `inconclusive` / `infra`.
- **Restoration.** 19 journaled mutations, all restored; dotenv swap closed; journal
  closed; `git status --porcelain` shows only this run's report directory plus the
  pre-existing untracked
  `docs/reviews/fix-1352-operator-posting-block-context/blast-radius.md`.
  `git diff HEAD` is empty on every tracked path.

---

## Low-confidence appendix

Recorded for completeness; below the >=80 % bar and not in the table.

- **Flag divergence between Vercel and Railway.** `getAutoApprovalPostingStatus` reads
  `AUTO_APPROVAL_ENABLED`, `JUDGE_ENABLED` and `OPENAI_MODERATION_ENABLED` in the
  Next.js process, while the Operator's chat sentence is produced on Railway from the
  same flags. If the two environments ever disagree, the card and the chat can disagree
  about the same account. Not new — the settings page has had this shape since #1314 —
  and no evidence either way was gathered here.
- **`db_touching: false` in the intake.** The change adds a per-read `accounts` query.
  If `db_touching` means "schema", the intake is right; if it means "issues SQL", it is
  not, and CLAUDE.md's "DB-touching changes also run `ci:tenant-scope` and
  `ci:rls-audit`" would attach. The query reuses the existing, tenant-scoped
  `loadSettingsAccount`, so the substantive risk is nil either way.
- **Edits outside the blast radius.** `docs/context/core-reviews-responses.md` carries
  ~12 unrelated glossary rewordings ("the file that owns each term" -> "the file owning
  each term") that look like word-budget squeezing for the shape guard rather than
  anything the ticket required. No meaning changed in the ones read.
- **`apply.test.ts`'s stub returns a partial type.**
  `getAutoApprovalPostingStatus: async () => ({ blocked: false, reasons: [] })` is a
  structurally valid `AutoApprovalPostingStatus`, so this is fine; noting only that the
  suite therefore never exercises the blocked path through Apply.
- **`docs/reviews/fix-1352-operator-posting-block-context/plan-round-2.md` is not in the
  intake's `allowed_edit_surface`** (round-1 is). Probably covered by a recorded surface
  amendment; not chased.

## Authorizations

None.
