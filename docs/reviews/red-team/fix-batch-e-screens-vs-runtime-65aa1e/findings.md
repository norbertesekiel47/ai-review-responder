# Red team — `fix/batch-e-screens-vs-runtime`

**Round 3 (verification round, owner-authorized).** Mode `feature`, risk `high`.

| | |
|---|---|
| Fork / merge-base | `d79bc765ce630ea651efe67ec6a7b3488c5afa86` |
| Round 1 reviewed | `825f0fbbf` |
| Round 2 reviewed | `9a7a459f9d3df442e74c66a98d193d0bb34cf8a4` |
| **Round 3 head** | **`0b095f9f95eda23b34b6d5ec892bfec601a0437f`** |
| Scope | `9a7a459f9..0b095f9f9` — the round-2 fix commit `b8bfd2c7b` and the docs commit `0b095f9f9`, and nothing else |
| Intake sha256 | `6eadccb2aa200ac2676106ecc5c8fc576a26b28d084e73c865259b6abd632fa7` |
| Budget spent | 11s of 1200s measured test time, 6 of 400 launches |
| **Status** | **`OPEN_P0`** |

Round 3 was opened to verify round 2's fixes, because fixing round 2's two P0s
moved the tree and made round 2's own sidecar stale by construction. It did
what a verification round is for: **one of the two P0 fixes is incomplete, and
the record says it is complete.**

---

## The two questions this round existed to answer

**1. Did any of these fixes introduce a new defect?** Yes — one, cosmetic. The
`differingExceeds` fix for RT2-7 now makes the blocked override-only banner
print the armed location's name twice, which is exactly what round 2 had
rejected as unreachable (RT2-R3). That rejection is overturned.

**2. Is any claimed disposition unsupported by evidence?** Yes — three.
`RT2-2` was claimed FIXED and is only half fixed; the doc claims built on it
(`triage-verdicts.md:56`, deviations `D12`) are false; and `RT2-6` was to be
recorded `accepted-risk` with no authorization that resolves, so it is `open`.

---

## Findings

| ID | Sev | Disposition | What round 3 found |
|---|---|---|---|
| **RT2-2** | **P0** | **open** | Only half fixed. The affirmative still renders while `canExpand` is false — measured, two reachable paths |
| **RT3-1** | **P0** | **open** | "the fix removes the whole class" / "the test pins the real invariant" are false, in two committed docs |
| RT3-2 | P1 | open | The new invariant test never reaches `tone === 'blocked'`, so it constrains nothing |
| RT3-3 | P1 | open | `differingExceeds` and the new RT2-5 supporting line ship with zero covering assertions |
| RT2-R3 | P2 | open | Round 2's rejection overturned: the armed name now prints twice |
| RT2-1 | P0 | fixed | Boot-log example re-derived against `createWorkerLogger`; both copies byte-identical |
| RT-2 | P1 | fixed | Corrected claim resolves; no fifth copy in product code |
| RT2-3 | P1 | fixed | Header exception stated; directory row matches the code key for key |
| RT2-5 | P1 | fixed | No reachable headline still makes the un-softened claim |
| RT-3 | P1 | accepted-risk | Owner deferral corroborated by GitHub issue #1352 |
| RT2-7 | P2 | fixed | The dropped name now prints (its two side effects are RT2-R3 and RT3-3a) |
| RT2-8 | P2 | rejected | A deliberate, now-documented style pin over a verified convention |
| RT2-9 | P2 | fixed | Count pin kills a wrapped go-live line with a legible message |
| RT2-6 | P2 | open | Reasoning sound, but no authorization resolves — cannot be `accepted-risk` |
| RT-6 | P2 | open | Carried from round 1, out of scope |
| RT-1, RT-4, RT-5, RT-7, RT-8 | — | fixed | Carried; re-confirmed unchanged at this SHA |
| RT2-R1, RT2-R2, RT-9…RT-13 | P2 | rejected | Carried rejections, re-confirmed |

---

## RT2-2 — the half that is not fixed

`canExpand` is `blockReasons.length === 0` (`src/lib/auto-approval/readiness.ts:46`).
`ReadinessBlock` renders the green "✓ You can widen or narrow auto-posting
whenever you like" whenever its item list is empty
(`AutoApprovalClient.tsx:1437-1444`). Two client-side filters can empty that
list while `blockReasons` is not empty:

- `:279` — the suppression round 1 added and round 2 re-keyed onto `status.tone`
- `:274` — the pre-existing `policy_suspended` suppression (present at the fork)

Round 2's fix closed the sub-case where the blocked banner is NOT rendering. It
did not close the case where it IS.

**Measured at `0b095f9f9`, production unmutated**, with two probes added as a
journaled mutation of the test file (2 failed / 60 passed):

- **Probe C** — account default armed (threshold 5), `posting.blocked` with
  reason `provider_moderation_disabled`, `readiness.blockReasons =
  ['provider_moderation_disabled']`, `canExpand: false`. `status.tone` is
  `'blocked'`, the single reason is suppressed at `:279`, the list empties, and
  the affirmative renders next to a banner that says the account is not set up
  to post.
- **Probe D** — `accountDefault.suspended` with `blockReasons =
  ['policy_suspended']`. Same outcome via `:274`. Pre-existing at the fork, so
  out of scope to fix here — but it disproves "the whole class".

Probe C is reachable in production: `providerModerationValidated()` reads an
INDEPENDENT flag (`AUTO_APPROVAL_PROVIDER_MODERATION_READY`,
`auto-approval/flags.ts:15-17`), so `OPENAI_MODERATION_ENABLED=false` on an
Autopilot account with the runtime on yields exactly that single reason — the
same pair round 2 used to establish its own reachability.

The fix's real part is real: re-applying round 2's bug (`status.tone ===
'blocked'` -> `state.data.posting.blocked`) fails the suite **2 / 58**, exactly
as claimed, from a 60/60 baseline. Hoisting `describePolicyStatus` into the
parent is behaviour-preserving — `data` at `:421` is destructured from the same
`state`.

## RT3-1 — the record is wrong in two places

- `docs/reviews/fix-batch-e-screens-vs-runtime/triage-verdicts.md:56` —
  "**FIXED, and the fix removes the whole class**", "the fix makes that
  unrepresentable", and "The second test pins the real invariant directly: the
  green affirmative never renders while `readiness.canExpand` is false,
  whatever a future filter does."
- `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-deviations.md:333` —
  "the correction that makes the class unrepresentable rather than absent",
  written into the run's durable lessons file.

All three are false. The third is false for a structural reason worth naming:
the test at `AutoApprovalClient.test.tsx:230` spreads `baseState`, whose
`accountDefault.threshold` is `null` and whose one location inherits, so
`overrideNames` is empty, the blocked branch at `:724` is never taken, and
`status.tone` is `'off'` for all three of its iterations. **The filter it claims
to constrain never runs inside it.** It failed under the re-applied bug only
because that bug keyed on `posting.blocked`, which the fixture does set.

Two stale citations in the same row, dominated by the above: `ReadinessBlock
(:1403)` is `:1437-1444` at HEAD, and `readiness.ts:45` is `:46`.

## RT2-R3 — round 2's rejection is overturned

Round 2 rejected the double-print on the reasoning "Blocked override-only: title
names the armed overrides, `differingNames` skipped (`:729`)". The RT2-7 fix
removed that skip. Measured (probe E, production unmutated) with one armed
override and one differing-but-off override:

> Main Cafe **is set to post replies automatically**, but this account is not set
> up to post automatically right now. … **Main Cafe** and Second Site use their
> own settings.

The title names `overrideNames` (armed only); `differingNames` covers every
differing override. The fix traded a dropped name for a duplicated one.

---

## Inventory

| # | Candidate | File | Outcome |
|---|---|---|---|
| T01 | The two RT2-2 tests vs the re-applied bug | `AutoApprovalClient.test.tsx` | killed (2 failed / 58 passed) |
| T02 | The RT2-2 invariant, probed in the state it names | `AutoApprovalClient.test.tsx` | **survived-confirmed-P0** -> RT2-2 |
| T03 | `differingExceeds` reverted to `false` | `AutoApprovalClient.tsx:741` | inconclusive (oracle) -> RT3-3 |
| T04 | Go-live line wrapped onto a continuation | `boot-flag-summary.test.ts:68` | killed (1 failed / 9 passed) |
| T05 | Doc-only hunks | `docs/directory/worker-root.md` | excluded (duty 3 instead) |
| T06 | Comment-only production hunks | `worker/boot-flag-summary.ts` | excluded |
| T07 | Copy-string assertion updates | `AutoApprovalClient.test.tsx` | excluded |
| T08 | RT2-5 supporting line | `AutoApprovalClient.tsx:771` | inconclusive (oracle) -> RT3-3 |

## Duty 4 — searches run, recorded

- **Fifth tier-order copy.** ripgrep over the whole worktree, excluding `docs/`
  and `node_modules/`, for `['copilot','autopilot']`, `["copilot","autopilot"]`
  and `[SubscriptionTier.COPILOT…`. Outside tests: `verify-stripe-price-parity.ts:16`
  (named in the docblock), `TiersSection.tsx:13` (local `Mode` animation union,
  correctly excluded) and `schemas.ts:344` (`z.enum`, a membership set with no
  ordering meaning and no price). **No fifth copy.**
- **Remaining "never a second `readFlag`" assertions.** Repo-wide search: none.
- **Un-softened posting claims.** All four claim-making branches of
  `describePolicyStatus` use "set to post" (`:729`, `:730`, `:768`, `:788`). The
  other `automatically` hits are input hints, a cap error and the solicitation
  card. **None reachable.**
- **Assertions on the RT2-5 supporting line.** Two hits repo-wide, both in
  `AutoApprovalClient.tsx`. **No test pins it.**

## Authorizations

**`owner-batch-e-third-round-2026-09-20`** (2026-09-20) — RT2-1, RT2-2

> Owner authorized a **third round** on 2026-09-20, scoped to round 2's fix
> hunks. Round 2 found two P0s; fixing them moved the tree, making round 2's own
> sidecar stale by construction — the wall #1184 raised the cap from 2 to 3 to
> clear. The alternative was hand-editing `head_sha`, which that change exists
> to prevent.

**`owner-batch-e-rt3-deferral-2026-09-20`** (2026-09-20) — RT-3

> ACCEPTED RISK — owner-authorized. The owner was shown the finding and chose
> "Follow-up ticket": the Owner Operator surface is production code outside the
> locked edit surface, fixing it needs its own tests and review pass, and the
> branch fixed the surface the issue named. Filed as #1352 carrying the red-team
> evidence, the readiness-cannot-substitute reasoning, and the trap warning.

Corroboration, independent of any agent's prose: GitHub issue **#1352**, "Owner
Operator can still claim an auto-reply rule is live when the runtime will not
post", created 2026-09-20T06:21:32Z — before the fix commit — state OPEN,
labelled `bug` / `priority:P2`.

## Red-team findings rejected

- **RT2-8** — the `'[worker]'` compare is a deliberate consistency pin, now
  documented at `boot-flag-summary.test.ts:224-228`. The convention it enforces
  is real: every `createWorkerLogger` call in `worker/index.ts` is bracketed
  (`:625`, `:737`, `:796`, `:821`, `:830`, `:949`, `:973`, `:984`).
  `normalizeLoggerName` (`logger.ts:29-31`) makes the alternative byte-identical,
  so the pin costs nothing behaviourally, and RT-1's behavioural kill is carried
  by the separate assertions at `:219-223`.
- Carried rejections re-confirmed at this SHA: RT2-R1, RT2-R2, RT-9, RT-10,
  RT-11, RT-12, RT-13.

## Environment and restoration

Runner env allowlist only (`PATH`, temporary `HOME`/`TMPDIR`, `NODE_ENV=test`,
`CI=true`, `MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`);
`dotenv-swap` open for the whole mutation phase. `watchers` reported none before
the round opened. `finalize` reaped 6 process groups, restored the dotenv file
and closed the journal; `git status --porcelain` is empty on every path except
this run's two report artifacts. `prevalidate-plan.py` was not run — the changed
plan file is byte-unchanged since round 1, and the new deviations file was
hand-checked, which is what RT3-1 records.
