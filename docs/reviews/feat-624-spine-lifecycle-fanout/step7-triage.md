# Step 7 triage — #624 spine lifecycle + physical fan-out primitives

Two parallel review agents ran against `2c8b021a..af44b093` (blast radius
regenerated at `79e47342`). Full reports:

- `step7-spec-correctness.md` — spec/correctness against `.feature/intake.json`
- `step7-standards.md` — standards/maintainability (`thermo-nuclear-code-quality-review`)

Both were held to a ≥80%-confidence filter, given F1–F5 as already-closed, and
given the triaged deviations log so accepted decisions were not re-litigated.

**Outcome: 8 findings — 6 ACCEPT, 1 REJECT, 1 DEFER (new ticket).** Two of the
accepts were defects in the F4/F5 fixes that landed hours earlier in `76bdadc6`.

---

## S1 — status→stamp implication missing · Medium · ACCEPT, FIXED

`091:340-352`. `solicitation_outreach_status_timestamp_consistency` enforced only
the *ordering* half of its own stated rule. Every ordering arm is vacuous on a
NULL, so a `sent` row with `queued_at IS NULL` passed the CHECK — and the
daily-send cap counts by DISPATCH ATTEMPT (`queued_at`, B3) through
`idx_solicitation_outreach_account_queued`, so such a dispatch is invisible to
the cap and an account can exceed `daily_send_cap`.

Verified independently before accepting, by evaluating the predicate against the
live constraint for three tuples — `sent`, `queued` and `sending`, each with
`queued_at NULL`. All three returned `true`.

**This was a defect in F4, authored in this workflow.** The F4 SQL came from the
pre-written patch and was applied verbatim; the sanity check covered column names
and fixture compatibility but never totality. The three F4 tests then passed
because they only exercised what the arms *do* enforce — the same
green-while-covering-nothing class the branch had already been burned by three
times. The constraint's own comment ("queued/sending/sent imply the preceding
stamp") described the intended rule, which is what made the gap findable.

**Fix:** three implication arms — `queued`⇒`queued_at`,
`sending`⇒`queued_at ∧ sending_at`, `sent`⇒`queued_at`.

**Owner decision:** `sent` requires `queued_at` only, NOT `sending_at`. Whether
the send worker stamps `sending_at` before the provider call is #630's contract
and no spec pins it today; requiring it here would reject a legitimate row if
that worker batches the two writes. `queued_at` is the stamp the cap actually
keys on, so this closes the defect without pre-committing #630.

**Probe:** implication arms replaced with `TRUE`, 091 re-applied
(`ON_ERROR_STOP=1`), absence confirmed via `pg_get_constraintdef` → the new title
`requires queued_at for every dispatched status` went RED, alone. Restored.

Fixture cost: three suites seeded `sent` rows with only `sent_at`. The 091 helper
now derives dispatch stamps from the status unless a case names the field
explicitly (keyed on the property being ABSENT, so a case probing the implication
keeps its explicit null); the other two derive theirs in SQL off `NOW()`.

## S2 — non-`sent` terminals retain bodies and source PII forever · Medium · DEFER to a new ticket

`ArchivalPoller.ts:266` + `091:360-372`. `body_presence` requires
`sent_at IS NOT NULL` for any `body_redacted_at`, and F4's arm 1 makes `sent_at`
imply `delivery_status='sent'`. Therefore redaction is reachable **only** for
`sent` rows: `cancelled`, `failed` and `unknown` rows keep their full
`rendered_subject`/`rendered_body` and their `NOT NULL interpolation_inputs`
permanently, and the sweep (keyed on `sent_at`) never selects them. `unknown`
means the provider never confirmed, so those rows may in fact have been
delivered. True by construction; F4 narrowed it, since pre-F4 a non-`sent` row
could carry `sent_at` and thus be swept.

**Owner decision: its own ticket, not this branch.** It is not a narrow patch —
it needs a new sweep predicate for non-`sent` terminals (`sent_at` cannot key
them), a second partial index, a relaxation of `body_presence`'s
"redaction means sent" arm to "redaction means terminal", a new
`tenant-scope-allowlist.ts` `sqlSnippet`, and its own tests. It also revisits the
retention design T6 shipped and the owner accepted. #624 holds the only migration
slot with #625/#626/#627 blocked behind it, and `reclassify` is already WARNing at
4.2× the diff estimate.

**Accepted risk, stated plainly:** PII persists on `cancelled`/`failed`/`unknown`
outreach rows until that ticket lands. Nothing in #624 writes those statuses
(#630 builds the send worker), so no such row can exist in production before the
follow-up has a chance to land — but that is a sequencing accident, not a
guarantee, and the follow-up must land before #630.

## S3 — `rls-inventory.md` off the enumerated surface · Low · REJECT

`docs/security/rls-inventory.md:34` is matched by no `allowed_edit_surface` glob
and clears `ci:feature-surface` only through that audit's blanket `^docs/`
exemption (`scripts/ci/feature-surface-audit.ts:49`), while the intake enumerates
specific `docs/**` paths.

Rejected as a finding against this branch: the exemption is the audit's
documented behavior, so this is not a surface violation and emphatically not a
second surface amendment (a 2nd trips the abort criteria). The observation that
the audit is looser than the intake it enforces is fair, but it is a property of
`feature-surface-audit.ts`, not of this diff — and that file is off-surface here.
Worth a follow-up on the audit if the enumeration is meant to bind.

## T1 — redaction docs understate what the sweep does · Medium · ACCEPT, FIXED (2 of 3 places)

`CONTEXT.md:56` scoped **Body redaction** to `rendered_subject`/`rendered_body`,
and `2026-07-28-send-mode-cross-spec-amendments.md:40` still called
`interpolation_inputs` "load-bearing for the §2.4 provenance verdict" — both now
contradicted by the shipped sweep. Both corrected.

**This finding also tested the F5 decision, and the decision survives.**
`ask-generation-design.md:509` does make the column load-bearing: without it the
§2.4 provenance verdict "is not reproducible once the contact or visit row
changes." That qualifies the "zero production readers" evidence given at decision
time (which was a grep over *code*, and remains accurate — the obligation is a
spec one for a future ticket). What rescues wholesale redaction: §2.4 is computed
over `subject + body`, and T6 already deletes both at the same 90-day boundary.
Reproducibility was therefore already destroyed at that instant; retaining the
inputs alone cannot restore it. F5 stops retaining PII that can no longer serve
its stated purpose. Both docs now say so explicitly.

**REJECTED third of this finding:** that `docs/adr/0014-*.md` "omits it entirely".
ADR 0014's subject is one-terminal-spine-state, batch lifecycle on the domain
entity, and lazy children. Retention is a #619 D6b decision recorded in
`CONTEXT.md` and the migrations log. Silence there is correct scoping, not drift.

## T2 — the minimization guarantee had no schema owner · Medium · ACCEPT, FIXED

`091:209`. F5 put the `interpolation_inputs` erasure in one poller's `SET` clause
only, contradicting the principle 091 states twelve lines above the constraint
that applies it (`:334` — "closed in the data rather than in the sweep's
predicate, because the sweep is not the only future reader"). A second future
writer of `body_redacted_at` could stamp a redaction and leave
`contact_first_name`/`visit_note` in place.

**Fix:** a fourth arm on `solicitation_outreach_body_presence` —
`body_redacted_at IS NULL OR interpolation_inputs = '{}'::jsonb` — exactly
parallel to the existing "redaction means gone AND sent" arm. Applies with no
data migration: the poller is the only writer of `body_redacted_at`, and every
existing redacted-row fixture already inserts `{}`.

**Probe:** arm replaced with `TRUE`, 091 re-applied, absence confirmed via
`pg_get_constraintdef` → the new title
`rejects a redaction that leaves interpolation_inputs populated` went RED, alone.
Restored.

## T3 — three hand-rolled outreach INSERT fixtures · Low · DEFER

Each of the three suites re-spells 091's 15-column NOT-NULL set, its own
`prompt_hash` fabrication, and the upload→contact→batch→ask chain, with no helper
in `src/lib/shared/__tests__/helpers/`. A future NOT NULL column is shotgun
surgery across three files — which S1's fix just demonstrated in practice.

Deferred rather than rejected: the finding is correct and the cost is real. But
the three fixtures differ in tenant seeding, `sql` handle and lifecycle needs, so
the shared helper is a genuine extraction rather than a copy-paste collapse — and
S2's follow-up ticket will touch all three files again. Extracting it there, with
S2's requirements known, is cheaper and less churn than doing it twice. Logged so
it does not evaporate.

## T4 — `stalledThresholdMsForKind` hosted in the dashboard read model · Low · REJECT for this branch

`src/lib/agents/read.ts:33` + `worker/background/pollers/health-alert/checks.ts:16`.
A per-kind property of an `agent_runs` row lives in the owner-facing read model,
so the worker health poller imports `read.ts` and its type graph.
`design.md`'s "move the logic to the module that already owns the concept" points
at `run-spine.ts`, which owns `AGENT_RUN_KINDS`.

Rejected here on two grounds. First, the placement is not this branch's
invention — it is where revised G10 (a round-1 gate finding, owner-accepted) put
it when it wired the threshold, and `read.ts` already imported `run-spine.ts` to
host it. Second, moving an exported function with live callers is a refactor whose
justification rests on an import cost the finding asserts but does not measure
(the named modules are plausibly type-only, which would make the runtime graph
claim wrong). It is a fair design observation, not an ≥80%-confidence defect, and
this branch has already absorbed four review rounds. Re-file against `run-spine.ts`
with the import cost measured if it still matters.

## T5 — `outreach.ts` unregistered in the code map · Low · ACCEPT, FIXED

`docs/directory.md:534-546`. `repworth.md` names checking `docs/directory.md`
the pre-flight for adding a file, and CLAUDE.md calls it "the full file map".
Added rows for `outreach.ts` (this branch) and `batch-builder.ts` (pre-existing
drift the finding also caught).

---

## Carry-forward

- **A comment that states the intended rule is what makes a partial
  implementation findable.** S1 was caught because the constraint's comment
  claimed more than its arms enforced. Both S1 and the earlier F3 redundant-arm
  discovery are the same lesson from opposite directions: in a multi-arm CHECK,
  every arm is vacuous on NULL, so "the rule is stated" and "the rule is
  enforced" are independent facts and must be probed separately.
- **`psql -f` returns exit 0 even when statements fail** unless
  `-v ON_ERROR_STOP=1`. A probe whose break step silently no-ops reads exactly
  like a discriminating test. Every probe here confirmed the break landed via
  `pg_get_constraintdef` before trusting a still-green run.
