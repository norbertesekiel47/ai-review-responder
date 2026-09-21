# Round 2 — verification-only review of the #1363 rework

Read-only pass. Fork pinned:

| Ref | SHA |
|---|---|
| merge-base | `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9` |
| reviewed in round 1 | `1b9fe88defa385bcab743817002ee967e54fe727` |
| current HEAD | `bb2e468af3e7fc738abd9e90e6e803df0552b15c` |

Fix diff verified: `git diff 1b9fe88de..HEAD` (20 files, +2192/−264).
Working tree clean at the end of the pass (`git status --porcelain` empty;
`md5 worker/jobs/OnboardingDripWorker.ts` == `git show HEAD:…` blob md5 =
`c76db2b4b47e983591498dbd35a44da2`).

Scope rule honoured: the findings table covers only (a) round-1 fixes that did
not land and (b) defects the fixes introduced. Everything else is in the
appendix.

---

## Verdicts

| # | Item | Verdict |
|---|---|---|
| 1 | F1 — no body-varying send carries a key; predicate correct and complete | **PARTIAL** — core fix VERIFIED; the residual enumeration is incomplete (R4, R5) |
| 2 | F2 — owner nudge must not rethrow; swallow cannot mask a retryable class | **VERIFIED** (with the observability caveat in R3) |
| 3 | F2 follow-on — no claim arm can re-enter and send a second day_7 | **VERIFIED** (see R1 for the loss class, R8 for the test gap) |
| 4 | F4/F8 — `src/lib/approval/` byte-identical to merge-base | **VERIFIED** by git |
| 5 | F5 — every remaining key is domain-scoped and cannot collide in 24h | **VERIFIED** |
| 6 | F3 — the replay-log test has a real oracle | **VERIFIED** by mutation; tree restored clean |
| 7 | F6/F7/F9/F10/F11 — corrected documentation claims are now true | **PARTIAL** — every cited line:number resolves, but five claims are still false or overstated (R2, R3, R4, R5, R6) |

`pnpm ci:weakened-checks` → `weakened-checks-audit: passed (no finding)`.
**Zero REVIEW rows**, same as round 1.

`pnpm vitest run` over the intake's four suites at HEAD: **4 files, 68 tests,
all passing.**

---

## 1. F1 — every `sendInternalEmail` call, classified

Enumerated with `rg -n "sendInternalEmail\(" --glob '!**/__tests__/**' worker/ src/`
(16 call sites + the definition), cross-checked against `rg -n "idempotencyKey"`.

### Sites changed by this branch

| Site | Key | Body across attempts | Correct? |
|---|---|---|---|
| `worker/jobs/OnboardingDripWorker.ts:331` day_1 | `onboarding_drip_day_1:<biz>` | stable-ish — see R5 | ✔ with unnamed residual |
| …day_7 | **none** (`bodyVaries` ⇒ `{}` at :336) | varies — `createApprovalLink` mints `randomUUID` per call (`create-link.ts:37`) | ✔ |
| …day_30 | `onboarding_drip_day_30:<biz>` | varies with live stats — **named** residual at :118-121 | ✔ residual stated |
| `worker/jobs/EngagementAlertWorker.ts:219` owner nudge | **none** | varies (fresh tokens at :176-181) | ✔ |
| `…:340` partner ×3 | `<alert_type>:<biz>` | mostly stable — see R4 | ✔ with unnamed residual |
| `…:465` satisfaction | none (unchanged) | n/a | ✔ |

`dripBodyVariesPerAttempt` (`OnboardingDripWorker.ts:123-125`) returns
`dripType === 'day_7'`. It is **correct** — day_7 is the only drip that calls
`createApprovalLink` (`:477`) — and **complete** over the three members of
`OnboardingDripPayload['drip_type']` (`DRIP_DAY_OFFSETS`, :63-67). A fourth drip
type would have to opt in explicitly, which is the right default direction
(new type ⇒ keyed ⇒ needs a stability argument), though nothing forces the
author to make it.

**day_30 really is the *most* variable of the keyed sends** — `buildDay30`
re-reads review counts (:528-543), `ranking_snapshots` (:563-573) and the
`onboarded_by` sign-off (:595-600) on every attempt. The residual is stated at
`:118-121` and in `intake.edge_cases[1]`, and both state it accurately
("day_30 reads its stats per attempt … needs a crash AND a same-window stats
change. Accepted, not defended"). It is **not the only one** — see R4 and R5.

### Pre-existing keyed callers that inherit the new 409-as-success branch (F6)

Three files, six call sites:

- `worker/jobs/AutonomyAdminAlertWorker.ts:55-61` — body is built entirely from
  the job payload (`account_id`, `suspension_event_id`, `trigger`, `evidence`,
  :47-52). **Stable.** Benign.
- `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:309,414` —
  the keep-my-data token comes from `createKeepMyDataRawToken({accountOffboardingId,
  deliveryId})` (`:573-575`), which is **deterministic**, not `randomUUID`; the
  purge receipt reads a payload snapshot with an explicit "a retry has to render
  the same number" comment (`:421-428`). **Stable.** Benign.
- `worker/background/pollers/NotificationFailoverPoller.ts:370,458,581` — key is
  `adminAlertIdempotencyKey(claimId)`, a **per-attempt claim id**, so the same key
  is never submitted twice and the 409 branch is unreachable regardless of body.
  Benign, but for a different reason than the triage states (appendix A3).

So F6's conclusion holds. No send whose body can vary between attempts carries a
key **anywhere in the repo** after this change.

## 2. F2 — the owner-nudge swallow

`EngagementAlertWorker.ts:215` completes the outbox row, `:218-240` sends inside
a `try` and returns from the `catch` without rethrowing. What can reach that
catch:

| Throw | Swallow correct? |
|---|---|
| `EmailSendTimeoutError` (`send-email.ts:18-23`, 10s default) | **Yes.** The file's own header says "the awaiter stops waiting … any orphaned fetch completes on its own" — the email may well be delivered, so a retry is exactly the duplicate this ordering prevents. |
| `Error('Resend API error: …')` (`internal.ts:127`) | Yes for the duplicate-safety goal. But the nudge is then permanently lost for this outbox row; recovery depends on `EngagementMonitorPoller` re-minting (owner_nudge cooldown 3 days, and the cooldown probe reads `notification_deliveries`, which has no row — so the next cycle can re-mint). |
| `Error('RESEND_FROM_EMAIL not configured')` (`internal.ts:73`) | Unreachable in practice — `:117-122` already guards it via `getWorkerConfig()`. |
| `getResend()` throwing on an unset API key | Swallowed. Config faults elsewhere in this handler (`NEXT_PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`) mark the row **failed** so an operator sees them; this one becomes a log line on a row that reads completed. Bounded by the poller re-mint. |

No class that *should* have retried is masked in a way that loses correctness —
every masked class is one where a retry risks a duplicate. The cost is
observability, not safety, and that cost is understated by the precedent the
comments cite (**R3**).

## 3. F2 follow-on — can a day_7 retry re-send? (the key question)

Walked the three-way claim at `OnboardingDripWorker.ts:243-278`.

Attempt 1 for day_7: INSERT arm (`:244-249`) succeeds with `sent_at = NULL`,
`claimed_by_outbox_id = <outboxId>`. Build (`:294`). `bodyVaries` ⇒ **`UPDATE …
SET sent_at = NOW()` at `:317-319`, before the send.** `sendInternalEmail`
(`:331`) throws; nothing catches it; the handler throws; BullMQ fails the job
and retries.

Attempt 2, **same outbox row, same `outboxId`** (`extractOutboxHandle(job.data,
job.id!)`, `:132`, reads `job.data.outbox_id` which is unchanged):

| Arm | Reached? | Why |
|---|---|---|
| INSERT (`:244-249`) | no | `ON CONFLICT (business_id, drip_type) DO NOTHING` — the row exists; `inserted` is `undefined` |
| **own-outbox takeover** (`claimed_by_outbox_id = ${outboxId}`, `:263`) | **no** | the disjunction at `:262-265` is **conjoined** with `AND sent_at IS NULL` at `:261`, in the same `WHERE`. `sent_at` is now `NOW()`, so the predicate is false for **both** disjuncts. `taken` is `undefined`. |
| stale takeover (`claimed_at < NOW() - 15 min`, `:264`) | no | same `sent_at IS NULL` conjunct |
| else branch (`:272-277`) | **yes** | logs "already claimed/sent", `markOutboxCompleted`, `return` — **before any build or send** |

**No arm can re-enter and send a second day_7 email.** The
`claimed_by_outbox_id = ${outboxId}` arm the brief singles out is safe *precisely
because* `sent_at IS NULL` is outside the parentheses — a refactor that moved it
inside the `OR` would reopen the duplicate. That predicate placement is
load-bearing and untested (R8).

Sibling checks: a throw **before** the `sent_at` UPDATE (e.g. `buildDay7`
raising at `:473` on a missing `NEXT_PUBLIC_APP_URL`) leaves `sent_at NULL`, so
the own-outbox arm correctly re-enters and sends — no email was sent yet. A
failure of the `sent_at` UPDATE itself also precedes the send. Both fine.

The defect this exposes is not a duplicate but a **loss** — see R1.

## 4. F4/F8 — approval surface reverted

```
$ git diff --stat 10377aa9b..HEAD -- src/lib/approval/
(no output)
```

`src/lib/approval/create-link.ts` and
`src/lib/approval/__tests__/create-link.test.ts` are byte-identical to the
merge-base. The whole-branch `src/` diff is now only
`notifications/email/templates/internal.ts` + its test. Invariant #5 leaves the
risk surface, as D9 claims. The `docs/directory/lib-reviews-responses.md` row
for `create-link.ts` is correspondingly reverted to the `main` text.

F8 is moot by construction — the claim it disproved no longer exists anywhere.

## 5. F5 — key scope vs. cooldowns

Keys after the rework: `onboarding_drip_<type>:<business_id>` (`:336`) and
`<alert_type>:<business_id>` (`:345`). Both domain-scoped; no outbox id survives
anywhere (`rg "outbox-ea-1'" ` over the key assertions in the test files now
returns only the `markOutboxCompleted` arguments).

Cooldowns re-derived from source, not from the prose —
`worker/background/pollers/EngagementMonitorPoller.ts:30-36`:

```
owner_nudge: 3, partner_engagement_alert: 7,
partner_escalation_alert: 14, partner_low_engagement: 7   // days
```

Minimum gap between two legitimate sends of the same `(alert_type, business_id)`
is **7 days** for the three keyed alerts (owner_nudge is 3 days but carries no
key). Resend's key lifetime is 24 hours. No collision is reachable. The
`EngagementAlertWorker.ts:319-327` comment states this with the right numbers
("7 days for engagement and low_engagement and 14 for escalation"); the glossary
states the full set "3/7/14". Both resolve.

For the drip, `onboarding_drip_log` carries `UNIQUE (business_id, drip_type)`
(implied by the `ON CONFLICT` target at `:247`), so a given `(business, drip
type)` is sent at most once, ever — a legitimate second send under the same key
does not exist at all. The takeover path (`:257-267`) is precisely the case the
domain scope defends, and `a drip taken over by a second outbox row reuses the
same idempotency key` (`OnboardingDripWorker.test.ts:591`) pins it.

## 6. F3 — mutation of the replay log line

Mutated `OnboardingDripWorker.ts:343` from
`` `${drip_type} already delivered under its idempotency key` `` to
`` `${drip_type} MUTATED replay marker XYZZY` `` and ran both worker suites:

```
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 53 passed (54)
× OnboardingDripWorker – Send idempotency key >
    a drip replay logs that the email was already delivered
    AssertionError: expected false to be true  (test file :638)
```

**Exactly one test failed, and it is the new one.** Restored via `Edit`;
`git status --porcelain` empty, working-file md5 equals the HEAD blob md5.

The other new oracle is also real: `day_7 drip marks sent_at before sending and
passes no idempotency key` (`:539`) collects the `sql` tag-template text at send
time and asserts `/UPDATE onboarding_drip_log SET sent_at/` is already among
them — moving the mark after the send fails it.

## 7. F6/F7/F9/F10/F11 — re-resolving every citation

All of these resolve at HEAD:

| Claim | Cited at | Resolves? |
|---|---|---|
| bounce correlation on the real Resend id | `worker/ingress/resend.ts:229-246` (plan, arch log) | ✔ `SELECT … WHERE external_message_id = ${emailId}` at `:232-236`, `UPDATE` at `:238-242` |
| cooldowns 3/7/14 days | `EngagementMonitorPoller.ts:30-35` (glossary ×2, worker comment, D11) | ✔ `COOLDOWNS` at `:30-36` |
| fresh token per call | `create-link.ts:37` (plan fact 4) | ✔ `const rawToken = randomUUID();` |
| `dripBodyVariesPerAttempt` names the rule | glossary `:20` | ✔ `OnboardingDripWorker.ts:123` |
| `AdminExceptionWorker` identical shape, guard can never fire | `:138-150`, `:114` (D13, triage F12) | ✔ send at `:139`, guard `exception.status !== 'open'` at `:114`; no `UPDATE review_exceptions … SET status` exists in `src/` or `worker/` |
| same shape on the hard-bounce admin alert | `worker/ingress/resend.ts:284` (D13) | ✔ |
| replay is a FLOOR not a total | glossary `:21`, intake `observability[0]`, arch log | ✔ correct — an identical-body replay returns the original 2xx |
| 24h key life is reachable | intake `edge_cases[9]` | ✔ now stated as a bound, not a guarantee |
| build evidence SHA | D7 | ✔ merge-base `10377aa9b` used throughout |
| `CONTEXT-MAP.md` lists both coined terms | | ✔ |
| directory rows | `lib-reviews-responses.md`, `lib-notifications-channels-messaging.md` | ✔ one reverted, one accurate |

Five claims do **not** hold — R2, R3, R4, R5, R6 below. Four of the five were
written or left standing by the rework itself, which is the same class of defect
F6/F7/F9/F10 named in round 1.

## Deleted tests — is the protection loss legitimate?

| Deleted | Legitimate? |
|---|---|
| the whole `revokeMode: 'never'` suite in `src/lib/approval/__tests__/create-link.test.ts` (−95 lines) | **Yes.** The file is byte-identical to the merge-base, so the deletion is exactly the revert of the additions; the code under test no longer exists. |
| `an owner nudge replay records the delivery with an idempotent-replay message id` (EngagementAlert suite) | **Yes.** The nudge now passes no key, so `internal.ts:120` (`&& params.idempotencyKey`) makes the replay branch unreachable for it. Keeping the test would have pinned a path the code cannot take. |
| `owner nudge builds its approval links with revokeMode never…` / `day_7 drip builds its approval links with revokeMode never…` | **Yes** — rewritten, not dropped, to assert `orphaned_only`. |
| `throws on email send failure (BullMQ retries)` | **Rewritten, not dropped**, into `swallows an owner-nudge send failure so BullMQ cannot retry into a duplicate`, which asserts the new contract *and* that the outbox was completed. This is the test that caught D10; it stays load-bearing. |

No test was dropped to get green.

---

## Findings

| # | Sev | Location | Finding |
|---|---|---|---|
| R1 | medium | `worker/jobs/OnboardingDripWorker.ts:311-320`, `:272-277`; `intake.user_visible_behavior[1]`; plan REVISED table | Mark-before-send loses the day_7 drip on **any** send error, not just a crash: a transient Resend 5xx or `EmailSendTimeoutError` throws with `sent_at` already committed, the retry exits on the claim and marks the outbox **completed**, and the scheduler can never re-mint (`UNIQUE(business_id, drip_type)`). At the merge-base the same transient error retried and delivered. Every artifact frames the loss as "a crash between here and Resend accepting" / "in this narrow window", which understates the loss class; the outbox also records success for an email never sent. |
| R2 | medium | `src/lib/notifications/email/templates/internal.ts:107-109` | Comment introduced by this branch and **not corrected by the rework**: "It is the NORMAL retry path for the day_7 drip and the owner nudge: `createApprovalLink` mints a fresh token per attempt, so their bodies differ every time." Neither carries a key any more, so neither can ever reach that branch. This is the exact F1 reasoning stated inverted, inside the module the F1 fix is about. |
| R3 | low/medium | `worker/jobs/EngagementAlertWorker.ts:232`; `docs/context/core-platform-runtime.md:20`; deviations D10 | The cited precedent for the nudge's swallow is wrong. `WeeklySummaryWorker` does **not** complete its outbox before sending (`WeeklySummaryWorker.ts:390` send → `:408` complete) and `sendSummaryReportEmail` calls `markOutboxFailed` in its catch (`summary-report-helpers.ts:114-119`). The nudge cannot — its row is already completed — so an owner-nudge send failure leaves **no durable record at all** (outbox reads completed, no delivery row, log line only). The real precedent is `handleSatisfactionAlert` in the same file (`:459-470`), which the `:209-214` comment already names. |
| R4 | low | `worker/jobs/EngagementAlertWorker.ts:334-336` | "This alert's body is built from the job payload's metrics, so it is byte-stable across attempts" overstates. `businessName`, `ownerEmail` and `ownerPhone` (`:280-288`, `:293-301`, `:307-313`) come from the per-attempt DB read at `:42-48`. A rename or phone edit inside the 24h window puts a keyed partner alert on the 409 path. Harm is bounded (admin recipient), but it is an unnamed residual. |
| R5 | low | `worker/jobs/OnboardingDripWorker.ts:116-118` | "day_1 and day_30 render from stable inputs" — day_1's body carries `dashboardUrl`, derived per attempt from a live owner-`auth_id` probe (`summary-report-helpers.ts:231-249`). An owner completing auth between attempts flips it `null` → URL, changing the body. Same 409 class as the day_30 residual, unnamed. With R4 this means day_30 is **not** the only residual, contrary to `:118-121`. |
| R6 | low | plan `-plan.md` "Design record" row for `createApprovalLink`, "Facts" #4 and #5; `intake.test_seams[1]`, `intake.existing_patterns_to_follow[3]` | Stale claims describing the **reverted** T2 survive the rework. Fact #4 ("The 409 path is their NORMAL retry path, not an exception") directly contradicts the REVISED table a few lines above it. The REVISED header only declares "the tracers below" historical; these sections sit between it and the tracers, so nothing marks them stale. |
| R7 | low | `worker/jobs/__tests__/OnboardingDripWorker.test.ts:575-581` | The `Send idempotency key` describe-block header still asserts, unqualified, "The handler sends, THEN marks sent_at" — false for day_7 since the fix. |
| R8 | low | `worker/jobs/__tests__/OnboardingDripWorker.test.ts` (no such test); `onboarding-drip.integration.test.ts` | Nothing pins the F2 follow-on behaviour verified in §3. The unit harness mocks `sql`, so the load-bearing `AND sent_at IS NULL` conjunct at `OnboardingDripWorker.ts:261` is untested, and the live-DB suite has no day_7 re-entry case. Moving that conjunct inside the `OR` at `:262-265` would restore the duplicate-send bug with the suite fully green. |

---

## Appendix — out of scope (unchanged code / process notes)

**A1 — concurrent mutation activity on this worktree.** Between 17:05:20 and
17:05:37 PDT a `git diff` reported `worker/jobs/OnboardingDripWorker.ts:343`
mutated to `` `${drip_type} replay suppressed a duplicate send` `` and a harness
snapshot showed `dripBodyVariesPerAttempt` inverted to `dripType !== 'day_7'`,
while `git status --porcelain` in the same command was empty and a `grep` showed
the original text. Both reverted within seconds; md5 has been stable since.
Almost certainly another agent's mutation-probe run. It was **not** my mutation
(mine was `MUTATED replay marker XYZZY`, in §6, restored). Flagging it because
any gate evidence taken from this worktree during that window is untrustworthy,
and because a mutation probe that crashes mid-run would leave the tree dirty.

**A2 — `AdminExceptionWorker` (F12, filed not fixed).** Corroborated
independently: `rg "UPDATE review_exceptions"` over `src/` and `worker/` returns
only `account-offboarding/purge-stages.ts:234`, which sets
`review_id/response_id/payload`, never `status`. The guard at `:114` therefore
cannot fire on a retry, as D13 states. Still filed, not fixed — correct per the
owner's disposition.

**A3 — triage F6 wording.** "Behaviour change is benign (all three send stable
bodies)" is imprecise for `NotificationFailoverPoller`: its key is a per-attempt
`claimId`, so the 409 branch is unreachable regardless of body stability. The
conclusion (benign) holds for a different reason. Not worth a fix; noted so a
future reader does not inherit the wrong mental model.

**A4 — "seven pre-existing house keys"** (`EngagementAlertWorker.ts:320`,
`intake.invariants[7]`) survives F7's correction. It is defensible if "house
key" means *domain-scoped* key: `auto_post_notice`, `escalation_notice`,
`pending_post_notice`, `autonomy_suspended_notice`,
`solicitation_veto_notice` (`email-channel.ts:75,98,120,138,155`),
`approval_request` (`notification/dispatch.ts:290`) and
`autonomy_admin_alert` (`AutonomyAdminAlertWorker.ts:60`) = seven. F7's "13
sites" counted every keyed site including the per-attempt and per-delivery ones.
Not a finding; recorded so the two numbers are not read as contradicting.
