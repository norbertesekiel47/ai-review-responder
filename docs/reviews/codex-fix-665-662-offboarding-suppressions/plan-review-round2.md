# Plan review round 2 — verification

Plan review counter: 2. Reviewer verdict: `APPROVED`.

The fresh reviewer found no issue at or above 80% confidence. It verified that the
recorder-backed live test proves all five postal-attestation predicate names, that both
manual-entry receipt branches are covered, and that correction-actor resolution remains
inside the existing same-origin, AAL2-gated admin surface with an explicit tenant-scope
allowlist entry.

Root triage: no actionable findings.

## Post-review correction — 2026-08-18

Appended, not edited: the round-2 verdict below stands as the reviewer wrote it.
One of its supporting statements is wrong on the facts and is corrected here.

**The claim.** Round 2 records that correction-actor resolution "remains inside
the existing same-origin, AAL2-gated admin surface with an explicit tenant-scope
allowlist entry."

**What is actually true.** The same-origin and AAL2 halves are correct. The
allowlist half is not. `users` is absent from `TENANT_TABLES`
(`scripts/ci/tenant-tables.ts`), so `ci:tenant-scope` never evaluates the
`LEFT JOIN users` at all. No exception covers it and none can — the audit's
silence is not a review of the join. The allowlist entry that WAS updated
(`ADMIN_SUPPRESSION_CORRECTIONS_LOOKUP_SQL`) covers
`solicitation_suppression_corrections`, and it changed only so its `sqlSnippet`
stays byte-exact after the query shape changed. Entry count is unchanged at 381.

**Why the join is still sound.** Its shape, not the audit: a bounded primary-key
lookup of one actor row per correction, behind `requireAdminWithAal2`, returning
staff identity and never tenant data. `src/lib/admin/impersonation/session.ts`
is the existing precedent for that shape. A correction record names an admin
from any account by construction, so the lookup is cross-tenant on purpose.

The comment in `scripts/ci/tenant-scope-allowlist.ts` carried the same error and
has been rewritten to say this.
