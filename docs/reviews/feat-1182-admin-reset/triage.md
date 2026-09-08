# feat/1182-admin-reset — review wave triage

One parallel wave at `ea534ae7`: a spec-and-standards axis and a red-team pass.
Both reports agreed on the same P1 from opposite directions, which is the
strongest signal in the round.

| id | axis | sev | verdict | resolution |
|---|---|---|---|---|
| RT-01 | red team | **P0** | FIXED | `expect(REVOKE_BAN_DURATION).toBe('876000h')` — the value, not the constant against itself. Mutants `'1h'` and `'none'` re-run: both KILLED. |
| RT-02 | red team | P1 | FIXED | Predicate moved out of SQL into the pure `classifyBanState`. Inversion mutant re-run: KILLED. |
| RT-03 / spec P1 | both | P1 | FIXED | Absence is a refusal (`auth_identity_missing`), never "not banned". Two tests, one per direction. `?? true` mutant re-run: KILLED. |
| RT-04 | red team | P1 | FIXED | `resolveRevokeTarget` asserts then describes; a test fails when the guard call is deleted. Mutant re-run: KILLED. |
| RT-05 | red team | P1 | FIXED | Runbook now carries runnable recovery SQL supplying `id`, plus the two new refusal rows. |
| RT-06 | red team | P2 | FIXED | Audit payload asserted, `operator` included. Mutant KILLED. |
| RT-07 | red team | P2 | FIXED | The lookup asserts `lower(email)` in the SQL text. Mutant KILLED. |
| RT-08 | red team | P2 | FIXED | Each `unchanged` message asserted positively AND negatively. Mutant KILLED. |
| RT-09 | red team | P2 | FIXED | Fixtures use synthetic UUIDs; the owner's real staging identifiers are gone from the tree. |
| spec P2 (restore wording) | spec | P2 | FIXED | The `RESTORED` line no longer claims the proxy enrols an unenrolled admin; ADR 0025 § Consequences says it does not. Pinned by a test. |
| spec P2 (Auth timeout) | spec | P2 | FIXED | `AUTH_REQUEST_TIMEOUT_MS` = 15s via a `global.fetch` `AbortSignal.timeout`. No retry, deliberately. |
| spec P2 (horizon) | spec | P2 | FIXED | `REVOKE_HORIZON_MS`; a short pre-existing ban is re-applied. Mutant `horizon → 0`: KILLED. |
| spec P2 (TARGET duplication) | spec | P2 | FIXED | The rationale comment `mint-admin.ts` carries is now on this side too. |
| spec P2 (paperwork) | spec | P2 | FIXED | Deviations D5 and D6 added. |

## Claims the wave checked and upheld

- **`account_audit_log` is impossible for an admin** — both agents resolved it
  independently against `034_multi_location_schema.sql:64`, `117`'s header and
  `src/lib/audit/log.ts:22`. The TICKET's wording is what should be corrected.
- No `DELETE`, no `users` `UPDATE`, no unguarded production reach.
- `scripts/mint-admin.ts` is export-only: two `function` → `export function`,
  no body edits.
- Every cited line number resolves at HEAD.
- Sibling search found nothing else that revokes an admin and nothing that
  contradicts this script.

## Not fixed here

- **`scripts/verify-gate.sh`'s promised-tests matcher** uses `grep -rqF "$TITLE"`,
  so any `tests_to_add` title beginning with `--` is unfindable (grep parses it
  as an option). Real, pre-existing, outside this branch's surface. Worth its own
  ticket; the fix is `-e "$TITLE"`.
- **`scripts/mint-admin.ts` has the same unbounded-Auth-call gap.** Left alone:
  this branch does not own that file's behaviour, and the fix belongs with its
  own tests.
