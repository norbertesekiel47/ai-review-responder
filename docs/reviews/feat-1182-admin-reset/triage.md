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

## Round 2 (at `7170c02c`) — no P0; three new P1 oracle gaps, all closed

Round 2 re-ran all ten round-1 mutants itself and confirmed every one dead, and
**refuted the highest-risk hypothesis about the fix**: `Date.parse` handles a
real Postgres `timestamptz::text` rendering (`2126-08-15 09:37:16.251644+00` —
space separator, six microsecond digits) on the pinned Node 24. It also executed
the runbook's new recovery INSERT verbatim against the local test DB at
migrations head (`INSERT 0 1`) rather than reasoning about it.

Its three new P1s were **oracle gaps, not behavioural defects** — the code was
right; nothing pinned it. That distinction is why round 2 reported no P0.

| id | sev | gap | closed by |
|---|---|---|---|
| RT2-01 | P1 | the fix put a NEW column read (`deleted_at`) into the probe, which no test executes — the `to_regclass` guard means no live-DB suite can reach that statement | the statement's TEXT is now the oracle: `banned_until::text`, `deleted_at::text`, `FROM auth.users` and the guard itself are asserted |
| RT2-02 | P1 | deleting the whole Auth-timeout block passed all 47 tests | extracted the exported, fetch-injectable `authClientOptions()`; two tests — a signal reaches every request, and it is per-request rather than shared |
| RT2-03 | P1 | the horizon fix added a short-ban case for `--revoke` and none for `--restore` | a restore-over-a-live-short-ban test; the mutant that swapped the arm now dies |
| RT2-04 | P2 | `banned_until = 'infinity'` → `Date.parse` NaN → "not banned" | both timestamptz infinities read by value before `Date.parse`, plus a test driving the real Postgres rendering |
| RT2-05 | P2 | a dead `not.toMatch` pinning a string that no longer exists anywhere | replaced with a positive assertion on the lenient-form claim (`signs in at aal1`) |
| RT2-06 | P2 | `banProbe` pass-through indistinguishable from a literal — **pre-existing**, recorded out-of-remit | closed anyway rather than carried: both arms pinned, including the warning line the `unavailable` arm selects |

RT2-06 was offered as an accepted-risk item. It is recorded as **fixed**, not
accepted: no owner was reachable in this session to authorize an accepted-risk
disposition, and fabricating one to clear a checker would be the wrong trade for
a gap that closes with a single assertion.

**Seven further mutants re-executed by the orchestrator at the fix HEAD** —
`deleted_at::text → NULL::text`, `banned_until::text → NULL::text`, the
`to_regclass` guard neutered, the Auth timeout dropped, the signal hoisted to one
per client, the restore arm swapped, and the `'infinity'` arm dropped. **All
KILLED.** Seventeen mutants across both rounds, none surviving. 48 unit + 5
live-DB.
