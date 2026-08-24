# Duplication report — Pathfinder 2026-08-24

Findings from the windowed pass, ranked by consequence. Every claim cites
`file:line`. Claims marked **[verified by orchestrator]** were re-derived
independently after the subagent reported them.

---

## The notice-family worker clone — seed 1

### First, the seed was wrong about the size

The seed said four members. **There are six**, all with the identical
`{Name}Worker.ts` + `context.ts` + `dispatch.ts` + `errors.ts` quadruple:

| Member | First landed | Prod LOC |
|---|---|---|
| `worker/jobs/notification/` (approval — the progenitor) | 2026-04-26 | 959 |
| `worker/jobs/auto-post-notice/` | 2026-06-15 | 454 |
| `worker/jobs/escalation-notice/` | 2026-07-07 | 532 |
| `worker/jobs/pending-post-notice/` | 2026-07-12 | 604 |
| `worker/jobs/autonomy-suspended-notice/` | 2026-07-14 | 412 |
| `worker/jobs/solicitation-veto-notice/` | 2026-08-24 (#950) | 521 |

**2,523 production lines across the five `-notice` members; 3,482 with the
progenitor. Five members in ten weeks.** Roughly 45–50% is identical modulo
renaming.

### Prior art: there is none, in either direction

The notice family appears on **none** of the four DO-NOT-UNIFY registers
(08-10, 08-15, 08-18, 08-22 — all read in full). Five passes have looked at this
repo and none has examined this family. The decision is genuinely open.

### The three realised bugs — this is what matters

The family's divergences **correlate with landing date, not with trust model**.
That is the signature of clone-and-modify. Each bug below was solved correctly at
least once and the fix did not propagate.

#### BUG 1 [HIGH] — `auto-post-notice` raises the bounce flag and never reads it

**[verified by orchestrator]** Reference counts for `owner_email_bounced` in each
member:

```
notification: 8    auto-post-notice: 0    escalation-notice: 7
pending-post-notice: 7   autonomy-suspended-notice: 7   solicitation-veto-notice: 7
```

`worker/ingress/resend.ts:97-99` explicitly enrols `auto_post_notice` in
`OWNER_DIRECTED_TEMPLATES`, so a hard bounce on the FYI **sets**
`businesses.owner_email_bounced = TRUE` (`resend.ts:262-264`). Nothing in the
auto-post path ever reads it back.

It cannot be caught downstream either: `auto-post-notice/context.ts:106` selects
`b.google_maps_url` where every sibling selects `b.owner_email_bounced`, so the
value never reaches the dispatcher; `resolve-channels.ts:76-96` filters only
`archived_at` and enrolments; `email-channel.ts:60-72` sends unconditionally.

**Impact:** every auto-posted reply on an account with a bounced owner address
generates a fresh hard bounce, repeatedly, on the highest-volume notice in the
family. The admin alert this raises (`resend.ts:287`) promises the operator that
owner-directed emails "will be skipped" — a promise this one does not keep.

**Two documents are false because of this gap:**
- `docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md:258-262`
  says pending-post-notice was cloned from auto-post-notice *"including the
  bounced-owner email skip"*. There was no skip to inherit; PPN's was written
  fresh.
- `worker/jobs/solicitation-veto-notice/dispatch.ts:83` says *"same rule as every
  other notice dispatcher"*. False for one of five.

**Known since 2026-07-12 and untracked.** The WS4 spec's parenthetical says
*"known follow-up #3a does not grow a third instance"*. `grep -rn "#3a" docs/`
returns that sentence and nothing else — no ticket, no backlog row. Six weeks
open, one dangling reference as its only record.

#### BUG 2 [HIGH] — one crash permanently dedup-blocks a channel, and the outbox reports success

Two independent halves compound.

**Half A — no stale-claim reap. [verified by orchestrator]**

```
NO REAP  claimAutoPostNoticeDelivery        delivery.ts:84
NO REAP  claimEscalationNoticeDelivery      delivery.ts:113
REAP     claimPendingPostNoticeDelivery     delivery.ts:143
REAP     claimAutonomySuspendedNoticeDelivery  delivery.ts:194
REAP     claimSolicitationVetoNoticeDelivery   delivery.ts:278
```

The three reapers `DELETE` an unfinalized claim older than 15 minutes before
inserting. The PPN reap's own comment (`delivery.ts:151-157`) states the failure
mode: *"a dispatcher that crashed between claim and finalize/release leaves a
pending row that would dedup-block every future send of this veto-critical
notice."*

Nothing else reaps them. **[verified]** `NotificationFailoverPoller` is scoped to
`template = 'approval_request'` at all five of its query sites (`:206`, `:243`,
`:340`, `:345`, `:464`). `ArchivalPoller.ts:153-171` deletes at 90 days.

**Half B — a conflict is read as a harmless dedup.** APN `dispatch.ts:101-107`
and ESC `:137-143` treat the `null` return as "already claimed", increment
`skipped`, and continue — then the Worker completes the outbox. SVN `:116-127`
and ASN `:71-85` distinguish `settled` from `pending` and **throw** on `pending`.
The rationale is written at `delivery.ts:314-318`: *"an unfinalized live claim
means an earlier attempt may still be sending … Surface it as pending so the
outbox row stays incomplete rather than risk a silent double-send."*

**Combined:** for APN and ESC, one crash between the claim INSERT and
`finalizeDeliverySent` leaves an immortal pending row. Every retry and every
future job for that entity reads it as a dedup and marks the outbox complete.
**A Guardian escalation notice is silently and permanently lost, and the outbox
reports success.** Escalation is the Guardian persona's only owner-facing output.

#### BUG 3 [MEDIUM] — three members classify a database failure as a provider failure

APN (`dispatch.ts:92-146`), ESC (`:128-183`) and PPN (`:126-235`) put
claim→send→**finalize** inside one `try`, guarded only by a `deliveryId === null`
sentinel that is spent once `deliveryId` is set. If `finalizeDeliverySent` throws,
the catch runs the *provider* classifier on a **Postgres** error and may call
`failDelivery` — recording as failed a notice the provider already accepted.

ASN and SVN moved the DB lifecycle outside the provider catch precisely to stop
this. `autonomy-suspended-notice/dispatch.ts:60-63`, echoed verbatim at
`solicitation-veto-notice/dispatch.ts:104-108`: *"classifying it as a provider
error can falsely settle a notice whose provider side effect already succeeded."*

**The newest two members carry a written warning about a defect the three older
ones still have.**

#### BUG 4 [LOW–MEDIUM] — the health-alert allowlist is closed and #950 wired only itself

`health-alert/checks.ts:90-97` lists six topics. `SOLICITATION_VETO_NOTICE` is
there, added by #950. `AUTO_POST_NOTICE`, `ESCALATION_NOTICE`,
`PENDING_POST_NOTICE` and `AUTONOMY_SUSPENDED_NOTICE` are absent. The file's own
comment `:76-80` names this failure class and cites a prior instance.

Mitigated by `worker/job-failure-sink.ts`, which raises a Sentry issue on the
terminal attempt for every BullMQ worker. The gap is the outbox-level aggregate
alert, not total blindness.

### What is genuinely identical

**`errors.ts` — five copies of one 8-line function.** All five reduce to:

```ts
const reason = err instanceof Error ? err.message : String(err);
return { retryable: isTransientChannelSendError(err), reason };
```

`auto-post-notice/errors.ts:24-27` · `escalation-notice/errors.ts:22-25` ·
`pending-post-notice/errors.ts:25-28` · `solicitation-veto-notice/errors.ts:21-26`
· `autonomy-suspended-notice/errors.ts:8-15`. All five delegate to the same
single-owner predicate. **Zero behavioural difference across five files.** Each
also carries a 7–16 line header restating the same rationale in different words.

**The `businesses`+`accounts`+`account_offboardings` SELECT — 21 lines, four
copies.** ESC `context.ts:103-123` and PPN `:143-163` are **byte-identical**; SVN
`:102-122` and APN `:106-126` each differ in exactly one line.

> **Important qualifier that changes where this belongs:** the 13-line
> offboarding projection inside that block appears in **18 files repo-wide**,
> including `src/lib/payments/create-checkout-session.ts` and
> `worker/jobs/publisher/load-context.ts`. A notice-family-scoped owner would
> capture 4 of 18 and create a second owner for the same SQL. **If this is
> extracted, it belongs at the offboarding-gate seam
> (`src/lib/account-offboarding/gate.ts`), not in the notice family.**

**Scaffold identity:** 47 lines are identical across all four seed `Worker.ts`
files — the complete `markOutboxCompleted`/`markOutboxFailed`/
`extractOutboxHandle` scaffold, the `NEXT_PUBLIC_APP_URL` guard, the four-guard
sequence, the done-log, the retryable-throw, and all 11 imports. Pairwise
identical `dispatch.ts` lines run 78–97 among the four.

### What genuinely differs, and is principled

1. **The idempotency key cannot be parameterised.** Five migrations
   (067/073/074/076/113), three key columns (`response_id`, `escalation_id`,
   `entity_id`). CLAUDE.md's own gotcha forbids parameterising the `ON CONFLICT`
   predicate — a bind parameter defeats partial-index inference. **This is the
   load-bearing specialization.**
2. **Three distinct kill-switch postures, each documented.** ESC gates on
   `escalationEnabled()`; PPN on `autoApprovalRuntimeEnabled()`; ASN
   deliberately has none (*"disabling the autonomy runtime must never hide the
   fact that auto-posting was suspended"*, `Worker.ts:15-16`); SVN deliberately
   has none with an explicit anti-precedent (`Worker.ts:10-12`).
3. **Approval-link creation.** Only PPN mints a tokenised link
   (`dispatch.ts:162-177`), which is why only PPN redacts `rawToken`. Invariant
   #5 attaches to that path alone.
4. **Redaction depth tracks payload content.** APN and SVN redact nothing and
   correctly so — their params carry only names, ratings and counts.
5. **Spine write.** Only ESC records a step, with review-row `FOR UPDATE` first.
   PPN and SVN each name which other transition owns the record.
6. **ASN's org-default enrolment filter** (`Worker.ts:66-71`) — account-scoped
   where the others are location-scoped.
7. **SVN's business-before-entity ordering** (`context.ts:97-100,143-149`) — the
   payload carries no `account_id`, so the business read must supply it. This is
   invariant #8 being honoured.

### What is drift — same problem, different answers, no reason

8. **`getEligibleChannels` vs `resolveEligibleChannels`.** The wrapper's own
   docstring (`eligibility.ts:114-119`) says it exists because *"this
   business→input mapping was duplicated verbatim across the three notice
   workers."* ESC, PPN and SVN use it. **APN `Worker.ts:54-64` still spells the
   literal by hand**, and its context exposes exactly the four required fields —
   it could adopt the wrapper with zero behaviour change. The refactor skipped a
   caller. (ASN's inline form is **not** drift — its split shape genuinely does
   not fit.)
9. **Systemic-failure logging — four spellings of one concept.**

   | Member | Severity | Denominator | File |
   |---|---|---|---|
   | APN `Worker.ts:117-122` | `.error` | failed only | Worker |
   | ESC `Worker.ts:128-133` | `.error` | failed only | Worker |
   | PPN `Worker.ts:126-132` | `.warn` | skipped + failed | Worker |
   | ASN `Worker.ts:94-97` | `.warn` | skipped + failed | Worker |
   | SVN `dispatch.ts:179-185` | `.warn` | skipped + failed | **dispatch** |

   `logger.error` writes to `console.error` where `.warn` does not, so "every
   channel skipped, owner unnotified" is alertable for two members and not for
   three. The `.error`/failed-only pair is strictly the older form. **Drift by
   vintage.**
10. **Zero-enrolled handling.** SVN logs a systemic-failure `.warn`; the other
    four log a quiet `.log`. SVN's argument (`Worker.ts:70-74`) is equally true
    of all four siblings — drift in the direction of the newest member being
    right.
11. **`::uuid` casts** (SVN only) and **import alias style** (ASN only) —
    cosmetic.

---

## The two auto-approval runtimes — seed 4

**There are TWO parallel implementations.** They share vocabulary, a table and
one lock — not a decision engine, not a flag, and not a veto-window enforcer.

| | Reply lane | Solicitation lane |
|---|---|---|
| Decision | `worker/jobs/response-generation/auto-approval.ts:351`, **22**-member union, **collects every** reason | `src/lib/solicitation/auto-approval.ts:101`, **6**-member union, returns the **first** |
| Flag | `AUTO_APPROVAL_ENABLED` | `SOLICITATION_SEND_ENABLED` + `SOLICITATION_AUTO_APPROVAL_ENABLED` |
| Veto anchor | `pending_post_notice` sent_at; window from `approval_audit_log` | `solicitation_veto_notice` sent_at **with `failed_at IS NULL`**; window from `agent_run_steps.detail` |
| Cap | per-**business** daily, inside the decision | per-**account**, a release-time governor |

### Where the divergence is not principled

**A. The autonomy control surface is split, and no operational document names
both halves. [verified by orchestrator]**

`grep` over `src/lib/solicitation/` and the solicitation workers returns **zero**
reads of `AUTO_APPROVAL_ENABLED` — only a comment mention at
`auto-approval.ts:439`. The lane reads only its own two flags
(`src/lib/solicitation/flags.ts`).

Setting `AUTO_APPROVAL_ENABLED=false` stops auto-posting and has **no effect** on
Solicitation auto-approval.

> **Severity, stated honestly.** `env-vars.md:661` documents
> `SOLICITATION_AUTO_APPROVAL_ENABLED` thoroughly and correctly, including that
> both solicitation flags must be true. Invariant #3 is about posting a response
> to Google, which the solicitation lane does not do — so it is not violated.
> **[verified]** Production Railway has none of the three flags set, so there is
> **zero live hazard**.
>
> The real gap is operational: the runbooks that enumerate "the autonomy flags"
> — `launch-flag-readiness.md:105`, and the "all six autonomy flags → false"
> baseline in `agentic-staging-copilot-autopilot-e2e.md:250` — predate this lane
> and do not list the solicitation flags. An operator returning autonomy to
> baseline from those lists would leave this lane untouched. **This must close
> before #633 flips anything.**

**B. The Governor can never suspend the Solicitation lane on its own terms.** The
suspension **writer** filters `AND persona = 'reply'` (`governor.ts:85`,
`suspension.ts:346`); the Solicitation **reader** is account-wide over any
persona (`auto-approval.ts:190-202`). A Reply trip stops Solicitation (D19,
intended) — but there is no way to trip Solicitation without tripping Reply, and
no solicitation policy row is ever written a `suspended_at`.

**C. "No notice ever delivered" resolves oppositely in the two lanes.** Reply:
zero delivered `pending_post_notice` → **downgrade** back to owner review
(`veto-window-gate.ts:93`). Solicitation: zero sent-and-unbounced
`solicitation_veto_notice` → **no anchor**, therefore no candidate, therefore no
downgrade (`auto-approval.ts:511-530` + `release.ts:1544`). An owner with all
channels broken gets a batch that silently ages out via P2/P3 rather than one
that comes back to them. This is D9's stated fail-closed intent, but the two
lanes answer the same failure with opposite mechanics and the Solicitation
answer loses the batch.

**D. Three spellings of the subscription predicate** across the auto-approval
surface: `subscriptionGrantsFullAccess` alone (`solicitation/auto-approval.ts:105-107`),
`checkSubscription({workerType:'publisher'})` (`response-generation/auto-approval.ts:352-358`),
and the shared write gate (`settings-guards.ts:68-73`). The first two are the two
runtimes answering "may this account act autonomously?" differently — the Reply
lane grants a `past_due` 7-day grace, the Solicitation lane does not. That may be
intended, but nothing says so and the divergence is invisible from either call
site.

**E. Two spellings of "the policy row".** `solicitation/auto-approval.ts:164-165`
and `release.ts:1622-1624` hand-write the persona/action/location predicate as
**SQL literals**; `solicitation-settings.ts:88-90` binds the constants. Three
query sites, two conventions — inside a lane whose module header insists on
"ONE CONDITIONS READER".

---

## `src/lib/solicitation/` — seed 2

**Measured, not estimated.** The seed's baseline was slightly off; the
authoritative delta is against `42a247b1`.

| Point | Files | Lines |
|---|---|---|
| `42a247b1` | 26 | 14,454 |
| `0278366c` (HEAD) | **29** | **15,509** |

**+1,055 lines, +3 files.** `auto-approval.ts` (673) is 64% of the growth.
`release.ts` +104, `ask-generation.ts` +40, `approval.ts` −18, `dispatch.ts` +3.

### Verdict: several subsystems sharing a prefix. Agrees with 08-22.

Three structural proofs:

1. **The two largest files have no edge between them, in either direction.**
   `release.ts` (1,989) and `dispatch.ts` (2,004) — 26% of the directory —
   communicate only through `outreach.ts`, `batch-builder.ts` and the database.
2. **C1 (contact intake) and C2 (consent/compliance) are satellite clusters**
   with 1 and **0** outbound edges. `contacts-repo.ts` has zero internal fan-in.
3. **`dispatch.ts` is a pure sink** — imports 11 of the other 28, imported by
   none. A sink with no internal fan-in is a process, not a layer.

**The window sharpened the answer rather than changing it.** #950 added one
structurally notable edge at `ask-generation.ts:68`: **the ask-authoring terminal
now performs an approval write**, committing `approval_method='auto_policy'` at
its finale.

`dispatch.ts` holds six distinct responsibilities. Its header argues against
splitting at the tx1/tx2 seam and the 08-22 pass banked that. That argument holds
for envelope-construction and the terminal state machine, which are welded by the
in-memory raw token. It does **not** cover the pure gate policy (`:132-257`, zero
I/O) or the generic bounded retry (`:957-1041`).

---

## The module cycle — seed 5

**The seed was wrong twice.** The file is
`src/lib/auto-approval/settings-guards.ts`, not under `solicitation/`. And the
cycle was **entirely inside `src/lib/auto-approval/`** — no solicitation file was
ever on it.

**Verdict: the runtime cycle is genuinely gone. A type-only cycle replaced it in
the same PR.**

The break used the correct pattern: `settings-guards.ts` is a true leaf (its
whole import list reaches only `zod` and shared leaves), **zero** re-export
shims, **zero** dynamic imports, and every consumer migrated in the same PR.
`fallow dead-code --circular-deps` reports clean, and an independent Tarjan pass
over 1,300+ files found **zero runtime cycles**.

The residual: `solicitation-settings.ts:45` keeps
`import type { SolicitationPatchInput } from './settings'`, and `settings.ts:31`
imports it back by value. Erased at runtime, so not a latent bug — but **one
word from being one**, and nothing guards it: no `ci:` script checks cycles, and
`ci:fallow:coverage` scores changed files, not graph shape.

**This partly refutes the seed's "deadline pressure ⇒ wrong boundary" framing.**
A type-only back-edge is the house pattern, not a #950 anomaly — seven type-only
cycles exist repo-wide, including one **fully** type-level cycle already inside
`src/lib/solicitation/` (`ask-prompt-policy.ts:17` ↔ `ask-compliance-lint.ts:34`)
predating #950 by weeks.

Cross-folder, `solicitation/` ↔ `auto-approval/` has five edges in both
directions, acyclic only because all four of #950's cross-folder edges land on
leaves. That is the discipline holding it clean, and it is one non-leaf import
from a genuine cross-folder cycle.

---

## Duplication introduced by #950

#950's intra-directory hygiene is **good** — two extractions were real moves
verified by deletion in the same diff (`release-phases.ts`, `applyDowngradeSplit`).
Four findings remain:

- **D1 — exposure classification copy-pasted from `policy.ts`.**
  `solicitation-settings.ts:149-154` reimplements `classifyVetoWindowExposure`
  (`policy.ts:75-82`); `:164-167` reimplements the fold at `policy.ts:103-110`
  byte-for-byte. The *cap* dimension is a legitimate second implementation and
  the docstring says why — but that rationale does not cover the window or the
  fold, which were importable and exported.
- **D2 — a fourth spelling of "unique violation on a named constraint".**
  `solicitation/auto-approval.ts:285,298-303`, alongside
  `channels/unique-violation.ts:18,52-64`, `locations/duplicate-location.ts:24`,
  `onboarding/create-business.ts:59`. Self-declared: the docstring names the
  house shape and then reimplements it. Six lines; the finding is that there are
  now four sites and no `shared/postgres-errors.ts` owner.
- **D3 — the `batch_approved` step-detail contract has two writers and one
  reader**, sharing an untyped JSONB key (`veto_window_minutes`) across two
  files, with the reader hard-failing if absent (`auto-approval.ts:592-595`).
  Legitimate today (the reader is `auto_policy`-scoped), but nothing pins the key
  name across both writers.
- **D4 — `approval_method` spelled two ways inside #950's own files.** Raw
  literal at `auto-approval.ts:355,401,518,623`; the `APPROVAL_METHOD` constant
  at `release.ts:1190,1939`. Three of the four literals are inside SQL text
  (defensible). **`:401` is not** — a plain JS object literal in a file that does
  not import the constant living one folder over.

---

## The admin surface — seed 3 REFUTED

**The seed's premise is measurably wrong.** The four merges are not four
consolidations of one surface. No admin route crosses four abstractions, and **no
file in the repo imports from more than one of the four seams.**

| Seam | Importers | Surface |
|---|---|---|
| `useAdminActionForm` | 5 | `src/app/admin/**` |
| `requireAdminJson` | 3 | `src/app/api/admin/**` |
| `useLaneWrites` | 2 | `dashboard/requests/` — **owner, not admin** |
| `ci:pool-fanout` | 0 (a rule) | `src/lib/{admin,dashboard,locations}` |

Three stack in strictly disjoint layers of one request; the fourth is on a
different surface and unreachable from any admin route. **A clean result, stated
as such.**

Two real secondary findings:

- **`#880` vs `#886` are two owners for one concern.** `useAdminActionForm` owns
  state and **refuses** transport (`useAdminActionForm.ts:40-44`);
  `useLaneWrites` owns transport **and** state (`lane-writes.ts:210,395-396`).
  Authored the same evening **eight minutes apart**, neither references the
  other, and **neither is guarded by any CI audit** — so the divergence is
  invisible to the build. The surfaces genuinely differ (AAL2 operator control
  plane vs tenant-scoped owner lane), so this may be legitimate specialization —
  but nothing records that decision.
- **`#909` migrated 3 of 25 admin mutation routes.** Byte-shape-identical
  duplicates survive at `admin/billing/grant-extension/route.ts:41-58` and
  `admin/impersonation/start/route.ts:26-49`; a **third, divergent** shape
  survives at `admin/businesses/[id]/ranking/route.ts:24-43` with different
  strings and no `NO_STORE_HEADERS`. Eight more admin routes call
  `request.json()` raw. **`ci:admin-aal2` accepts all of them** — it checks that
  a gate is reached, never that the preamble is the shared one.

Also worth stating plainly, though correct under the parity rule: the page that
renders the admin batch panel is **AAL1** (`page.tsx:23`), so an admin without
step-up can **read** a customer's batch state, counts and halt history. Only the
stop requires AAL2.

---

## Additions to the DO-NOT-UNIFY register

| Pair | Why it stays separate | Evidence |
|---|---|---|
| **The five notice claim helpers' key columns** | Five migrations, three key columns, byte-for-byte `ON CONFLICT` predicates that cannot take a bind parameter. Any shared claim helper degenerates into a five-arm switch — which `delivery.ts` already is, and is the right place for it. | `delivery.ts:80-82`, migrations 067/073/074/076/113 |
| **The three notice kill-switch postures** | ESC's flag, PPN's flag, ASN's and SVN's deliberate absence — each with a written safety rationale. A shared owner needs a "which flag posture am I under" parameter. Same shape as 08-22's batch tenant-triple entry. | `ASN Worker.ts:15-16`, `SVN Worker.ts:10-12` |
| **The 21-line offboarding SELECT — do not extract into the notice family** | It appears in **18 files repo-wide**. A family-scoped owner fixes 4 of 18 and creates a second owner for the same SQL. If extracted, it belongs at `src/lib/account-offboarding/gate.ts`. | 18 files via `grep -rln "ao.purge_cancelled_at AS offboarding_purge_cancelled_at"` |
| **`DEFAULT_DAILY_SEND_CAP_ACCOUNT` vs `DEFAULT_DAILY_AUTO_POST_CAP`** | Same value (10), two constants, each docstring explicitly forbidding derivation from the other. Formalized by #910 B3.7. | `send-caps.ts:16`, `policy.ts:29` |
| **The two `veto_deadline_at` writers** | Owner lane anchors on `NOW()`; auto lane anchors on first-sent. Locked decision 4. | `approval.ts:389` vs `auto-approval.ts:610` |

## Corrections to prior claims

1. **Seed 1 said four notice members. There are six.** `autonomy-suspended-notice`
   is named in CLAUDE.md's own worker list and was omitted; `worker/jobs/notification/`
   is the progenitor.
2. **Seed 3 (four admin consolidations conflict) — REFUTED.** Disjoint importers.
3. **Seed 5's file path and framing were both wrong** — see above.
4. **Seed 2's baseline (24 files / 14,426 lines) was off by 2 files / 28 lines**
   at the measurement point that matters (`42a247b1`).
5. **This pass's own first reading of #891 was wrong** — recorded in
   `07-handoff-reverification.md` rather than deleted.
