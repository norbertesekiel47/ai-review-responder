# Standards & maintainability review — `fix/1363-drip-alert-email-idempotency`

Fork: `10377aa9b..1b9fe88de`. Read-only pass. Measured production diff: 4 TypeScript
files, 145 added lines — **34 code, 106 comment, 5 blank** (token-classified, not
estimated).

Checked against the accepted-findings checklist
(`docs/reviews/finding-checklists/standards-maintainability.md`) first; findings below
are additional, each at ≥80% confidence. Green tooling (`ci:directory-map`,
`ci:merge-ledger`, `ci:static-policy`, eslint boundaries, typecheck) is not re-litigated.

---

## Findings

### F1 — [medium] The stated reason for the outbox-scoped key is false, and the branch contradicts itself about it

**File:** `worker/jobs/EngagementAlertWorker.ts:208-209`
(mirrored in `docs/context/core-platform-runtime.md:20` and
`.claude/reference/arch-review-log.md:2103`)

**Standard violated:** a comment that names a mechanism the code does not have
(accepted checklist class — "comment states a FALSE mechanism", "comment names the
wrong owner"). This is the tiebreak for the mixed key convention, so it is load-bearing.

**Evidence.** The comment says:

> A business-scoped key would suppress a legitimate later nudge inside Resend's 24h
> key window.

Two facts from this branch's own artifacts make that impossible:

- `worker/background/pollers/EngagementMonitorPoller.ts:31-35` — `COOLDOWNS` are
  `owner_nudge: 3`, `partner_engagement_alert: 7`, `partner_escalation_alert: 14`,
  `partner_low_engagement: 7` **days**, enforced both at enqueue
  (`EngagementMonitorPoller.ts:176-181`, `NOT EXISTS … sent_at > NOW() - cooldownDays`)
  and again in the handler (`EngagementAlertWorker.ts:125-137`, the 3-day probe).
- The key's provider lifetime is **24 hours** — asserted by the plan (fact 3) and by
  this same commit's glossary entry ("Provider-side the key lives **24 hours**",
  `docs/context/core-platform-runtime.md:20`).

The minimum gap between two *legitimate* nudges is therefore 3 days — 3× the key's
lifetime — and 7/14 days for the partner alerts. A business-scoped key expires long
before the next legitimate send, so the named risk cannot occur. The same sentence
appears in the glossary and in the architecture review log, i.e. in the durable layer,
one line away from the 24h fact that refutes it.

The *decision* (outbox scope) is still defensible — the poller's own
`NOT EXISTS (job_outbox … IN ('pending','dispatching','dispatched'))` + cooldown probe
already bound re-enqueues — but the reason written down is not the reason that holds.
Brief item 3 asks whether a future reader will be stopped from "unifying" the two
shapes: a reader who checks this reason will find it does not hold and will conclude the
convention is arbitrary, which is the opposite of the intent.

**Smallest correction.** Replace the false clause with the real one at all three sites:
the nudge and partner alerts have no domain identity that distinguishes *occurrences*
(the same `(business_id, template)` pair legitimately re-sends every cooldown period),
so the outbox row id is the only per-occurrence identity available; the enqueue-side
`NOT EXISTS` + cooldown probe, not the key, is what bounds legitimate repeats.

---

### F2 — [medium] "The ten existing callers … are unaffected" is wrong: two already pass an idempotency key, so the new non-throwing branch is live for them, undeclared and untested

**File:** `src/lib/notifications/email/templates/internal.ts:120`
(claim at `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-plan.md:71-73`)

**Standard violated:** blast-radius / interface-widening claim contradicted by the code;
behaviour change to production paths outside the declared edit surface, with no test.
`docs/reviews/fix-1363-drip-alert-email-idempotency/blast-radius.md` lists importers of
`internal.ts` but stops at direct importers, so the two worker call sites that reach it
through the barrel are not in it.

**Evidence.** The new branch fires on `error.name === 'invalid_idempotent_request' &&
params.idempotencyKey`. Two pre-existing callers already supply a key:

- `worker/jobs/AutonomyAdminAlertWorker.ts:60` — `autonomy_admin_alert:${suspension_event_id}`
- `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:314` and `:427` —
  `emailSendIdempotencyKey(deliveryId)`

For those paths, a 409 previously threw (`Resend API error: …`) and the job retried.
It now returns a synthetic `idempotent-replay:<key>` message id that
`AccountOffboardingEmailWorker.ts:352` writes to `external_message_id`, and that same
column is the worker's own "already sent" predicate at `:476` and `:498`
(`existing?.sent_at || existing?.external_message_id` ⇒ `'already_sent'`). The new
semantics look *correct* for that worker, but nothing in this branch states it, tests it,
or lists those files, and the plan's stated basis for accepting the interface widening
("the ten existing callers destructure `messageId` only and are unaffected") is the
sentence that would have caught it.

**Smallest correction.** Correct the plan/arch-log sentence to name the two existing
key-passing callers, and add one pin in the offboarding worker's existing suite that a
replay records the sentinel and marks the delivery sent. No production change needed.

---

### F3 — [medium] The `revokeMode: 'never'` rationale is copy-pasted at four sites with no owner

**Files:** `src/lib/approval/create-link.ts:19-28` (the natural owner) ·
`worker/jobs/EngagementAlertWorker.ts:176-182` ·
`worker/jobs/OnboardingDripWorker.ts:431-437` ·
`src/lib/approval/__tests__/create-link.test.ts:150-156`
(a fifth prose copy in `docs/context/core-platform-runtime.md:21`)

**Standard violated:** one authoritative owner per fact (CLAUDE.md, Lab notes & memory);
duplication with drift risk.

**Evidence.** The two worker blocks are near-verbatim of each other and of the module
docblock — same three clauses ("records its delivery with a NULL `response_id` and
template X", "the `orphaned_only` probe … matches on `response_id` and the two
link-carrying template names … always reads 'orphan'", "with the Send idempotency key
suppressing the retry's duplicate email, that link is the only one the owner holds").
14 of the 41 comment lines added to the two workers are this block. The facts restated
are facts about `createApprovalLink`'s probe, which lives in `create-link.ts`: if the
probe ever learns a third link-carrying template, four copies go stale and only one of
them is next to the code being changed. This is the same mechanism as the accepted
checklist entries about citations written by the commit that moves their target.

**Smallest correction.** Keep the full rationale in the `create-link.ts` docblock (it is
already there and is the best-placed copy). At each call site reduce to one line naming
the fact that is *local* to that site, e.g.
`// 'never' (#1363): this sender's delivery row (NULL response_id, template
'onboarding_drip_day_7') can never satisfy the orphan probe — see createApprovalLink.`
Delete the test-file copy; the test titles already say what is pinned.

---

### F4 — [low] The "seven pre-existing keys … are all domain-scoped" census omits the nearest precedent, which is both row-id-scoped and built by a named helper

**Files:** `docs/context/core-platform-runtime.md:20` ·
`.claude/reference/arch-review-log.md:2103` ·
plan Design record, `…-plan.md:16`

**Standard violated:** working-rules requirement to name the precedent; a false count in
the durable layer (accepted checklist class — "three counting claims are wrong").

**Evidence.** The enumeration covers `email-channel.ts` (5), `notification/dispatch.ts:290`
(1) and `AutonomyAdminAlertWorker.ts:60` (1) = seven, and concludes "the outbox-scoped
pair is the exception". It omits
`worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:314` and `:427`, which
are Resend keys passed to the *same* `sendInternalEmail` and are scoped to a delivery-row
id, not a domain identity — i.e. the very shape the entry calls exceptional. The same
omission undercuts the Design record's reason for rejecting a shared key-builder ("the
seven existing house keys are inline template literals"): the nearest precedent,
`src/lib/account-offboarding/email-dedup.ts`
(`accountOffboardingEmailSendIdempotencyKey`, with an `EMAIL_IDEMPOTENCY_NAMESPACE`
constant), is a named helper, imported by the worker that also passes it to
`sendInternalEmail`.

**Verdict on the rejected helper (brief item 2).** Rejecting it is still the right call —
"no abstractions for a single caller" is a working rule, each of the three shapes has one
caller, and a shared builder would have to take a union of identity kinds it cannot
validate, which is a shallow module by this repo's own vocabulary. Real drift risk is
low: the two keys that must stay byte-stable are stable *because* they are literals next
to the code they identify, and the drip's key is coupled only by greppability (not
correctness) to the `notification_deliveries.template` literal 25 lines below. What needs
fixing is the stated basis, not the decision.

**Smallest correction.** Fix the census in the glossary and the log row, and restate the
helper rejection as "one caller per shape" rather than "no helper precedent exists".

---

### F5 — [low] `IDEMPOTENT_REPLAY_PREFIX` is exported for consumers that do not exist, and its own docblock tells the tests not to use it

**File:** `src/lib/notifications/email/templates/internal.ts:28` (docblock `:14-27`)

**Standard violated:** speculative generality / public API widened with no consumer. The
plan exported it "so the workers, the tests and the operator SQL share one spelling"
(`…-plan.md:75-76`); none of those consume it.

**Evidence.** A repo-wide grep finds exactly one use — line 123 in the file that defines
it. No worker imports it; the three worker tests and `internal.test.ts:60` assert the
literal `'idempotent-replay:…'`; the docblock at `:26` says so explicitly ("Tests assert
the literal, not this constant, for the same reason"). It is re-exported to the whole app
through the `src/lib/notifications/email.ts` barrel for nothing.

**Smallest correction.** Drop `export` (module-private `const`), or give it its stated
job by having the two workers' replay log lines and the operator-facing docs reference it.
Either resolves the contradiction; keeping both the export and the "don't use it"
instruction does not.

---

### F6 — [low] Commit archaeology in a docblock, and a dead union member documented instead of deleted

**File:** `src/lib/approval/create-link.ts:30-32`

**Standard violated:** comments record WHY the code is as it is; git records what a
comment used to say. Also dead-code hygiene.

**Evidence.**

> NOTE the stale claim this comment used to carry: owner-nudge emails do NOT pass
> 'always' and never have — `EngagementAlertWorker` has always passed 'orphaned_only',
> which is the bug above. 'always' has no caller today.

Verified: `revokeMode: 'always'` now has zero production callers — the only occurrences
are `create-link.test.ts:142` and `:220`. The paragraph is a changelog entry, and it
formally documents a dead literal rather than removing it. Every future reader of this
docblock pays for a fact about a comment that no longer exists.

**Smallest correction.** Delete the NOTE paragraph (the corrected `'always'` line above
it already states the truth). Removing the `'always'` literal is a separate, larger call
— if it is kept deliberately, say *why* in one clause ("kept for the regenerate lane" or
similar) rather than recording that it is unused.

---

### F7 — [low] Comment density in the two worker files is 5×–34× the neighbourhood, and the excess is the duplicated material from F3 and F5

**Files:** `worker/jobs/EngagementAlertWorker.ts` · `worker/jobs/OnboardingDripWorker.ts`

**Brief item 1, answered honestly with measurements rather than impressions.**

| File | added code | added comment | file baseline comment:code at merge-base |
|---|---|---|---|
| `src/lib/approval/create-link.ts` | 1 | 21 | 0.63 |
| `src/lib/notifications/email/templates/internal.ts` | 13 | 44 | 0.57 |
| `worker/jobs/EngagementAlertWorker.ts` | 11 | 21 | **0.09** |
| `worker/jobs/OnboardingDripWorker.ts` | 9 | 20 | **0.30** |
| total | 34 | 106 | — |

Peer files for calibration: `worker/jobs/notification/dispatch.ts` 0.46,
`AccountOffboardingEmailWorker.ts` 0.09, `channels/email-channel.ts` 0.04.

**Verdict.** D6's defence is right *in kind* and wrong *in degree*. The two `src/lib`
modules land at roughly their own baselines — 21 comment lines on a file already at 0.63,
44 on a file at 0.57 — and the cited precedent (the `Drip staleness cap` block,
`OnboardingDripWorker.ts:180-190`, 11 lines) is real house style. But the two workers are
at 1.9:1 and 2.2:1 against baselines of 0.09 and 0.30; in `EngagementAlertWorker` the 21
added comment lines alone are two thirds of the 31 that the whole 347-line file carried
before. That excess is not distributed WHY — it is three specific blocks:

1. **The duplicated `'never'` blocks** (F3): `EngagementAlertWorker.ts:176-182` and
   `OnboardingDripWorker.ts:431-437`, 14 lines, owned by `create-link.ts:19-28`. Cut to
   one line each.
2. **The `IDEMPOTENT_REPLAY_PREFIX` docblock's operator SQL**
   (`internal.ts:20-24`, plus `:25-26`): the `SELECT count(*) … LIKE 'idempotent-replay:%'`
   query is already carried verbatim by the glossary entry
   (`docs/context/core-platform-runtime.md:21`, "Durable record: …") and the intake
   (`…-intake.json:117`). Move it to the glossary's ownership and leave a pointer.
3. **The NOTE archaeology paragraph** (F6), 3 lines.

That is ~20 of the 106 comment lines, all of them restatements of something with a
better-placed owner. What should **stay**, and is the branch's strongest documentation:
the drip's domain-scope block (`OnboardingDripWorker.ts:277-286` — a future reader would
otherwise "unify" it and silently under-fix the takeover path), the two-negative-codes
block in `internal.ts:99-119`, and the `!== 'always'` warning at `create-link.ts:74-77`.
Those three are exactly the decisions a reader would reverse, which is the bar D6 names.

---

## Judged and not flagged

**Interface widening (brief item 4) — accepted shape, with F2 as the real defect.**
`{ messageId: string; idempotentReplay?: boolean }` plus a sentinel is the right trade
here, not a lie in the type: every caller must treat a replay *identically* to a fresh
send (write `sent_at`, write the delivery row, complete the outbox), so a discriminated
union would force ~10 call sites to narrow a case that changes nothing for them, and
`recordNotificationDelivery` (`src/lib/notifications/delivery.ts:19`) requires a string
so some value must be recorded. The sentinel is a single spelling behind one constant,
the JSDoc at `:31-32` states plainly that `messageId` may not be a Resend id, and the
column has never been provider-uniform anyway (`telegram-channel.ts:62` writes
`<chat>:<message_id>`). The residual risk — a future caller passes an `idempotencyKey`
and ignores `idempotentReplay`, silently persisting a sentinel — is not type-enforced,
but it is also benign at every current call site; F2 is where that risk already
materialised undocumented.

**Invariant #12 (brief item 5) — satisfied.** The Resend error-code classification sits
in `sendInternalEmail`, the module that already owns "Resend result → throw or
messageId". Neither worker imports a Resend error name; the workers read one boolean.
This is the correct side of the entry-point/module line, and it is also the reason F2
matters — the module owning the behaviour means every caller inherits it.

**Invariant #15 / #5 / #2 — unaffected.** `createApprovalLink` still takes `sql` as a
parameter; token generation is byte-unchanged and `create-link.test.ts:181-199` pins that
`'never'` stores only the SHA-256; no outbox write shape changed.

**Test coupling — acceptable.** `internal.test.ts` mocks the Resend *client* rather than
`sendEmail`, so the key→request-option wiring in `send-email.ts` is exercised rather than
stubbed, and the file says why. The literal-over-constant assertion is a deliberate,
stated wire-format pin (same reasoning as the `ci:outbox-status` byte-for-byte contract),
not an oversight. `OnboardingDripWorker.test.ts:631-655` extends the file's existing
positional `sqlReturnQueue` convention rather than inventing a second harness.
