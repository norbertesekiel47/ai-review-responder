# currents.md — archived history 2026-08-16 to 2026-08-18

Moved verbatim from [../currents.md](../currents.md) when the live file reached its
12,000-word cap. Nothing here is trimmed or summarised.

## Quick summary — #865 admin **Halt latch** surface (2026-08-18, PR #876)

**RepWorth support can now stop a customer's send batch from the admin console.
Until this shipped, `admin_halt` was a permitted value in the database that no
code could ever write — a live-but-dead enum arm, and the owner-facing copy for
it had already shipped with nothing behind it.**

What an operator gets: a Send batch panel on `/admin/businesses/[id]` showing the
batch's **Batch state**, how many messages a stop would cancel, how many are
already in flight, and how many are already delivered — never a subject or body.
When the batch is stoppable, a required free-text note plus a stop control.
Stopping is AAL2-gated, writes `halt_reason='admin_halt'` with the acting admin's
id, cancels the `rendered`/`queued` messages, and leaves anything already sent
alone. The owner then sees the already-shipped line: "RepWorth support stopped
this batch."

Three things worth knowing:

1. **Two halt arms, one body.** `haltBatch` (owner) and `adminHaltBatch` (support)
   both delegate to a private `latchHalt` that owns the CAS, the cancellations,
   the audit row, the spine step and the join, in that order. The admin arm's
   reason is fixed by the caller's identity, so no request field can name it.
2. **Neither arm will stop an unbuilt batch.** That was originally scoped as a
   known owner-side hole to fix later, until review showed it was reachable
   through the ordinary owner API — the backend hands out the unbuilt batch's id
   and the endpoint accepts it. Halting an unbuilt batch corrupts the lifecycle
   inside the *builder's* later transaction, far from the request that caused it.
3. **The panel does not show the newest batch, deliberately.** It shows the one
   still capable of sending, then any built one, then the newest. Both departures
   from "newest" were found by real defects: a newer still-building batch can
   legally coexist with the batch actually dispatching, and stopping a batch is
   exactly what makes it stop looking live.

The new shape:

| File | Role |
|---|---|
| `src/lib/solicitation/approval.ts` | `latchHalt` (shared private body) + `adminHaltBatch`, its second writer |
| `src/lib/solicitation/batch-view.ts` | `readAdminBatchSummary` — the admin read projection and its deliberate ordering |
| `src/app/api/admin/solicitation/batch/halt/route.ts` | the AAL2-gated operator entry point |
| `src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx` | the panel |

No migration — every value already existed in migrations 091 and 108.

## Quick summary — #860 per-ask **Ask regeneration** surface (2026-08-18, PR #873)

**The owner can now ask for a new version of one message in a built batch — and
can no longer ask once they have approved it. That second half is the point.**

Before this, `regenerateAsk` existed in the worker but nothing on screen could
reach it, and it accepted four batch states including `approved`. #629 shipped
the approval lane on top of that and had to record the contradiction as a
deviation: **Owner approval** promises "what you approved is byte-for-byte what
sends", while a regenerate path could in principle replace approved bytes. It was
unreachable, so #629 could defer it. #860 builds the reachable path, so the
contradiction had to be settled.

**It was settled by refusing.** `isRegenerableBatchState(state) => state === 'built'`
(ADR **0020**, narrowing cross-spec amendment B2), checked twice — once before the
work starts, once again under a row lock inside the swap, so a batch approved in
the gap between them still cannot be overwritten. The byte-for-byte guarantee is
now **unconditional**, in code and in `CONTEXT.md`.

**What the owner sees** (once the lane is switched on — see "ships inert" below):
a Regenerate control on every rendered ask while the batch is still approvable,
with "N of 3 today" beside it. It disappears on held-back messages and once the
batch is approved. It is disabled on messages they have deselected, while another
rewrite is in flight, and once that ask has spent its three. The copy is explicit
about the boundary: *"You can ask for a new version of any message, but you cannot
write one yourself."* Editing stays forbidden (D22) — the owner's verbs are
approve, exclude, and ask for new bytes.

**The honest cost, found by this PR's own review.** ADR 0020 first called the
post-approval recourse — stop the batch, build a new one — "a real ergonomic
cost". That was wrong. Halting never clears `solicitation_asks.status='send'`, so
a rebuild inside 30 days withholds those contacts as `over_contacted`, and by the
time the gap clears the visit is stale for every vertical but home services. The
cohort is lost for that visit, not delayed. The ADR now says so, and **#872**
tracks the cheaper recourse (withdraw one message inside the veto window, which is
removal rather than replacement and so does not reopen the guarantee).

**Ships inert.** `SOLICITATION_SEND_ENABLED` is unset in every environment, so the
route 404s, the send lane is null, and no control renders. Verified on the staging
worker at merge. Do not flip it — the boot assert needs four vars that do not exist
there, and the sending identity is **#633**, still open.

### The new shape

| File | What it does now |
|---|---|
| `src/lib/solicitation/ask-generation.ts` | Owns the D3 decision: `isRegenerableBatchState` — `built` only |
| `src/lib/solicitation/approval.ts` | **Three** owner verbs now — `approveBatch`, `haltBatch`, `requestAskRegeneration` |
| `src/app/api/dashboard/solicitation/batch/regenerate/route.ts` | **New.** Fourth adapter at the `withScopedBatch` seam; 404s when the flag is off |
| `src/lib/costs/tracker.ts` | `peekAskRegenBudgetBatch` — advisory, fail-open; the worker's Lua INCR stays authoritative |
| `src/lib/solicitation/batch-view.ts` | Send lane reports `regeneratingAskId` + `regenBudgets` |
| `src/app/(authenticated)/dashboard/requests/AskList.tsx` | The per-ask control + counter |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | Exclusions keyed on `askId`; `LaneRefresh` tells the parent whether a write is terminal |
| `docs/adr/0020-regeneration-refused-after-approval.md` | **New.** The decision, and its corrected cost |

## Quick summary — #859 `ci:tenant-scope` reads query blocks · #858 case-safe batch closure · #861 read-failure copy pin (2026-08-17, PRs #870, #868, #869)

**The three follow-ups #629 filed on its way out have all landed, and the one
that mattered most changed how a security gate reads SQL.**

**#859 (PR #870).** `ci:tenant-scope` used to blank every parenthesised `SELECT`
before it read predicates, so a correctly-scoped `NOT EXISTS`, scalar subquery,
`LATERAL` or CTE body was indistinguishable from an unscoped one — and #629 had
to contort `approval.ts` and `batch-view.ts` into scanner-shaped joins and split
statements just to be seen. The audit now lexes SQL once (strings, dollar
quotes, nested comments, `${…}` placeholders) and proves **every physical
tenant-table binding in every query block** — CTE bodies, `EXISTS`/scalar/
`LATERAL` children, every set arm. A child inherits scope only through an
explicit account/business identity equality to a proven, unshadowed ancestor;
row-id correlation, siblings, `OR`/`NOT` fail closed. Two rules the branch review
added before merge: a scope predicate counts **only on a column the table
physically carries** (`TENANT_SCOPE_COLUMNS`, asserted against
`information_schema` — inside a subquery PostgreSQL resolves a missing column to
the OUTER row, so `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` restricts
nothing), and an alias re-bound in an intermediate block hides the same-named
ancestor from every descendant. Every finding now carries a stable
`sqlIdentity`; `--no-allowlist` prints the same occurrence proof for triage.
`ALLOWLIST_BASELINE` **397 → 381** (17 obsolete "scanner cannot see" entries
removed, one honest admin exception added — a false negative of the OLD parser).
`approval.ts` and `batch-view.ts` are back to their natural SQL.

**#858 (PR #868).** `closeBatchIfSettled` lowercases its batch id once; a
mixed-case request id can no longer strand a Settled batch with a running Send
parent (`agent_runs.subject_id` is TEXT — case-sensitive — while every `::uuid`
cast normalises). Fixed in the callee for all seven callers, ahead of #630's
releaser tick.

**#861 (PR #869).** The Requests load-failure card is pinned: a read failure may
not claim "nothing was sent" or "nothing changed" — any tense. Test only.

**The new shape**

| File | What changed |
|---|---|
| `scripts/ci/tenant-scope-audit.ts` | Rewritten (942 → ~2,100 lines): PostgreSQL-aware lexer, query-block analyzer, JS template lexer, `sqlIdentity`, `--no-allowlist`. |
| `scripts/ci/tenant-tables.ts` | Gains `TENANT_SCOPE_COLUMNS` — the per-table scope-column map the audit consults. |
| `scripts/ci/__tests__/tenant-tables.integration.test.ts` | **New.** Read-only live-DB suite: the map must match `information_schema` at migration head. |
| `scripts/ci/tenant-scope-allowlist.ts` | 397 → 381 entries. |
| `src/lib/solicitation/approval.ts` | One-statement lock with a correlated scalar send-parent lookup; readiness gate is `NOT EXISTS`. |
| `src/lib/solicitation/batch-view.ts` | Send-lane counts are two independent scalar aggregates on the lifecycle row. |
| `src/lib/solicitation/outreach.ts` | `closeBatchIfSettled` canonicalizes its batch id. |
| `docs/security/tenant-isolation.md` | Describes the block analyzer, the column rule, and the identity format. |

**Still open from #629's list:** #860 (per-ask regenerate surface, in flight —
merge order was #859 first, done) and the admin/support halt surface (#865).

## Quick summary — #629 owner approval lane (2026-08-17, PR #863)

**An owner can now approve a batch of review requests, drop individual ones
before they go, and stop a batch outright. Nothing sends yet.**

The screen at `/dashboard/requests` gains an approval panel. The owner sees every
drafted message, un-ticks any they do not want sent, and approves the rest in one
action. Un-ticking is the only edit available — a message is either sent as
written or not sent at all. Approving starts a 15-minute undo window; "Stop this
batch" ends the batch for good, with no resume.

**This ships inert.** `SOLICITATION_SEND_ENABLED` is unset in every environment,
and the thing that actually delivers the messages is #630. With the flag off the
Requests screen is exactly the watch-mode screen it was before.

Three rules decide the whole design:

- **You can only approve what is finished.** Every request in the batch must have
  a drafted message before approval is allowed, re-checked inside the approval
  transaction. That is what makes "what you approved is what sends" true — no
  message can appear after approval and go out unseen. *Finished* means "not
  cancelled", not "successfully drafted": a message held back by moderation is a
  finished attempt with nothing left to draft, so it does not block approval.
  Requiring a clean draft would wedge any batch that had one lint failure.
- **Dropping a request only ever removes a message.** It never adds or changes
  one, which is why it needs no re-check of the content, and why partial approval
  is safe even though editing a drafted message is forbidden. Drop every request
  and the batch is approved and closed in the same breath.
- **Stopping is one-way.** Approve, drop and stop are the owner's only verbs.

### The new shape

| File | What it owns |
|---|---|
| `src/lib/solicitation/approval.ts` | **New.** `approveBatch` (approval + per-request exclusion in ONE transaction) and `haltBatch` (the owner's stop). Neither closes the batch itself — both call the existing `closeBatchIfSettled`, so batch closing keeps one owner. |
| `src/app/api/dashboard/solicitation/batch/{approve,halt}/route.ts` | **New.** Thin routes over those two verbs. |
| `src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts` | **New.** One runner shared by the three batch routes. |
| `src/app/(authenticated)/dashboard/requests/{ApprovalPanel,AskList,ApprovalActions}.tsx` | **New.** The panel, the per-request list, the buttons. |
| `src/lib/solicitation/batch-view.ts` | Gains the send-lane read the panel renders from. |
| `supabase/migrations/108_outreach_owner_excluded_disposition.sql` | Lets the database record "the owner dropped this one". Applied to staging **and** production 2026-08-17. |

**Known gaps, all filed:** `closeBatchIfSettled` compares ids case-sensitively and
was fixed here for these two verbs only — **#858**, which must be resolved before
#630 (**landed** the same day, PR #868 — the callee now canonicalises for every
caller). Per-request re-drafting has no owner entry point — **#860** (in flight).
The admin/support stop surface exists in the database as a permitted value with
nothing that writes it — since filed as **#865**.

## Quick summary — #657 email adapter + solicitation webhook lane (2026-08-17, PR #853)

**The machinery to send review requests by email now exists, and nothing calls
it.** That is deliberate. #657 shipped three pieces that only meet at the
adapter, all of them inert until #630's dispatch worker arrives.

- **Messaging adapter** — a channel-neutral send seam with exactly **one** method,
  `send`. `EmailAdapter` (Resend) is its first and today only adapter; a WhatsApp
  adapter would be a *second adapter*, never a rewrite. It has **zero production
  callers**, which is an accepted trade (map decision 14) mitigated by keeping the
  interface to one method over the spec's already-locked envelope.
- **Sending identity** — review requests send from `reviews@feedback.<env>.repworth.net`
  on their own `feedback.` domain with their own API key, deliberately separate
  from the transactional sender. The point is blast radius: a key leaked from this
  lane **cannot forge an approval email or mint an approval link**. Three new
  server-only env vars, all fail-closed, and a boot assertion that refuses to
  start a worker with sending enabled and no From address.
- **Solicitation lane** — a branch of the Resend webhook ingress chosen by an
  echoed `lane=solicitation` tag **before any database lookup**. It records
  bounce, complaint and provider-suppressed facts onto the **Outreach row** and
  writes `global`-scope rows to the **Suppression ledger**, in one transaction.
  Its write surface is deliberately narrow — never `delivery_status`, `sent_at`
  or `unsubscribed_at`, which belong to other owners.

**Nothing sends yet and nothing can.** `SOLICITATION_SEND_ENABLED` is off in every
environment, and no Outreach row carries a `provider_message_id` until #630 sends —
so the lane's discriminant cannot match in production. The existing
`notification_deliveries` webhook path is byte-for-byte unchanged apart from two
imports and one guard clause.

**The new shape:**

| Where | What |
|---|---|
| `src/lib/messaging/messaging-adapter.ts` | the seam: `MessagingAdapter` (one method), `OutboundMessage`, `getMessagingAdapter()` |
| `src/lib/messaging/email-adapter.ts` | `EmailAdapter` — the whole envelope, plus the header-injection and one-recipient guards |
| `src/lib/messaging/lane-tag.ts` | the `lane`/`solicitation` discriminant, **import-free** so the ingress never loads the Resend SDK to read two strings |
| `worker/ingress/resend/solicitation-lane.ts` | the lane: discriminant, locked attribution lookup, seven event effects, one transaction owner |
| `worker/ingress/resend/bounce-classifier.ts` | the bounce classifier, moved out of `resend.ts` intact so "what counts as permanent" keeps one owner |
| `docs/runbooks/solicitation-sending-domain.md` | domain, DNS, DMARC, mailbox, warm-up — **authored here, executed at #633** |

**Still open:** the DMARC `rua` address is an unresolved input (spec §12) and #633
cannot create the DNS record without it. The `provider_message_id` index is
deliberately deferred to #630, which produces the rows.

## Quick summary — Architecture pass 2026-08-15, executed (2026-08-16, PRs #836–#841)

**The code was healthy; the tests were the story.** The entropy counter hit 6, a
Pathfinder pass ran over the two portals + onboarding funnel (6 features + 1 seam,
671 nodes, `docs/reviews/PATHFINDER-2026-08-15/`), and six handoffs were executed the
same day, each in its own sibling worktree, each merged only after the full local
gate (lint · typecheck · 17 audits · parallel project · fallow · integration lane
against a head-provisioned DB) **and** a seven-way merge simulation passed.

**What is true now:**

- **Invariant #3's auto-policy gate chain has a tripwire** (#836). One table-driven
  suite over `LOCKED_GATE_CHECKS` denies each gate independently — judge, runtime,
  veto, moderation, `approval_method` — plus a completeness test that fails if a gate
  is added without a denial row. Before: deleting the judge check left 32/32 green.
  Fifteen guards passing for the wrong reason (mutation-verified) are now pinned;
  zero production lines changed.
- **`ci:admin-aal2` is an AST audit** (#837). Per-handler, call-not-mention,
  fail-closed, and admin pages are in scope under **read-gate parity**. An unused
  import no longer clears the gate; a gated `GET` no longer launders an ungated `POST`.
- **The live-DB CI lane is pinned** (#840) — and the pass's own claim that it was
  "inert in CI" was **wrong**: CI has run all 91 integration suites since #244. What
  was missing was a pin on the wiring; four YAML lines could un-gate 92 suites and stay
  green. `ci-audit-wiring.test.ts` now fails on any of them.
- **Trial eligibility and the primary-scoped `onboarded_by` read each have one owner**
  (#838, rode staging: worker + UI deployed clean, 3/3 checkout smokes PASS vs Stripe
  test mode). `isTrialEligible` is the strict form the docs already recorded;
  `primaryOnboardedBySql` replaced three spellings, one of them unscoped. Tenant-scope
  allowlist **396 → 394 → 392** across #838/#839 (two provable scopes, no suppressions).
- **`HealthBadge` and churn derivation have one owner each** (#839). The detail page's
  private `Record<string,…>` copy — which rendered an unknown level silently green —
  is gone; `churnMetricsQuery` + `churnScoreFromMetrics` in `business-summary.ts`
  serve all three admin surfaces. The `as unknown as DetailData` cast is gone too.
- **The Voice tab reads multi-location MODE from the server** (#841, invariant #9b),
  plus a behaviour-preserving bundle (two 2-wide dashboard reads sequenced, six
  duplications folded, dead `withRateLimit`/`withSession` deleted, the owner shell's
  missing `role` check added).

**Process:** the sweep-miss mechanization is confirmed working (last three log entries
written by the skill). New class found: an *uncounted* PR (#803) deleted the `/feature`
skill's entire step 8 — the surface three earlier prescriptions targeted. Handoff-
execution PRs are now explicitly **not counted** toward the threshold (policy written
into `arch-review-log.md`). Counter reset to 0.
