# Red team — #1009 the Refusal ledger's write path — ROUND 3 (attestation only)

- **Mode:** feature · **Round:** 3 · **Risk:** high
- **Branch:** `feat/1009-refusal-ledger-write-path`
- **fork / merge-base:** `0494297a0de3a9131fae1e6f2f641eb487ae7a58`
- **head:** `146b7a13fdac8a5d3907f31996db6518979a80d3`
  (round 2 ran at `2f57af488515d764b25bc8ab6f9e5342faef534f`; round 1 at `fc00bb9b7aa5a5f9ba9c65ee3afc97c54e4d5ec6`)
- **intake sha256:** `37fa06978867fa522469bb0e99795467cef4abd3c805f9352c4af06982b17ff0`
  (29 promised tests; round 2's `2d04d735…` had 28 and is superseded)

**Status: CLEAR.** No P0. **All eleven findings RT-1 … RT-11 now carry a resolved
disposition: 10 fixed, 1 accepted-risk (AUTH-1, owner-authorized). Zero open.**

---

## Why a third round exists at all

The skill caps red-team at two rounds and both were spent. Round 2 raised
**RT-8** (P1, measured): a test comment claimed coverage the test did not
provide. The owner chose to **close the real gap underneath it** rather than
soften the claim — promised test 29 was added and `write.ts`'s no-catch
paragraph was rewritten. That fix moved the tree and the intake, which voided
round 2's sidecar; `red-team-status.mjs` recomputes rather than trusts, so it
correctly refused the `reviewed` transition against a stale `head_sha` and a
stale `intake_sha256`.

This pass therefore exists **only to re-establish current, self-consistent
evidence**. It is recorded in the branch's deviations as D26. It is **not** a
third findings round: no new sweep, no re-run of round 1's mutation inventory,
no new fronts. One measurement, five re-verifications, one sidecar.

**This report replaces round 2's at the same derived path.** Rounds 1 and 2 are
preserved in `findings.json`'s inventory reasons and finding dispositions, so
nothing measured earlier is lost.

---

## Preconditions

- **Worktree clean at the committed pinned SHA** before the run: `git rev-parse
  HEAD` = `146b7a13…`, `git status --porcelain` empty. ✅
- **Journal:** closed on entry — every mutation `restored`, `dotenv.open: false`,
  no active supervisor, `runs: 0`. ✅
- **`round-start` NOT run, deliberately.** It hard-refuses `round > 2`
  (`mutation-runner.mjs:397-401`). The journal was already at `runs: 0` with a
  clean state, so the budget was available without it and no cap was bypassed by
  editing state. **One mutation run and one baseline run were consumed (2 of
  30).** This is the mechanical face of D26 and is recorded rather than worked
  around silently.
- **W1 recurs for the third consecutive round, unchanged.**
  `mutation-runner.mjs watchers` aborted on four processes. `lsof -a -p <pid> -d
  cwd` resolved every one OUTSIDE this worktree — three at the parent checkout
  `/Users/…/RepWorth`, one at the sibling worktree
  `…/RepWorth-worktrees/refactor-globals-css-extraction`. The check reads a
  host-wide `ps -Ao pid=,command=` and pattern-matches command lines
  (`mutation-runner.mjs:414-431`); it is not worktree-scoped despite its own
  message. No process serves or watches this worktree, so the precondition holds
  in substance and the run proceeded. Three rounds in a row is a standing tool
  defect, not an anecdote.
- **Environment isolated.** `dotenv-swap --test-db <localhost>` replaced
  `.env.local` with a scrubbed copy for the whole mutation phase; both runs used
  the runner's allowlist env (`--tmp-home` under the scratchpad,
  `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` both set to the validated
  localhost URL by `buildRunEnv`). Restored by `finalize`.
- **Live-DB lane armed, not assumed.** Both runs reported **exactly one executed
  test** via `assert-one-test`, read from the JSON report — never from an exit
  code, and never a silent skip.

---

## Job 1 — RT-8 re-confirmed by measurement

`git diff 2f57af48..HEAD` is the fix: `write.ts` (docblock only) and
`suspension.integration.test.ts` adding **promised test 29**, *"a ledger row
written through the caller's transaction does not survive that transaction's
rollback"* (`:616`).

**M10 was re-planted by hand, exactly as round 2 planted it** —
`writeRefusalEvent`'s `INSERT` and its `occurredAtFragment` argument rerouted
onto a freshly constructed `postgres(process.env.DATABASE_POOL_URL, { max: 1,
idle_timeout: 1 })` instead of the passed `tx`. Journaled blob
`f77260a0fe08 → 943dc54a1daa`.

| Run | Executed | Result |
|---|---|---|
| **Baseline** at `146b7a13`, test 29 | exactly 1 | **PASS** (supervisor exit 0) |
| **Mutant M10**, test 29 | exactly 1 | **FAIL** — `numFailedTests: 1` |

**RT-8 is fixed. The mutant that survived round 2 is killed by the test the
owner added.** This is the measurement the round existed to produce, and it is
the one finding this pass was permitted to raise had it gone the other way.

### The kill mechanism — verified, because the test states it as fact

The new case's comment claims the mutant dies through a **lock interaction** one
step before the surviving-row assertion, and specifically claims a `55P03`
reproduction. A comment asserting an unmeasured mechanism is precisely the
defect RT-8 named, so both halves were checked rather than believed.

**Half 1 — it dies by TIMEOUT, not by the assertion. TRUE.** The failed case's
recorded duration is **30016.39 ms** against the describe block's
`{ timeout: 30_000 }`, and the failure carries no assertion diff. The
surviving-row `expect` is never reached.

**Half 2 — the lock is the cause, and it is `55P03`. TRUE, reproduced in
isolation** on the same local Postgres, outside vitest and outside the repo:

- Connection A: `SELECT id FROM accounts WHERE id = $1 FOR UPDATE` — verbatim
  `account-lock.ts:19-24`, which `suspension.ts:273` runs as the transaction's
  **first** statement.
- Connection B, under `SET LOCAL lock_timeout = '2000ms'`: a **valid**
  `autonomy_suspended` row inserted into `refusal_events` for that same account.
- Result: **`SQLSTATE 55P03` — `canceling statement due to lock timeout`.**

The forcing constraint is `account_id UUID NOT NULL REFERENCES accounts(id)`
(migration 116:74): the insert needs `FOR KEY SHARE` on the exact row the caller
holds `FOR UPDATE`, so the private connection blocks on the transaction that is
awaiting it. (A first attempt with `subject_type = 'account'` was rejected by
`refusal_events_source_subject_pairing` before it ever reached the lock —
`autonomy_suspended` requires `subject_type IS NULL`, 116:114. The reproduction
above uses the valid shape.)

**Both halves of the comment's characterisation are accurate.** The comment is
also right to keep the assertion as the property-carrying line: it is what would
catch an own-connection write from a future caller that does not hold the
account lock. And its residual note re-resolves — `ci:db-imports` matches only
the `@/lib/db/server` specifier, so a bare `postgres(…)` inside
`src/lib/refusals/` is caught by no audit; this test is the only thing that
catches it.

### Restoration

`mutation-runner.mjs finalize` reported *"reap: every journaled process group is
empty (2 recorded) … restored 1 mutated file(s) and 1 dotenv file(s); journal
closed"*. `git status --porcelain` was **empty** afterwards and before the first
report byte was written.

---

## Job 2 — the five corrected claims, each checked against the source

Every one was re-resolved by reading the code or the cited artifact at HEAD,
**not** by reading the diff.

### RT-9 — the Governor alert row · **FIXED**

The row at `beta-launch-alerting.md:67-81` now says the opposite of what round 2
flagged:

> *That is better than silence — but **email is NOT an acceptable alert route by
> this section's own standard** (§1's premise: admin email shares the Resend
> provider with the product), so this row is still a **gap**, not merely an
> upgrade, until the Discord rule exists.*

That is consistent with §1's own second sentence at `:25-26`, which was the
contradiction. **The smaller half is fixed too**: the row now scopes its
evidence — *"the default-rule claim is unaudited in **production** (CONFIG-1's
evidence is a 2026-06-24 audit of `repworth-nv/repworth-staging`)"* — and that
citation matches CONFIG-1's own note **verbatim** at `:158-161` in both project
slug and date. The mechanism it rests on re-resolves:
`AutonomyGovernorScheduler.ts:116` is `Sentry.captureException(error, { tags: {
subsystem: 'autonomy_governor' } })` with no level override, against
`write.ts:294`'s `captureMessage` explicitly at `level: 'warning'`.

### RT-10 — the dangling test-title quotation · **FIXED**

`feat-1009-…-deviations.md:278` now quotes the **current** title, *"exactly one
Sentry warning per disabled episode"*, and adds an explicit marker:

> *(**Historical quotation:** when this deviation was written the title read
> "exactly one per process"; red-team RT-7 renamed it to match the shipped
> per-EPISODE rule. The mechanism this row records is unchanged.)*

The quoted text matches promised test 9 in the current intake exactly. Grepping
the **fact** rather than the cited line found no other refusal-ledger
"per process" claim in the deviations file, the intake, `docs/directory.md` or
`.claude/reference/env-vars.md`. The two remaining hits in the deviations file
(`:674`, `:790`) are the correct per-EPISODE statement and the sweep's own
narrative.

### RT-11 — the plan's rollback section · **FIXED**

`feat-1009-…-plan.md` `## 8. Rollback` at `:1061-1073` now reads:

> *Rows already written are **NOT** deleted by a rollback, and the PR revert
> **removes the very sweep that would have retired them** … surviving rows have
> no writer, no reader and no pruner until a later slice restores the arm … it
> **must not be described as self-cleaning**, which an earlier draft of this
> section wrongly did.*

Compared side by side against `.feature/intake.json`'s `rollback_plan`, which
says the same in the same terms. The two artifacts now agree, and the one that
was wrong is the operator-facing one.

### RT-4 residue — the no-catch paragraph and its citations · **FIXED**

`write.ts:31-45` no longer claims a catch would hide the writer bug simpliciter.
It now states plainly that a catch **would NOT save the transaction**, and
scopes what a catch actually hides to *this helper's own caller* — which is
true: `suspendAccountAutonomy` would proceed past a swallowed failure instead of
raising it, even though `sql.begin` still rejects.

**Both line ranges were checked against the INSTALLED package**, because a
corrected citation that is itself wrong is worse than the original. Read at
`node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js`:

| Cited | Actual at that range | Verdict |
|---|---|---|
| `:291-296` "records `uncaughtError` per query inside `scope()`'s `handler`" | `function handler(q) { q.catch(e => uncaughtError \|\| (uncaughtError = e)); … }` — the whole function, exactly | **accurate** |
| `:265-266` "rethrows it after the callback returns" | `if (uncaughtError)` / `throw uncaughtError`, immediately after the callback promise resolves at `:260-263` | **accurate** |

Round 2's report had suggested `:260-266` for the rethrow; the fix chose the
tighter `:265-266`, which is the rethrow itself and is correct. The same
corrected pair is quoted in the test comment at
`suspension.integration.test.ts:594-597` and resolves identically.

### The plan §1 code sample · **FIXED**

`plan.md:115-140` no longer shows the pre-union flat record. It now describes
the mapped type, and every element matches `write.ts`:

| Plan §1 says | `write.ts` |
|---|---|
| `export type RefusalOccurredAt = Date \| 'transaction_time';` | `:91` — identical |
| `{ [L in RefusalSource]: RefusalEventBase & { refusalSource: L } & RefusalLaneShapes[L] }[RefusalSource]` | `:199-201` — identical modulo the binder name (`Lane`) |
| seven fragments: `AtLocation`/`AccountWide`, `Subject<T>`/`NoSubject`, `WithCode`/`WithoutCode`/`WithCodeSet` | `:126, :133, :136, :139, :142, :149, :160` — all seven present under those names |
| `autonomy_suspended` cannot carry a subject | `:181` `AccountWide & NoSubject & WithCode` |
| `held_draft` cannot carry a code | `:179` `… & WithoutCode` |
| `policy_gate_held`'s array is `readonly [string, ...string[]]` | `:160` `WithCodeSet`, bound at `:185` |
| `refusalCategory` deliberately NOT narrowed per lane | `:112` on `RefusalEventBase`, typed `RefusalCategory` |
| `writeRefusalEvent(tx: TransactionSql, input: WriteRefusalEventInput): Promise<void>` | `:355-358` — identical |

`RefusalLaneShapes` has exactly seven keys (`:178-186`), so the mapped type's
own compile-error guarantee — an eighth lane without a shape — is real.

---

## Mutation log

Rounds 1 and 2 planted eleven mutations; every target file except `write.ts`'s
docblock is byte-identical at round-3 HEAD, so those measurements carry forward
(per-row justification in `findings.json`). Round 3 planted **one**.

| # | Round | Mutation | Target case | Outcome |
|---|---|---|---|---|
| M1–M8 | 1 | see `findings.json` inventory | various | killed (8) |
| M9 | 1 | `write.ts` — catch the INSERT error and return | `suspension.integration.test.ts:555` | SURVIVED → equivalent (RT-4) |
| M9b | 1 | `suspension.ts` — delete the write site | `suspension.integration.test.ts:555` | killed (resolves M9's row) |
| M10 | 2 | `write.ts` — INSERT + fragment on a **separate postgres.js client** | `suspension.integration.test.ts:555` | SURVIVED → non-equivalent (RT-8) |
| **M10** | **3** | the **same mutation, re-planted** | **`suspension.integration.test.ts:616` (test 29)** | **KILLED — fails at 30016 ms** |

The same mutation now survives the old case and kills the new one. That is
exactly the shape a correct fix should produce, and it is why the new comment's
"what this does NOT discriminate" paragraph is true rather than defensive.

---

## Out of scope — not triaged

This round is attestation-only. The following were noticed while verifying the
five claims above and are recorded **without triage**, as findings or otherwise:

- **`plan.md:342-344` states the warning rule as "per process" prescriptively**
  (*"emit **one** `Sentry.captureMessage(…)` per process. Once per process…"*)
  while `:396` in the same document says *"The rate limit is per DISABLED
  EPISODE, not per process… Under **the old rule** a second outage in the same
  process was silent."* Round 2 examined this and **cleared it** as superseded
  in place by the narrative structure of §2.3; the deviations file at `:790`
  separately records "one in the plan" as a known hit of the same class. Nothing
  has changed here since round 2 and no new judgement is offered — flagged only
  so a reader of this round does not mistake it for an unnoticed miss.
- **The W1 `watchers` tool defect** belongs to the red-team skill, not this
  branch. Third recurrence.
- **`ci:db-imports` matching only the `db/server` specifier** — noted inside
  RT-8 as context for its severity and now written into the test's own comment,
  not filed as a repo finding.
- **Whether any `warning`-level Sentry capture in this repo is routed** is a
  pre-existing, repo-wide gap explicitly covered by AUTH-1.

---

## Authorizations

*Rendered from `findings.json`'s `authorizations` array — never parsed back out
of this Markdown.*

**AUTH-1** · 2026-08-30 · names **RT-1**

> RT-1's disposition is accepted-risk, owner-authorized 2026-08-30: the routing
> gap is pre-existing, documented in beta-launch-alerting.md, and shared with
> every warning-level capture in the repo. The owner chose to correct the
> overstated claim and add both tags to the pending checklist rather than block
> the PR on a Sentry dashboard action this PR cannot contain.

---

## What the checker will say, and the one thing it will refuse

The sidecar is internally consistent and current: `head_sha` and
`merge_base_sha` are the pinned committed ids, `merge-base(fork_sha, HEAD)`
re-derives to `0494297a…`, `intake_sha256` is the hash of the **current**
`.feature/intake.json`, and the recomputed counts and status match
(`inventory_total: 24`, `killed: 10`, no `inconclusive`, no `skipped-budget`,
`p0_open: 0`, `p1_open: 0`, `p2_open: 0` → **`CLEAR`**).

**One blocker remains, and it is structural rather than evidential.**
`red-team-status.mjs:253` is
`if (sidecar.round !== 1 && sidecar.round !== 2) errors.push('round must be 1 or
2 (hard cap)')`. A sidecar recording `round: 3` — which this one does, honestly
— **fails schema validation** and the `reviewed` transition stays blocked. This
round cannot fix it: red-team may write only these two artifacts, and lowering
`round` to `2` to satisfy the checker would be a false record of exactly the
kind the whole run exists to prevent.

**The owner's decision, not the verifier's.** The two honest options are (a)
amend the cap in `red-team-status.mjs` to admit an authorized third round, with
D26 as its recorded justification, or (b) record an explicit owner override at
the `reviewed` transition. On the evidence itself, the run is **CLEAR**.
