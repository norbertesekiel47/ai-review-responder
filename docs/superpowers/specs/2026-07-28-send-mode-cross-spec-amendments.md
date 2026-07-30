# Cross-spec amendments — consistency review + Codex adversarial review (2026-07-28)

> **Status:** BINDING. This document supersedes conflicting statements in
> `618`–`623`. It is the triage outcome of (a) the map-session consistency
> review and (b) the Codex adversarial review (verdict: needs-attention,
> thread `019fabee-7176-7ad1-af16-8a8809fb39ef`). Arbitration rule applied
> throughout: the later-locked decision wins (#623's own amendment rule);
> lock order was #618/#622/#623 → #621 → #619 → #620 → this doc.
>
> Each spec carries a banner pointing here. Where this doc is silent, the
> specs stand as written.

## A. Contract-ownership table (who owns what — one owner per fact)

| Fact | Owner | Notes |
|---|---|---|
| Rendered artifact + delivery lifecycle | `solicitation_outreach` (#619 D5) | #623's `solicitation_ask_messages` is **superseded** — see B1 |
| `delivery_status` / `disposition_reason` enums | #619 D13 (+ B2's `superseded` member) | |
| Batch approval/veto/halt state | `solicitation_batches` columns (#619 D1/D2) | |
| Consent resolution | `solicitation_consent` (#620) | |
| Suppression | `solicitation_suppressions` (#621) | global scope per #621 §1.1 |
| Compliance lint table + subject rules | `ask-compliance-lint.ts` (#623 §2, as amended in B5) | #622 §7.4 contributes rules; the lint module is the single implementation |
| Daily send cap | `auto_approval_policies.daily_send_cap` + LEAST-resolver (#619 D19/D20 mechanism) at **#622 D4's number** — see B3 | #622's `resolveSolicitationDailyCap()` twin is dropped |
| Provider idempotency key | **outreach row id** (#619 D12b) | #622 §7.1's `solicitation-ask/<ask_id>` superseded — collides across attempts |
| Unsubscribe token mint moment | **dispatch (#630)** — see B4 | #621 D8/§2.2 "minted at render by #628" superseded |
| Restraint policy version | `.3` (#620 §6.2) | supersedes #621 §4.1's "no bump" (already recorded in #620) |
| Dispatch gate contents | union list in B6 | no single prior spec had the full list |

## B. Resolutions

### B1. One artifact table: `solicitation_outreach` absorbs #623's provenance (Codex critical 1; review clash 1)

`solicitation_ask_messages` (#623 §5.2) is **not built**. `solicitation_outreach`
(#619 D5, migration 091) is the one table, **widened with #623's load-bearing
columns**, which are re-homed, not dropped:

- `source TEXT NOT NULL CHECK (source IN ('llm'))` — `'owner_edit'` removed per B7
- `ask_lint_version TEXT NOT NULL`, `lint_detail JSONB NOT NULL`
- `moderation_status TEXT NOT NULL CHECK (IN ('clean','flagged','error','disabled'))`, `moderation_detail JSONB NOT NULL`
- `interpolation_inputs JSONB NOT NULL` (#623 §5.3 — load-bearing for the §2.4 provenance verdict)
- `prompt_hash TEXT NOT NULL` (alongside #619's `prompt_version`; #619's `policy_version` column is renamed duty: restraint version stays on the ask row's evidence — the outreach column carries `ask_lint_version`, so drop #619's ambiguous `policy_version` in favor of the two explicit columns)
- **consent snapshot** (Codex critical 1 tail; #620 §3.5): `consent_basis`, `consent_attestation_version`, `consent_row_id` — nullable, **stamped at dispatch by #630** (resolving #620's §3.5-vs-§9 ambiguity: dispatch, not render; #620's #628 binding moves to #630)

Consequences: the three new JSONB parse sites (#623 §5.5) attach to
`solicitation_outreach` reads; #623's §5.2 migration section and its
`solicitation_asks` composite-unique note are subsumed by 091 (#619 §9 item 4
already has the unique). Render-time lint/moderation blocks are outreach rows
with `delivery_status='withheld'` + `disposition_reason` per #619 D13 —
#623's `generation_status`/`blocked_reason` vocabulary maps onto them
(`ASK_BLOCK_REASONS` members become `disposition_reason` withhold members;
`missing_required_element` and `deceptive_subject`, `unverifiable_fact`,
`incentive_language`, `review_steering`, `gating_funnel`, `pressure` are folded
into the withhold set as `lint_failed` **with the class recorded in
`lint_detail`** — one coarse reason on the row, full classes in the JSONB,
keeping D13's enum small).

**moderation_high RLS (Codex high 3): resolved by this merge.** #619 D6a's
SELECT-policy carve-out (`NOT (delivery_status='withheld' AND
disposition_reason='moderation_high')`) is the database-level enforcement;
#623 §5.4's read-model-only redaction was insufficient and is superseded.
Test obligation: a direct authenticated Supabase read must not return the body.

### B2. Owner edit is OUT; per-ask regenerate is IN (Codex high 7; review clash 2)

- **Owner edit**: #619 D22 wins. #623 §8.2 rule 5 (`source='owner_edit'`),
  the `'owner_edit'` CHECK member, and #623 §10's #629 owner-edit binding are
  struck. #619 D5's parenthetical "(lint failure, owner edit)" reads
  "(lint failure, regeneration)".
- **Per-ask regenerate (LLM re-roll, no editing) survives**: #619 rejected
  *editing*, never re-rolling; `attempt_no` exists for exactly this. #623 §8's
  remaining rules stand: max 3/day (`checkAskRegenBudget`), worker-enforced,
  supersede-never-delete, blocked-is-terminal, regenerate-all fans out per-ask.
  Mechanics on outreach: new row `attempt_no+1`; prior row terminalizes
  `delivery_status='cancelled'`, `disposition_reason='superseded'` (**new
  cancel-set member** added to #619 D13), in the same transaction. The
  one-live-attempt partial unique (#619 §9 item 5) makes the swap atomic.
  Regeneration is possible only while the batch is un-approved or (post-
  approval) for `rendered` rows the owner has not excluded — a released
  (`queued`/`sending`/`sent`) row is never superseded.
- Flagged for the map owner: if regenerate should ALSO die, strike this
  section's second bullet; nothing else depends on it.

### B3. Daily cap: #622's number, #619's mechanism (Codex high 5; review clash 3)

- `DEFAULT_DAILY_SEND_CAP_ACCOUNT = 10` (#622 D4's value and rationale — the
  cap must bind a single 25-ask batch, forcing ≥3 calendar days). #619 §8's
  `50` is superseded. `DEFAULT_DAILY_SEND_CAP_BUSINESS = 25` is **dropped** —
  the one-active-batch index (D8) + the 10/account ceiling already bound
  per-location flow; a second constant would be a dead knob.
- Mechanism: `auto_approval_policies.daily_send_cap` + the LEAST-resolver
  (#619 D19/D20). Effective cap = `LEAST(configured, 10)`; the schema CHECK
  stays `1..50` but the resolver's platform default is 10, so the dial moves
  toward restraint only. #622's `resolveSolicitationDailyCap()` twin is not
  built.
- Counting basis: **dispatch attempts** (#622 D4 — a bounce still spent
  reputation), i.e. count outreach rows with `queued_at` in the UTC day, not
  `sent_at` (#619 D9's `sent_at` counting superseded).
- Concurrency (Codex's atomic-reservation point): the cap is enforced **in the
  releaser only** — a single loop on the single-replica worker, serialized by
  construction. Send workers never make cap decisions. No reservation
  machinery is needed *because* release is the one choke point; if the
  releaser is ever parallelized, this resolution must be revisited (add to the
  P2 single-replica list entry for the poller).

### B4. Unsubscribe token: mint at dispatch; placeholders in stored bytes (Codex critical 2)

The three-way contradiction (mint-at-render + raw-token-never-in-Postgres +
body-stored-pre-send) resolves as:

- Stored rendered bytes carry **deterministic placeholders** for the
  unsubscribe URL and the review link — which #623 lint class 7 already
  assumed ("the review-link placeholder, the unsubscribe placeholder"). The
  postal address is baked in verbatim (#622 §7.6 byte-match stands).
- **#630 mints the token at dispatch**, inside the pre-send transaction:
  insert the `solicitation_unsubscribe_tokens` row (hash only), substitute the
  raw URL into the outgoing message in memory. Raw token exists only in memory
  and the sent message — invariant #5 holds with no encryption machinery.
- The **byte-for-byte approval contract is over the stored bytes**:
  placeholder substitution is mechanical, deterministic, and content-free, and
  is explicitly excluded from the contract. #622 §7.6's dispatch check remains
  "stored bytes unchanged + address byte-match"; the substituted URLs are not
  part of the comparison.
- Amends: #621 D8/§2.2 (`sent_at` on the token row is set at dispatch; minted
  by #630, not #628) and #621 §11's #628 binding (moves to #630). A dispatch
  retry after the token insert re-uses the existing token row for the same
  outreach id (idempotent mint: key the token row on `outreach_id` with a
  unique index) — this also gives the provider-idempotency retry (#619 D12b)
  a stable body.

### B5. Subject rules: one lint table, union of both specs (review clash 5)

#623 class 5 (`deceptive_subject`) absorbs the union: leading `Re:`/`Fwd:`,
deception patterns, non-empty, **≤ 80 chars hard max** (stricter of 80/100
wins; #622's "≤60 target" stays as prompt guidance, not lint), ≤1 `!`, not
ALL-CAPS, no URL, **≤1 emoji**, **no PII beyond the contact's first name**
(both imported from #622 §7.4). #622 §7.4 is now advisory input to the lint
table, not a second implementation.

### B6. The dispatch gate, stated once (review item; Codex next-steps)

#630 implements this union, in order, inside the child's short pre-send
transaction (items 1–7 from #619 D18 as amended by #620 §6.3, plus #623's two
re-checks, plus #622's byte-match):

1. batch not halted (D10 latch) and send window open
2. `SOLICITATION_SEND_ENABLED` on
3. `subscriptionGrantsFullAccess`
4. suppression lookup (#621 §1.2)
5. consent row existence + `SEND_ELIGIBLE_ATTESTATION_VERSIONS` (#620 §6.3;
   subsumes "contact still exists")
6. postal address exists and byte-matches the stored footer (#622 §7.6)
7. daily caps — **checked at release, not here** (B3); the gate only asserts
   the release stamped `queued_at`
8. re-lint at current `ASK_LINT_VERSION` against stored bytes (#623 §8.3)
9. re-moderation: clean provider verdict is a send precondition (#623 §3.4)

Releaser-level gates (before any child): circuit breaker → platform ceiling →
account cap (#622 §4.3 order), plus Judge availability per #619 D18's
downgrade/hold split.

### B7. Expired-unapproved batches close their parent (Codex high 4)

New releaser duty (amends #619 D7's tick description): each tick also selects
batches with `approved_at IS NULL AND built_at < now() - BATCH_APPROVAL_WINDOW
AND halted_at IS NULL` **that have a send parent**, and in one transaction:
latch `halted_at`/`halt_reason='batch_expired'`, cancel unsettled outreach
rows (`disposition_reason='batch_expired'`), `closeBatchIfSettled` → parent
terminalizes `cancelled`. This makes D2's "≤10 days by construction" true for
the never-approved common case, not only the approved one. Test obligation:
a batch that receives no approval for 7 days closes cleanly and raises no
stalled alert.

### B8. Mechanical cross-reference fixes

- **#622 §11's #624 binding** ("`solicitation_asks` carries
  `external_message_id`, `sent_at`, `delivered_at`, rendered bytes") →
  those fields live on `solicitation_outreach` (was foreclosed by #618 S3
  before #622 was written).
- **#622 §5.3's webhook effects** ("effect on the ask row") → effects land on
  `solicitation_outreach` (`bounced_at`/`complained_at`/`unsubscribed_at`,
  #619 D13).
- **#623's "no sibling specs existed" note** — stale; #622 was locked in the
  same minute. This doc is the reconciliation it called for.
- **Env-var boundary** (#619 §8 vs #622 §9): #619's "no env vars" governs
  *lifecycle constants* (windows, intervals, thresholds). #622's
  `SOLICITATION_PLATFORM_DAILY_CAP` is an *operational brake* in the same
  class as a flag (fail-closed, flip-runbook-governed) and stands. Neither
  spec's rule is wrong; the classes are different.
- **#620 Part II B wording** — "no real recipients" corrected in place to
  "no real consumers; owner-controlled seed inboxes only" (matches #622 §3.4;
  the brief goes to counsel and must be accurate).

### B9. B4's unsubscribe column moves from #624 to #626 (#624 implementation finding)

B4 gives the token row a unique `outreach_id` so a dispatch retry re-uses the
existing token. **That contract stands; what moves is who adds the column.**

`solicitation_unsubscribe_tokens` does not exist yet, and its `CREATE TABLE` is
owned by #626's suppression spec (`suppression-unsubscribe-design:735`).
Migration 091 (#624) cannot add a column to a table a later ticket creates, so
§D's assignment was unbuildable as written.

- **#626 carries `outreach_id UUID UNIQUE` in its own `CREATE TABLE`**, with the
  FK to `solicitation_outreach` — which 091 does create, so the dependency runs
  the correct way round.
- **#630 depends on #626 for it, not on #624.** B4's mint-at-dispatch step and
  its idempotent-mint keying are unchanged; only the schema prerequisite is
  re-homed.
- §D's `#624 (091)` bullet is amended in place by this resolution — the token
  clause is struck there rather than left to contradict this section.

### B10. `QUEUE_NAMES` entries and typed outbox helpers ship with their producers, not with 091

#619 §9's migration checklist (`executor-design:1066`/`:1074`) bundles three
things into #624: the two `job_outbox` in-flight partial unique indexes, the
`QUEUE_NAMES` constants for `generate_solicitation_asks` / `solicitation_send`,
and their typed enqueue helpers. **They split.**

- **091 creates the indexes only**, and #624 ships no `QUEUE_NAMES` entry and no
  enqueue helper. `ci:outbox-topics` does not scan migrations, so the indexes are
  inert until a producer exists.
- **Each producer discharges its own half in the PR carrying its first raw
  insert** — `generate_solicitation_asks` with **#628**, `solicitation_send`
  with **#630**. The `QUEUE_NAMES` entry and the typed helper land in that same
  PR.
- The split is safe in the only direction that matters: **an index with no
  writer costs nothing, a writer with no index races.**
- This ordering is not bookkeeping preference — `ci:outbox-seam` derives helper
  coverage from `job-outbox-helpers.ts` itself, so **a topic that has a helper
  must use it**. Shipping `enqueueSolicitationSend` ahead of its producer would
  land a helper with no caller and turn any later raw insert red outside the PR
  that introduced it; shipping it *with* the producer discharges both at once.
- #624's own outbox obligation is discharged by the two indexes plus
  `ci:outbox-status` passing on their
  `status IN ('pending','dispatching','dispatched')` predicates, spelled
  members-and-order per `src/lib/shared/job-outbox-status.ts`.

### B11. The dispatch-versus-purge lock contract binds #630; #624 defines it and cannot close it

D6d (`executor-design:415`) names offboarding purge running during a **live
send**. #624 cannot close that race: the send worker's provider call sits
*between* two transactions (`executor-design:548`), and `pg_advisory_xact_lock`
releases at the end of the transaction that took it, so no advisory lock spans
the gap. #624 builds no send worker and can neither demonstrate nor test it.

**#624 defines the contract; #630 is bound to it.**

- #624 establishes **one global lock order — advisory lock first, then row
  locks** — and applies it at both sites it owns (batch construction and the
  offboarding purge stage). `acquireSolicitationBatchLock` is documented as
  **transaction-scoped**, with the "does not span a provider call" trap named at
  the helper rather than left for #630 to rediscover.
- **ADR 0014** records the required discipline: an in-flight send must be visible
  to purge in **committed state** (a `sending` delivery status purge reads),
  because no advisory lock can bridge two transactions.
- **Committed-state visibility alone is not sufficient**, and #630 must not stop
  there. "Purge checks for a committed `sending` row" is a TOCTOU on its own:
  purge observes no send → dispatch commits `sending` → purge deletes the row
  while the provider call is in flight. The claim and the purge must be
  *mutually exclusive*, not merely mutually observable. **#630's dispatch
  transaction therefore takes `acquireSolicitationBatchLock` before its
  batch-row lock** (`executor-design:548`'s dispatch transaction currently starts
  at the row lock), so the claim-writing transaction and purge serialize on the
  advisory lock and the committed `sending` state is what purge *sees* rather
  than what it *races*.
- **Serializing is not deciding — purge must DETECT and durably DEFER**
  (added 2026-07-30 from #624's step-6 adversarial review, finding F2). The
  bullet above gets purge and the claim onto the same lock so purge *observes*
  committed `sending` state instead of racing it. It does not say what purge must
  then do, and observing a live send while proceeding to delete it is the same
  data loss by a slower route. #624's purge stage today takes the advisory lock
  and then **unconditionally** deletes `contact_csv_uploads`, cascading through
  batches into outreach — so the seam as shipped is safe for construction and
  unsafe for dispatch, which is exactly its intended consumer.

  **#630 must therefore, after acquiring all advisory locks, check for committed
  `sending` claims on the account's batches and durably defer or fail the purge
  until they resolve** — never delete past one. "Durably" excludes an in-memory
  wait: the offboarding row must carry the deferral so a worker restart resumes
  it, per the existing offboarding state machine.

- **#630 owes a claim-versus-purge race test**, mirroring #624's
  build-versus-purge live-DB test. Its shape, made explicit because a test that
  merely runs the two without a deadlock proves nothing: **claim commits →
  provider call paused mid-flight → purge attempts and is refused/deferred →
  provider call completes and the outreach row terminalizes → purge then
  succeeds.** The paused provider call is the whole point; without it the test
  cannot distinguish "purge deferred" from "purge got lucky on timing".

- Explicitly **out of scope for #624** — recorded here so the gap has an owner
  and a paper trail rather than being inherited silently. #624's own review
  re-raised it as a High finding and it was rejected *for #624* on exactly this
  basis; the reviewer's sharper requirement is folded in above rather than
  discarded.

## C. Codex findings triage summary

| Codex finding | Triage |
|---|---|
| critical 1 — three artifact tables | **Fixed** — B1 |
| critical 2 — token vs byte-for-byte | **Fixed** — B4 |
| high 3 — moderation_high owner-readable | **Fixed by merge** — B1 (DB-level carve-out + direct-read test) |
| high 4 — expired-unapproved parent orphan | **Fixed** — B7 |
| high 5 — cap owners/values + atomicity | **Fixed** — B3 (single-choke-point argument replaces reservation machinery) |
| high 6 — idempotency grain | **Fixed** — outreach row id (A table) |
| high 7 — owner edit forbidden and required | **Fixed** — B2 (edit out, regenerate kept, flagged) |

Open for the map owner (flagged, defaults chosen): B2's regenerate-survives
call; B3's cap number (10) if a different deliverability posture is wanted.

## D. Consequences for implementation tickets

- **#624 (091)**: outreach column list = #619 §3 D5 **as amended by B1/B2**
  (add lint/moderation/interpolation/consent-snapshot columns, `source`,
  `superseded` reason; drop `policy_version`). **No unsubscribe-token column —
  moved to #626 by B9.** **No `QUEUE_NAMES` entry and no enqueue helper —
  moved to #628/#630 by B10;** 091 creates the two in-flight indexes only.
  Defines the advisory-before-row lock contract B11 binds #630 to.
- **#628**: renders with placeholders (B4); no token mint; no owner-edit path;
  ships the `generate_solicitation_asks` `QUEUE_NAMES` entry + typed helper with
  its first raw insert (B10).
- **#629**: approve/exclude/regenerate — no edit surface; approval FKs the
  outreach row (live attempt), not the ask.
- **#630**: token mint + substitution (B4); gate union (B6); attempt-grain
  idempotency; cap counting on `queued_at`; ships the `solicitation_send`
  `QUEUE_NAMES` entry + typed helper with its first raw insert (B10); closes the
  dispatch-versus-purge race under #624's lock order, with a
  claim-versus-purge test (B11). Depends on **#626** for the token row's
  `outreach_id` (B9).
- **#625/#626**: unchanged by this doc except #626 reads `unsubscribed_at`
  effects on outreach, the token-mint move, and **#626's
  `solicitation_unsubscribe_tokens` `CREATE TABLE` now carries
  `outreach_id UUID UNIQUE` (B9)**.
