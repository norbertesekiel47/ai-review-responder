# Codex Adversarial Review

Target: working tree diff
Verdict: needs-attention

No ship: the change can retain consent PII after contact deletion, misclassifies the entire legacy v1 cohort, and leaves compliance deletion paths dependent on full-table scans.

Findings:
- [high] Consent is written for an email the matched contact does not retain (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-625-consent-ledger/src/lib/solicitation/ingest.ts:250-252)
  When a row matches an existing contact by phone but supplies a different email, matching deliberately preserves the existing email. This code nevertheless writes consent for candidate.email. That handle is not associated with the persisted contact, so deleteContact cannot discover or delete it. The supposedly hard-deleted person therefore leaves normalized-email PII in the no-TTL consent ledger, violating the consent-fails-closed retention contract.
  Recommendation: Only write consent for an email actually retained on the resolved contact, or reject rows whose novel email conflicts with a phone-matched contact. Add an integration test for existing {email:A, phone:P} followed by {email:B, phone:P}, then contact deletion.
- [medium] Existing v1 contacts never receive the promised case-(b) evidence (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-625-consent-ledger/supabase/migrations/093_solicitation_consent.sql:38-50)
  Migration 093 creates an empty ledger and performs no legacy bootstrap, while batch construction now resolves consent exclusively from that ledger. Consequently, every contact ingested before deployment appears as case (a), with no upload/version provenance, rather than the intake contract's case (b) for v1-covered contacts. The current regression test masks the rollout condition by processing a newly seeded v1 upload through the new writer. This fails closed, but breaks the load-bearing distinction used to tell owners which list to re-upload.
  Recommendation: Define a safe legacy bootstrap where provenance is provable, or explicitly accept legacy rows as case (a) and correct the intake, owner-remediation contract, and tests with a migrated-state fixture.
- [medium] Consent deletion and FK cascades lack a business-leading index (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-625-consent-ledger/supabase/migrations/093_solicitation_consent.sql:55-60)
  The only scope index starts with (channel, normalized_handle), so PostgreSQL cannot efficiently use it for offboarding DELETEs or business FK cascades filtered by business_id. It also cannot serve contact deletion, which intentionally omits channel. Because the ledger has no TTL, these compliance paths eventually scan every tenant's consent rows and risk statement timeouts or stalled purges.
  Recommendation: Add an index beginning with business_id, preferably (business_id, normalized_handle), and assert it in the migration shape suite.

Next steps:
- Fix the unmatched-handle consent lifecycle and add its deletion regression test.
- Resolve and test the migrated legacy-v1 cohort behavior.
- Add and verify the business-leading consent index.

## Orchestrator triage (2026-07-30)
- HIGH orphaned-consent-handle: ACCEPTED — fixed in 2d36999e (consent writes only for the resolved contact's retained email; orphan+sweep regression test).
- MEDIUM legacy-v1 cohort: ACCEPTED (documented-decision variant) — no backfill; legacy is case (a) by design, pinned by test in 2d36999e; #629 copy obligation + spec promotion recorded in deviations.
- MEDIUM business-leading index: ACCEPTED — migration 095 in 2d36999e.
