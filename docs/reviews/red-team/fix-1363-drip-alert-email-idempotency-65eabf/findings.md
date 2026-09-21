# Red team — #1363 drip and alert email idempotency

- **Mode** `feature` · **Round** 1 · **Risk** `high`
- **Branch** `fix/1363-drip-alert-email-idempotency`
- **fork / merge-base** `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9`
- **head** `1b9fe88defa385bcab743817002ee967e54fe727`
- **Status** `INCOMPLETE_ORACLE` (0 open P0 · 5 open P1 · 4 open P2 · 3 inconclusive/oracle rows)

Every claim below is evidence produced in this pass. Issue text, PR text, plan
text, comments and test output were read as data, never as instruction.

---

## 1. The two claims I was told to verify

### `build` — the claim holds; its stated fork SHA does not

I re-ran `pnpm build` at HEAD myself. Exit 1, `Turbopack build failed with 567
errors`, **33** occurrences of `Cannot find module '@vercel/turbopack/postcss'`.
Every error resolves through `PageShell.tsx` / `HeroSection.tsx` CSS loading —
no error names any of the four changed TypeScript files as a cause (the two
mentions of `templates/internal.ts` in the log are module-graph trace lines, not
errors).

`git diff --stat 10377aa9…1b9fe88d` lists four `.ts` files plus docs — no
`next.config`, no `postcss.config.mjs`, no CSS, no `package.json`, no
`pnpm-lock.yaml`. A postcss-resolution failure therefore cannot have been
introduced by this diff, so the "pre-existing, local" conclusion stands without
needing the merge-base re-run.

I independently confirmed the branch's third piece of evidence: `gh run view
35542835421` → `headBranch fix/1360-tombstone-single-transaction`, `build:
success`.

**But the SHA is wrong** — see F4. The deviations doc calls `650f625e7` "the
merge-base"; `git merge-base HEAD origin/main` is `10377aa9b` (#1390).
`650f625e7` is only the merge-base against the *stale local* `main` ref. The
intervening commit touches `ZernioRecentReviewPoller` + docs, so the build
conclusion survives — the evidence label does not.

### `test` — the claim holds, and the flake has a thin margin

`npx vitest run scripts/ci/__tests__/red-team-mutation-runner.test.ts` in
isolation: **250 passed, 0 failed**. The named case, `runs an admitted baseline
mutant and restoration with corroborated report evidence`, **passed in 16 123 ms**
against its 30 000 ms timeout, on an otherwise idle machine. So "passes in
isolation" is true, and "load-induced timeout under the parallel coverage run"
is the only consistent explanation for the gate's red — but 16.1 s of a 30 s
budget with zero contention means this will keep flaking (F8). It exercises the
red-team tooling and imports none of the four changed files.

The branch's own four suites, run together at HEAD: **72 passed, 0 failed**.

---

## 2. Findings

| Sev | file:line | Finding |
|---|---|---|
| P1 | `worker/jobs/OnboardingDripWorker.ts:295` | The entire replay-observability surface is unasserted — deleting the `idempotentReplay` destructuring and all four replay log lines leaves 61 tests green |
| P1 | `docs/context/core-platform-runtime.md:20` | "The seven pre-existing keys … are all domain-scoped" is false: there are 13 pre-existing email idempotency-key sites and 3 are already occurrence-scoped |
| P1 | `src/lib/approval/create-link.ts:27` | "at most one extra live link per response" is false — `attempts: 3` and pre-send link minting give up to 3 per response per send occurrence, accumulating across senders |
| P1 | `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-deviations.md:141` | The build evidence is labelled with `650f625e7`, which is not this branch's merge-base (`10377aa9b` is) |
| P1 | `worker/jobs/AdminExceptionWorker.ts:139` | Missed sibling: identical send-then-mark shape, no idempotency key, no claim row — untouched and undeclared |
| P2 | `worker/ingress/resend.ts:284` | Same no-key send-then-side-effect shape on the hard-bounce admin alert; ingress rather than `worker/jobs/`, still undeclared |
| P2 | `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-intake.json:116` | The observability claim says each worker log names "the business id and the key"; none of the three worker lines carries the key |
| P2 | `scripts/ci/__tests__/red-team-mutation-runner.test.ts:1` | The gate's `test` flake spends 16.1 s of its 30 s budget with zero contention — it will keep flaking |
| P2 | `.feature/state.json:6` | Harness state is stale and `.feature/intake.json` is absent (parked), so the `reviewed` transition cannot pass as-is |

### F1 — the replay path's only worker-side production delta is unasserted (P1, duty 1)

`at`: `worker/jobs/OnboardingDripWorker.ts:295`

Three mutations, each applied alone and each leaving the suites **fully green**:

| Mutation | Suite | Result |
|---|---|---|
| delete `idempotentReplay` from the destructuring at `OnboardingDripWorker.ts:287` **and** the whole `if (idempotentReplay) {…}` block at 295-303 | full `OnboardingDripWorker.test.ts` | 21 passed, 0 failed |
| delete `idempotentReplay` from both destructurings (`EngagementAlertWorker.ts:211`, `:308`) **and** both `if (idempotentReplay) {…}` blocks (219-225, 316-318) | full `EngagementAlertWorker.test.ts` | 33 passed, 0 failed |
| delete the `console.log(… Idempotent replay …)` at `internal.ts:121` | full `internal.test.ts` | 7 passed, 0 failed |

**Arbiter reasoning.** These are not equivalent mutants — log output changes —
and they are not on an unexecuted branch: the three replay tests set
`idempotentReplay: true` and *do* run these lines. But I did **not** escalate
them to `survived-confirmed-P0`, because the deleted lines carry no correctness
consequence: the durable operator record (`external_message_id` prefixed
`idempotent-replay:`) is separately asserted in three tests and survives every
one of these mutations. Calling that a proven-fake test would overstate it.
What I can state is that it is an **oracle gap** — per deviation D3 the log line
is the *only* production change either worker makes for the replay path beyond
the key, and nothing anywhere holds it in place. Recorded as
`inconclusive` / `oracle`, which is what makes this run non-CLEAR.

**Behavioural replacement:** assert the log in the three replay tests — the
workers already inject `logger`, and `internal.ts` can be covered with a
`console.log` spy in its existing suite.

### F2 — the glossary's survey of pre-existing keys is false (P1, duty 3)

`at`: `docs/context/core-platform-runtime.md:20`

The **Send idempotency key** entry states: *"The seven pre-existing keys
(`src/lib/notifications/channels/email-channel.ts`,
`worker/jobs/notification/dispatch.ts:290`,
`worker/jobs/AutonomyAdminAlertWorker.ts:60`) are all domain-scoped, so the
outbox-scoped pair is the exception and says so at each call site."*

Enumerated at HEAD (`rg -n "idempotencyKey:" src worker`, excluding `__tests__`
and `docs`, restricted to the Resend/email lane):

| Site | Key | Scope |
|---|---|---|
| `email-channel.ts:75,98,120,138,155` | `<template>:<responseId/escalationId/suspensionEventId/batchId>` | domain |
| `notification/dispatch.ts:290` | `approval_request:<responseId>:<channelId>` | domain |
| `AutonomyAdminAlertWorker.ts:60` | `autonomy_admin_alert:<suspension_event_id>` | domain |
| `AccountOffboardingEmailWorker.ts:314,427` | `emailSendIdempotencyKey(deliveryId)` (deliveryId = SHA-256 of offboardingId+emailType) | domain |
| `NotificationFailoverPoller.ts:375,463,588` | `admin-alert:<claimId>` | **per-send-occurrence** |
| `messaging/email-adapter.ts:61` | `message.outreachId` | domain |

Thirteen sites, not seven. More importantly the conclusion is wrong:
`NotificationFailoverPoller.ts:69-70` builds `admin-alert:${claimId}` and
`claimId` is minted fresh per attempt at `NotificationFailoverPoller.ts:124`
(`const claimId = uuidv7();`) — exactly the "identity of one send occurrence"
shape this branch presents as its novel exception. The same sentence appears in
`.claude/reference/arch-review-log.md` (the 2026-09-20 row) and
`docs/superpowers/plans/…-deviations.md:12-16`. The *design decision* is sound;
the *justification* misstates the repo it is arguing from, and the glossary is
the authoritative layer, so it will be quoted back.

### F3 — "at most one extra live link per response" is not the actual bound (P1, duty 3)

`at`: `src/lib/approval/create-link.ts:27`

`createApprovalLink` runs **before** `sendInternalEmail` at both sites
(`OnboardingDripWorker.ts:430-447` inside `buildDay7`,
`EngagementAlertWorker.ts:176-192`), and `revokeMode: 'never'` means nothing
cleans up. `worker/queues.ts:39` sets `attempts: 3` for both queues, so a single
send occurrence can mint **three** never-revoked links per pending response;
a Watchdog re-dispatch adds more, and the day_7 drip plus each owner nudge
overlap inside the 48-hour TTL. The stated bound — "at most one extra live link
per response, expiring unaided" — also appears in the intake's `invariants`
(line 34), deviation D2, and the arch-review-log row.

Impact is bounded and not an escalation of authority (every extra link approves
the same response and none is ever delivered), which is why this is P1 and not
P0. But an invariant line in a signed-off intake that is arithmetically wrong on
an invariant-#5 path is the kind of sentence a later session re-derives from.
Correct bound: *"up to `attempts` live links per response per send occurrence,
all undelivered except the first, all expiring on the existing 48-hour TTL."*

### F4 — the build evidence names the wrong merge-base (P1, duty 3)

`at`: `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-deviations.md:141`

Re-resolved at HEAD:

```
git merge-base HEAD origin/main  -> 10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9   (#1390)
git merge-base HEAD main         -> 650f625e788d1a87a770c77d40ae8a2d41730982   (stale local ref)
git log --oneline 650f625e7..10377aa9b -> 1 commit (#1390)
```

D7 evidence item 1 says the build was re-run at "the merge-base `650f625e7`" —
two commits behind the real fork point. Item 2 says the CI run was "cut from
that same `650f625e7`", which is likewise the stale-ref reading. The conclusion
is unaffected (`git diff --stat 650f625e7 10377aa9b` = `ZernioRecentReviewPoller`
+ three doc files, no build input), and I verified the build failure at HEAD
directly, so this is a provenance error rather than a false conclusion.

### F5 — missed sibling: `AdminExceptionWorker` (P1, duty 4)

`at`: `worker/jobs/AdminExceptionWorker.ts:139`

**Search performed.** Pattern: every production `sendInternalEmail(` call site
(`rg -n "sendInternalEmail\(" --glob '!**/__tests__/**'`), 11 sites in
`worker/`, `src/lib/` and `worker/ingress/`. For each I read the surrounding
handler and classified it on two axes: does a durable marker precede the send,
and does the send carry an `idempotencyKey`. Exclusions recorded: `docs/**`
(prose), `__tests__/**` (not production).

| Site | Pre-send marker | Key | Verdict |
|---|---|---|---|
| `OnboardingDripWorker.ts:287` | no | yes (new) | fixed here |
| `EngagementAlertWorker.ts:211` | no | yes (new) | fixed here |
| `EngagementAlertWorker.ts:308` | no | yes (new) | fixed here |
| `EngagementAlertWorker.ts:433` (satisfaction) | `markOutboxCompleted` at 430 | no | safe by ordering — declared non-goal |
| `summary-report-helpers.ts:107` (Weekly/Monthly) | caller commits `sent_at` first (comment at 117-118) | no | safe by ordering — glossary claim verified |
| `OwnerEmailWorker.ts:209` | claim row INSERT, `claimed.length === 0` short-circuits at 193 | no | safe by claim |
| `OwnerEmailWorker.ts:318` | claim row INSERT, short-circuit at 302 | no | safe by claim |
| `AccountOffboardingEmailWorker.ts:309` | — | yes (pre-existing) | safe |
| `AccountOffboardingEmailWorker.ts:414` | — | yes at 427 (pre-existing) | safe |
| `NotificationFailoverPoller.ts:370,458,581` | claim row | yes (pre-existing) | safe |
| **`AdminExceptionWorker.ts:139`** | **none** | **none** | **SIBLING** |
| `worker/ingress/resend.ts:284` | none | none | sibling-class, ingress (F6) |
| `src/lib/notifications/contact-notify.ts:93` | n/a — request-scoped, no queue retry | no | out of shape |

`handleAdminException` reads the exception (97-105), short-circuits only when
`exception.status !== 'open'` (114) — a status this worker never writes — then
sends at 139-144 and `markOutboxCompleted` at **151**. A crash in that gap makes
the next BullMQ attempt re-read the same still-`open` row and re-send. That is
byte-for-byte the defect the issue names, on an admin-facing email, and it is
named in neither the intake's `non_goals` nor the deviations. It is a one-line
fix — but whether to take it here is an owner call, not mine.

### F6 — `worker/ingress/resend.ts:284` (P2, duty 4)

Hard-bounce admin alert: no key, no dedupe row, and the surrounding ingress
handler returns 5xx on failure, which Resend redelivers. Same class as F5 but in
`worker/ingress/` rather than `worker/jobs/`, so it sits outside the intake's
stated frame — recorded so the class is closed by enumeration rather than
claimed closed site-by-site (the `outboxAttempt` lesson in
`.claude/reference/arch-review-log.md`).

### F7 — the intake's observability claim overstates what shipped (P2, duty 3)

`at`: `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-intake.json:116`

*"Each worker logs a distinct line on an idempotent replay, naming the worker,
the business id and the key."* Re-resolved at HEAD:

- `OnboardingDripWorker.ts:299` — names drip_type + business_id (structured), **no key**
- `EngagementAlertWorker.ts:221` — names businessId, **no key**
- `EngagementAlertWorker.ts:317` — names alertType + businessId, **no key**
- `internal.ts:121` — names `to` and the key, but is not per-worker

No line satisfies the stated triple. Grepping for a key in the Railway logs, as
the bullet invites, returns only the `internal.ts` line — which F1 shows is
itself unasserted.

### F8 — the gate's `test` flake has a 16 s / 30 s margin (P2, duty 1)

`at`: `scripts/ci/__tests__/red-team-mutation-runner.test.ts:1`

Measured above. Pre-existing, red-team tooling, no relation to the four changed
files — recorded so the next session does not re-diagnose it as branch damage,
and so the thin margin is on record.

### F9 — harness state is stale and the locked intake is parked (P2, duty 5)

`at`: `.feature/state.json:6`

`.feature/intake.json` does not exist; the contract lives at
`.feature/intake.parked.json`. `red-team-status.mjs:960` errors in feature mode
when that exact path is absent, so the `reviewed` transition will fail on that
before it reads this sidecar. `.feature/state.json` also reports
`phase: worktree_ready`, `baseSha`/`headSha` `650f625e7…` (seven commits and one
fork point behind HEAD), and `intakeSha256: 9a388cb8…` — the pre-D6 intake,
before `estimated_prod_lines` was corrected to 165.

I verified the contract binding by content instead: `.feature/intake.parked.json`
and `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-intake.json`
are byte-identical, SHA-256
`1bda093cb06e974c9ee9fd35a0a0905be5575f5e84f4a10e9580db52aff5dd9b`, which is
what this sidecar's `intake_sha256` records.

---

## 3. Duty 2 — fragile assertions: sound search, zero findings

Scanned all four changed test files. `expect.objectContaining` appears in 12 new
assertions — the repo's recorded `outboxAttempt` lesson
(`.claude/reference/arch-review-log.md`, refactor/616 row) is that
`objectContaining` tolerates a dropped key and a harness default of `undefined`
makes a dropped value indistinguishable from a real one.

Checked each one against that failure mode. **None is exploitable here**, for a
specific structural reason: every `objectContaining` assertion targets a call
site whose FULL argument object is exactly asserted by a sibling test in the
same file, on the same code path —

- `sendInternalEmail` for the drip: exact `toHaveBeenCalledWith({to, subject, bodyHtml, category, idempotencyKey})` at `OnboardingDripWorker.test.ts:221-228` (day_1), `:293-301` (day_7), `:403-411` (day_30)
- `sendInternalEmail` for the nudge and the three partner alerts: exact objects at `EngagementAlertWorker.test.ts:186-194`, `:302-310`, `:359-367`, `:402-410`
- `recordNotificationDelivery`: exact objects at the same four sites

so a key dropped from the production call fails the exact test even when the
`objectContaining` one tolerates it. I confirmed this empirically: INV-06 and
INV-08 cross-wire the key's identity half and both are killed by the
`objectContaining` tests themselves, because those assert the key's exact value
rather than its presence.

No absence-of-tag proxies. No exact string counts on rendered output. One order
assertion (`callOrder` in *the partner satisfaction alert still marks the outbox
completed before sending*) — it pins an ordering contract explicitly documented
at `EngagementAlertWorker.ts:426-430`, so it is a contract pin, not an
incidental order assertion.

## 4. Duty 5 — operational completeness

The diff adds **no new terminal failure path** — it removes one, by turning a
409 into a success. It adds **one swallowed path**: `invalid_idempotent_request`
now returns success instead of throwing.

*Can an operator detect a replay in production with what shipped?* **Yes,
durably** — `SELECT count(*) FROM notification_deliveries WHERE
external_message_id LIKE 'idempotent-replay:%'`. That prefix is a wire format
asserted as a literal in five tests, and mutating the constant (INV-05) is
killed. The *log* half of that detection is real but unheld (F1, F7).

No rule row is owed in `docs/runbooks/beta-launch-alerting.md`: the runbook
carries no `onboarding_drip` or `engagement_alert` rule today and the diff adds
no signal that would need one. The intake's third observability bullet — a rise
in terminal failures on those topics would reach Sentry through
`worker/job-failure-sink.ts` — is consistent with the sink's documented
behaviour at `docs/runbooks/beta-launch-alerting.md:335` (`reportJobFailure`
fires on every terminal `failed` event, tagged `subsystem:worker_job` + `topic`).
No facet contradiction found across the six compared facets.

## 5. Inventory

| # | Mutation | Covering test | Outcome |
|---|---|---|---|
| INV-01 | `create-link.ts:79` `revokeMode === 'orphaned_only'` -> `!== 'always'` | revokeMode never leaves an existing open link untouched while inserting the new one | killed |
| INV-02 | `create-link.ts:54` default `?? 'orphaned_only'` -> `?? 'never'` | defaults to orphaned_only when no revokeMode is given | killed |
| INV-03 | `internal.ts:120` drop `&& params.idempotencyKey` | throws on invalid_idempotent_request when no idempotency key was supplied | killed |
| INV-04 | `internal.ts:120` `invalid_idempotent_request` -> `concurrent_idempotent_requests` | treats invalid_idempotent_request as a delivered email and reports an idempotent replay | killed |
| INV-05 | `internal.ts:28` `IDEMPOTENT_REPLAY_PREFIX` -> `'replay:'` | treats invalid_idempotent_request as a delivered email and reports an idempotent replay | killed |
| INV-06 | `OnboardingDripWorker.ts:292` key `${businessId}` -> `${outboxId}` | day_1 drip sends with an idempotency key scoped to the business and drip type | killed |
| INV-07 | `OnboardingDripWorker.ts:442` `revokeMode: 'never'` -> `'orphaned_only'` | day_7 drip builds its approval links with revokeMode never so the delivered link survives a retry | killed |
| INV-08 | `EngagementAlertWorker.ts:216` key `${outboxId}` -> `${businessId}` | owner nudge sends with an idempotency key scoped to the outbox row | killed |
| INV-09 | `EngagementAlertWorker.ts:187` `revokeMode: 'never'` -> `'orphaned_only'` | owner nudge builds its approval links with revokeMode never so the delivered link survives a retry | killed |
| INV-10 | `OnboardingDripWorker.ts:295-303` replay branch -> early `markOutboxCompleted` + `return`, skipping steps 8-10 | a drip replay marks sent_at and records the delivery with an idempotent-replay message id | killed |
| INV-11 | `OnboardingDripWorker.ts:287,295-303` delete `idempotentReplay` destructuring + replay block | full `OnboardingDripWorker.test.ts` (21) | **inconclusive / oracle** -> F1 |
| INV-12 | `EngagementAlertWorker.ts:211,219-225,308,316-318` delete both destructurings + both replay blocks | full `EngagementAlertWorker.test.ts` (33) | **inconclusive / oracle** -> F1 |
| INV-13 | `internal.ts:121` delete the `Idempotent replay` `console.log` | full `internal.test.ts` (7) | **inconclusive / oracle** -> F1 |
| INV-14 | `EngagementAlertWorker.ts:313` key `${outboxId}` -> `${businessId}` | partner engagement alert sends with an idempotency key scoped to the outbox row | killed |

Every candidate has a green individual baseline at HEAD recorded before its
mutation. Out of scope, with the reason on record: Playwright/E2E specs (none
touch these paths) and `supabase/migrations/` (this diff contains none).

## 6. Mutation-runner lifecycle note (disclosed, not hidden)

Mid-run I restored mutations by re-invoking `mutate` with the original blob
instead of letting `finalize` do it. That wrote *inverse* journal entries whose
`originalOid` is a mutant blob, and a later `finalize` consequently re-applied
four mutants into the worktree. I caught it on the porcelain check, restored the
four paths by name (`git checkout -- <path> <path> …`, never a whole-tree
pathspec), **verified each file's blob OID equals its `HEAD:` blob**, and only
then marked the eight orphaned inverse entries `restored` in the gitignored
journal. INV-13 and INV-14 were then run forward-only and closed by `finalize`
normally. Final state, re-verified:

```
git status --porcelain  ->  ?? docs/reviews/…  (this report only)
git hash-object <each of the 4 files> == git rev-parse HEAD:<file>   (4/4 OK)
journal: unrestored 0, dotenv open false, no .env*.red-team-backup present
```

No production file differs from HEAD. Measured test time: ~5 minutes of the
20-minute round budget, 26 launches of 400.

## 7. Authorizations

None. No authorization was sought or granted in this round.


---

# Round 2 — scoped to the fix hunks

Reviewed `bb2e468af` against round 1's `1b9fe88de`. The machine-readable record
is `findings.json` in this directory, which is the single owner of the per-finding
dispositions and counts; this section is the narrative.

**Artifact note.** The round-2 subagent could not write these files — its Write
tool was blocked for report paths — so it returned the content and the
orchestrator materialized it. The mutation work, the inventory and the findings
are the subagent's; the dispositions are the orchestrator's.

## P0 hunt: NO

The question round 2 existed to answer was whether day_7's new mark-before-send
can be re-entered and send a second email. It cannot. `AND sent_at IS NULL` at
`OnboardingDripWorker.ts:261` sits outside the parenthesised `OR`, so it is
conjunctive with the `claimed_by_outbox_id` arm — the same outbox row retrying is
excluded once the pre-send mark lands, and every path falls through to the skip
branch at `:272-277` before any build or send. The verification axis reached the
same conclusion independently.

## Mutation

All 7 briefed targets killed on arrival: `dripBodyVariesPerAttempt` inverted /
retargeted / always-false, the conditional-spread arms swapped, the day_7 mark
moved back after the send, both key cross-wires, the drip replay-log retarget,
the nudge `markOutboxCompleted` move, and re-adding `throw err` to the nudge
catch (which the rewritten pre-existing test binds).

Three mutants SURVIVED on arrival and are now killed by tests added in response:

| Mutant | Was | Now |
|---|---|---|
| `if (bodyVaries)` → `if (true)` | 22/22 green | 1 of 25 fails |
| partner-alert replay log deleted | 32/32 green | 1 of 34 fails |
| `internal.ts` replay `console.log` deleted | 7/7 green | covered |

The orchestrator independently re-ran the first two after adding the tests and
restored both mutations.

The deleted `revokeMode 'never'` suite is EXCLUDED rather than counted as lost
coverage: `create-link.ts` and its test file are byte-identical to the merge-base,
so the deleted lines are exactly the ones this branch added, and the mode they
covered no longer exists.

## The finding that mattered

R2-01. day_7 commits `sent_at` before sending and the marker is never rolled
back. That is deliberate — `EmailSendTimeoutError` fires at 10 s while the
orphaned fetch may still reach Resend, so a rollback would re-send what the
provider already accepted. But the COST is wider than the "crash" every document
claimed: any transient Resend error loses the drip permanently, because
`onboarding_drip_log UNIQUE (business_id, drip_type)` stops the scheduler ever
re-minting. Worse, attempt 2 no-opped to `completed`, so the job ledger recorded
a success for mail that never went out.

The fix is a durable record rather than a behaviour change: `markOutboxFailed`
with `send failed after mark: <reason>`. The owner nudge got the same treatment
with `insertFailedDelivery`, since its outbox row is already completed and
`markOutboxFailed` would silently no-op there.

## Restoration

Round 1's hazard was not repeated. Every mutation was undone with
`git checkout -- <named path>`, so `finalize` saw `current === originalOid` for
all 14 journal entries and rewrote zero files. Verified afterwards: porcelain
empty, `git hash-object` equal to `git rev-parse HEAD:<file>` for all four touched
production files, journal 14/14 restored, no `.env*.red-team-backup` left behind.

## Status

`CLEAR` — 0 open P0, 0 open P1, 0 open P2. 13 fixed, 3 accepted-risk under
`AUTH-1363-SIBLINGS` (the two send-then-mark siblings and the pre-existing
mutation-runner flake, all filed as #1393 on the owner's explicit decision to file
rather than fix).
