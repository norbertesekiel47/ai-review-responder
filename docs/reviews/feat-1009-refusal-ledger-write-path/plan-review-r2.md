# Plan review round 2 — verification-only

**Reviewer:** codex exec, read-only. **Thread:** 01a05428-cccd-7ed0-9e7a-c48e4299968c
**Under review:** commit eaa0545d

---

| # | round-1 finding | verdict | note |
|---|---|---|---|
| 1 | `.todo` permits an inert eval | PARTIAL | T1 now bans markers outright, but test 26 cannot independently prove that it is itself active. Its scan set is also ambiguous: the plan says six files but maps seven. |
| 2 | Governor failures never reach `attachJobFailureSink` | ADDRESSED | Both intake copies permit the scheduler and tests; T4b adds reporting inside the existing catch. A separate fix-introduced containment defect remains below. |
| 3 | Required `occurredAt` not type-tested | ADDRESSED | Test 6 requires an omission-based `@ts-expect-error`; T3 correctly claims it. |
| 4 | Live-per-call flag read untested | ADDRESSED | Test 8 exercises false→true→false without module reset; numbering is correct. |
| 5 | Archival clock: aged-together fixtures | ADDRESSED | Test 23 explicitly requires crossed `occurred_at`/`created_at` fixtures. |
| 6 | Allowlist `sqlSnippet` untested | REJECTION SOUND | `ci:tenant-scope` normalizes and exact-matches allowlist snippets against scanned SQL and rejects stale entries; a second dedicated test would duplicate that owner. |
| 7 | Migration 116 contradicts T3’s `NOW()` | ADDRESSED | §2.2b records the narrow exception and T7 updates the living migration record. PostgreSQL confirms `NOW()` is transaction-start time and equivalent to `transaction_timestamp()`, not `statement_timestamp()` or `clock_timestamp()`. [PostgreSQL documentation](https://www.postgresql.org/docs/current/functions-datetime.html) |
| 8 | Failure atomicity untested | PARTIAL | Test 20 requires rejection and full rollback, but the plan does not require inducing a real CHECK failure through the real writer. A mocked rejection would not detect a helper that swallows its own insert error or uses another connection. |
| 9 | Throwing Sentry can poison the disabled path | ADDRESSED | The guarded emission and test 10 prevent telemetry from aborting the disabled path. The latch ordering introduces a separate observability defect below. |
| 10 | Sweep table not a complete inventory | ADDRESSED | Both omitted historical review artifacts are now explicit DO NOT TOUCH rows. |

| # | severity | file:line | defect introduced by which fix | correction |
|---|---|---|---|---|
| 1 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:349` | Finding 1: T1 says 26 tests occupy six files, but its map contains seven; test 26 is also self-certifying and can itself be `.todo`. The marker guard therefore does not mechanically guarantee an active eval. | Define all seven files explicitly and add an independent syntax-aware CI/gate check for marker call expressions across them, including test 26 itself. |
| 2 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:557` | Finding 2: T4b adds `Sentry.captureException` inside the Governor catch without guarding that call. If Sentry throws, the cycle aborts and later candidates are skipped, contradicting test 21 and “containment untouched.” | Wrap the capture in a nested swallowing guard and test a throwing Sentry mock while confirming the next candidate runs. |
| 3 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:284` | Finding 9: setting the warn-once latch before capture prevents poisoning, but a transient first capture failure permanently suppresses the only signal for the ledger gap—even after Sentry recovers. | Use bounded retry state or a retry cooldown; test throw-once → recovery → one successful warning. |
| 4 | low | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-deviations.md:94` | Test-expansion accounting says six findings/wrong implementations, but 19→26 adds seven tests and its table includes finding 2/test 21. | Include finding 2 and change “six” to “seven.” |

Out of scope — not triaged

- All 26 committed test numbers otherwise map exactly once with no gaps or duplicates, every mapped path is allowed by both intake copies, and `cmp` confirms the copies are byte-identical.
- The deviations header, D1–D3 table, and D1–D3 sections otherwise agree.
- The plan acquired uncommitted working-tree edits during this audit. Per the request, this verdict covers committed `298eb111..HEAD` only.

VERDICT: REVISE