# Handoff — feat/625-consent-ledger

**Current step:** 4 (execute). Plan signed off by owner 2026-07-30 ("go for it").

## Bootstrap order (do not re-read the grilling transcript)
1. Intake contract: `docs/superpowers/plans/feat-625-consent-ledger-intake.json` (this worktree; arming copy at `.feature/intake.json`)
2. Plan: `docs/superpowers/plans/2026-07-30-625-consent-ledger.md` (this worktree — tasks, blocking edges, code)
3. Spec: `docs/superpowers/specs/2026-07-28-consent-ledger-design.md` Part I (§ references in plan)
4. Amendments: `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`
5. Deviations: `docs/superpowers/plans/feat-625-consent-ledger-deviations.md` (created on first deviation)

## Locked facts a resumed session must not re-derive
- Migration number is **093** (head 092 — #636 landed after the spec assumed 092).
- Spec §10 test 7 + `solicitation_consent_missing_at_dispatch` event **deferred to #630** (map-owner decision 2026-07-30; recorded in intake non_goals).
- Codex adversarial plan review dispatched 2026-07-30 (agent a3778248999c2e865, internal codex task bcawrpsz8); verdict pending at execution start per owner instruction — triage findings on arrival, before step 7 at the latest.
- Baseline verify-gate ran pre-implementation: all checks green except promised-tests (expected — tests not written yet).

## Glossary (verbatim terms for all task prompts)
consent ledger · guarded monotone upsert · send-eligible attestation version ·
no_consent case (a)/(b) · the §1.2 re-upload trap · consent fails closed;
suppression fails open (DR1) · Batch candidate window

## Task status
- [ ] Task 1: migration 093 + schema-ready + migrations-log + shape suite
- [ ] Task 2: attestation v2 + allowlist
- [ ] Task 3: ingest guarded monotone upsert + analytics events
- [ ] Task 4: derivation swap + evidence fields + policy .3
- [ ] Task 5: contact-delete consent sweep
- [ ] Task 6: TABLE_DISPOSITIONS entry
- [ ] Task 7: gate + bookkeeping sweep
