# Handoff — feat/625-consent-ledger

**Current step: 8 (SHIP — RISK=high lane).** Steps 1–7 complete. Phase `gate_green` at head
`61f5a0df`; verify-gate `--review` fully GREEN (all audits, all six live-DB integration
suites, promised-tests, diff-coverage).

## Bootstrap order (never re-read prior transcripts)
1. Intake: `docs/superpowers/plans/feat-625-consent-ledger-intake.json` (arming copy `.feature/intake.json` — 5 surface amendments, all owner-approved/recorded)
2. Plan: `docs/superpowers/plans/2026-07-30-625-consent-ledger.md`
3. Deviations (all triaged ACCEPT, several RESOLVED): `docs/superpowers/plans/feat-625-consent-ledger-deviations.md`
4. Reviews + triage verdicts (committed): `docs/reviews/feat-625-consent-ledger/{codex-adversarial-review,spec-correctness-report,standards-quality-report}.md` + `blast-radius.md`
5. Spec: `docs/superpowers/specs/2026-07-28-consent-ledger-design.md` Part I; amendments doc §D

## What shipped (11 commits, ~2600 lines)
Migrations **093** (`solicitation_consent` ledger), **094** (analytics `event_name` CHECK
gains the two consent events), **095** (`(business_id, normalized_handle)` index for
compliance deletes). Attestation v2 + `SEND_ELIGIBLE_ATTESTATION_VERSIONS` (v1 absent).
Ingest guarded monotone upsert (consent only for the resolved contact's RETAINED email —
Codex HIGH fix) + recorded/upgraded analytics events. `loadCandidateWindow` ledger
derivation (tautology dead), `WithholdEvidence` case (a)/(b), `RESTRAINT_POLICY_VERSION`
`.3`. Contact-delete sweep by handle; offboarding purge explicit `deleteByBusiness` sweep
(spec §7.2's cascade assumption was WRONG — businesses are tombstoned). `TABLE_DISPOSITIONS`
+ `TENANT_TABLES` + rls-inventory rows.

## Step 8 checklist (RISK=high)
1. Push branch to `staging` (full stack auto-deploys). Apply migrations **093 + 094 + 095
   to the STAGING Supabase project first**, in order, verifying by schema introspection
   (information_schema/pg_indexes), NEVER the Supabase migration ledger (lab note).
2. Staging smoke: upload a CSV → consent rows written (v2), `solicitation_consent_recorded`
   analytics row; re-upload same CSV → upgraded event + zero visits; batch build →
   v1-covered/no-row contact withholds `no_consent`; contact delete → row gone.
3. PR to `main`; confirm ALL CI checks green; **PAUSE for explicit owner merge approval**.
4. At promotion: apply 093+094+095 to PROD Supabase in lockstep.
5. After merge: `git pull --ff-only` on main; ff `staging` onto main; `bash
   scripts/feature-cleanup.sh` (dry-run → --apply); deviations promotion sweep (see below);
   `document-feature` skill; domain sweep; entropy counter in
   `.claude/reference/arch-review-log.md`.

## Promotion obligations at ship (from deviations — do not lose)
- Spec §7.2 correction: consent purge is an EXPLICIT sweep, not the businesses cascade.
- Lab note: any new `ANALYTICS_EVENT_NAMES` entry needs a paired event_name-CHECK migration.
- Lab note: a vitest hook timeout on a live-DB suite poisons the FOLLOWING tests
  (abandoned-not-cancelled queued SQL); fixture-heavy cleanups need headroom + child-first
  scoped deletes.
- Lab note: new table / new analytics event is never wiring-only — budget registry ripples
  (tenant-tables, rls-inventory, dispositions, CHECK migrations).
- #629 copy obligation: legacy cohort reads case (a) — its remedy copy must be
  self-sufficient (no ledger backfill, by decision).
- Map notes: merge order #625 before #628 (rebase obligation recorded in both deviations
  files); #630 owns spec §10 test 7 + `solicitation_consent_missing_at_dispatch`.

## Task status
- [x] Tasks 1–7 + step 5 gate + step 6 adversarial (needs-attention → all findings fixed in
  `2d36999e`) + step 6.5 verdicts + step 7 dual review (3+3 LOW → triaged, fixed/rejected)
- [ ] Step 8: staging ride → PR → owner merge approval → prod lockstep → cleanup + promotion sweep
