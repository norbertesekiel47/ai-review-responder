# fix-1176 — branch review round 1 triage

- Reviewed SHA: `e791f2bb194e746e195bf215e06806068c2271aa` (fork `889c8be6e479e4b6eae4b729cb1f6eeceafb9343`)
- Production diff measured: 522 lines (includes workflow docs). Standards axis ran because risk = high.
- Axes: spec-correctness (`spec-correctness.md`), standards-maintainability (`standards-maintainability.md`), adversarial approach — Codex session `01a0adcc-3ce1-7bd2-8f56-8ede960e87ee` (verdict line in `adversarial.md`; full table in `.feature/codex/branch-adversarial.log`, reproduced below), red team — BLOCKED (#1302, deviation D6).

## Findings and verdicts

| # | Axis | Sev | Location | Finding | Verdict | Fix |
|---|---|---|---|---|---|---|
| S1 | spec | medium | `migrations-log.md` 122 entry; intake `rollback_plan` | Rollback `GRANT ALL ON <the twenty>` is not an inverse: 055:72 and 076:61 already revoked authenticated INSERT/UPDATE/DELETE on `auto_approval_policies` and `judge_verdicts` | ACCEPT | Exact snapshot-generated inverse in log entry, both intake copies and plan step 8 (D4) |
| S2 | spec | low | plan step 8 | Unclosed code fence swallowed the rest of the plan | ACCEPT | Fence closed |
| S3 | spec | low | handoff | Codex table stopped at plan round 2; no T1/T2 status | ACCEPT | Handoff updated |
| M1 | standards | medium | migration 122 header; suite header; log entry | "the plan's step 8" is an imprecise locator for the only MAINTAIN proof | ACCEPT | SQL moved into the migrations-log 122 entry; migration header and suite header cite that entry |
| M2 | standards | low | suite `readCatalogue` / `restore` | pg_default_acl projection duplicated; restore compared one copy with the other | ACCEPT | `readDefaultAcl()` shared by both |
| M3 | standards | low | suite `:494`, `:528`, `:535`; SQL role literals | `role:privilege` strings parsed ad hoc; role constants bypassed in SQL literals | REJECT | The literals equal the constants, the parse is local to three filters, and a typed parser adds churn without closing any failure mode the assertions leave open |
| M4 | standards | low | suite `applyMigration` | Wrapper adds nothing | ACCEPT | Inlined `sql().unsafe(migration)` |
| A1 | adversarial | P2 | intake `rollback_plan`; log entry | Same as S1; blanket grant can also add MAINTAIN where the snapshot lacked it | ACCEPT | Same fix as S1 |
| A2 | adversarial | P2 | migration 122 default revoke; intake `observability` | Schema-level revoke cannot subtract a GLOBAL default grant; production defaults never read; the suite seeds schema-level defaults only | ACCEPT | Mandatory global-default preflight before apply and rolled-back new-table probe after apply, on both projects (D5). Migration SQL unchanged — scope stays schema-level per the owner decision |

## Adversarial appendix (not promoted)

Execution identity fails closed through the owner guard (appropriate); no Supabase platform dependency found in the repo; the twenty-table list verified complete against migration history (29 deny-all tables, nine already hardened); `supabase_admin` defaults do not combine with `postgres` defaults for tables `postgres` creates.

## Round 2 — verification only, at `68ecc1d707f2994d771d131a97a4359f04559e34`

| Axis | Result | Report |
|---|---|---|
| spec-correctness (fresh agent) | S1, S2, S3 fixed; one new LOW gap: log and plan said re-grant "triples", dropping the grant option the intake keeps | `spec-correctness-round-2.md` |
| standards-maintainability (fresh agent) | M1, M2, M4 fixed; no new defect. Appendix (untriaged): step-8 SQL is duplicated between plan and log | `standards-maintainability-round-2.md` |
| adversarial (Codex, resumed `01a0adcc-3ce1-7bd2-8f56-8ede960e87ee`) | A1, A2 addressed; migration executable SQL byte-identical; VERDICT: APPROVED | `adversarial-round-2.md` |

Round-2 new LOW gap — ACCEPT. Fix: log entry 122 and plan step 8 now say "(table, role, privilege, grant option) entries … `WITH GRANT OPTION` where the snapshot had it". `contract-changed` → UNCHANGED, so no round 3; self-verified: the wording now matches intake `rollback_plan`. Standards appendix duplication — not triaged (the plan is a workflow record; the log is the owner).

## Red team

No round opened. `requiresOperatorContinuation` returns true on every branch cut from `main` after #1297 (verified: evaluates `true` on this branch). No mutation applied; `mutation-runner.mjs finalize` restored 0 files and closed the journal. Filed as #1302. The `reviewed` transition waits for the owner's decision.
