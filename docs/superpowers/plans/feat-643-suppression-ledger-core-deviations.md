# Deviations — feat-643-suppression-ledger-core

Entries are appended by implementation subagents when reality diverges from the
plan; each gets an ACCEPT / RE-PLAN verdict at step 6.5.

## Pre-implementation coordination notes

- [2026-08-01] **T0 added: the mandated `CONTEXT.md` glossary section did not exist.**
  Caught at `/feature-resume` reconciliation. Both the plan
  (`2026-08-01-suppression-ledger-core.md:15`) and the step-3→4 handoff list
  `CONTEXT.md` → "Solicitation suppression & unsubscribe" as required reading, and
  the plan instructs that **every subagent prompt carry that glossary excerpt** with
  the five terms used verbatim. The section was never written — `CONTEXT.md`'s
  headings ended at "Voice Report Card", and the only suppression mention was a
  forward-reference inside #535's **Normalized handle** entry. The last `CONTEXT.md`
  commit is `6531c3d8` (#625), which *did* add its own **Consent ledger** entry, so
  the per-ticket precedent was clear and #643's was simply missed. **Three
  adversarial review rounds did not catch it** — all three reviewed the plan's
  internal consistency, and none verified that a document the plan *cites* exists.
  Worth carrying into future review briefs: cited-artifact existence is not covered
  by plan-internal review.

  **Resolution (owner-approved):** written as a T0 docs commit before T1 dispatch,
  sourced from the locked spec (§1.1–§1.3, §2.1, §2.2, §3.1–§3.3, §4.2, §5.2, §6.4,
  §7.6, §8.1, §8.2, D1/D3/D5/D6/D7/D8, DR1, DR2) and the plan's G1/G3/G7/G11/G12
  decision table. No intake amendment was required — `CONTEXT.md` was already inside
  `allowed_edit_surface`, so the **amendment budget stays at 1 of 2 used**
  (`scripts/ci/tenant-scope-allowlist.ts`, added during planning).

  Two judgment calls inside the entry, both flagged rather than silently taken:
  (a) it names **migration 096** before T1 creates it — the plan's file-structure
  table locks that number, and T6's migrations-log sweep is the backstop if it
  moves; (b) provenance reads `*(coined in #621 grilling; schema + domain core by
  #643)*` with **no PR number**, since the PR does not exist yet — the **Consent
  ledger** entry carries `PR #640`, so #643's should be added at ship time (step 8).

- [2026-08-01] **Gate evidence is structurally unavailable before T1.**
  `scripts/verify-gate.sh` has no docs-only mode, and its `promised-tests` row
  fixed-string-matches all 19 `tests_to_add` titles, none of which can exist at zero
  implementation. A green gate is therefore impossible for a docs-only commit; the
  worktree is parked (`.feature/intake.json` → `.feature/intake.parked.json`)
  instead, which is the documented way to end a session mid-feature. This is the
  second session to hit the same wall — the prior one recorded it as an observation
  ("feature state machine lacks an intermediate awaiting-review phase"). **Candidate
  workflow improvement, out of scope here:** a `docs_only` gate row that runs lint +
  the doc audits and skips `promised-tests` when the diff touches no `src/`,
  `worker/`, `scripts/` or `supabase/` path.

## Carried forward from the handoff — address at step 8

- **`origin/staging` is 1 commit behind `origin/main`** (the post-#642 fast-forward
  was skipped). Fast-forward it before the staging ride.
- **Document the codex-rescue task-ID issue** hit during planning: the companion
  reported no jobs recorded while the task existed only in the agent transcript;
  the round-2 review had to be re-dispatched via a direct `codex exec` CLI call.
