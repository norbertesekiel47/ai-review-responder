# Review round 1 — triage verdicts

Branch `fix-694-live-db-ddl-detector`, fork point `13212b55`. Two axes (RISK =
normal, so no adversarial third). Full reports: `review-spec-correctness.md`,
`review-standards.md`. Both verdicts were PASS/approve-with-changes; every
finding below is peripheral to the detector's structure, which both axes
confirmed sound.

Fixes landed in two batches on disjoint file sets: `415c7d1c` (detector + its
tests) and `1301455f` (helper + second caller). Orchestrator corrections in the
same round: plan census, both intake copies, `CLAUDE.md`, lab-notes.

## Spec & correctness axis

| id | verdict | resolution |
|---|---|---|
| F1 fail-closed hole: `TemplateExpression` treated as readable, so `sql.unsafe(\`${ddl}\`)` reads clean | **ACCEPT** | Real violation of a locked invariant, verified by the reviewer. Blanket fail-closed on the type was NOT the fix — it would flag legitimate mid-statement interpolation. `hidesStatementStart` fails closed only when a substitution stands where a statement begins, since a DDL verb can only start one. Tagged templates deliberately excluded (Postgres.js parameterises their substitutions). Test added, including the negative case. |
| F2 DDL verb in a SQL comment INSIDE an executed template is flagged | **ACCEPT** | Contradicted `user_visible_behavior[2]`; the promised test only covered a TS comment outside a template. `blankSqlComments` blanks bodies to equal-length whitespace so every offset — and every reported line — survives. Documented bound: a `--` inside a SQL string literal blanks the rest of that line; closing it needs a lexer, which a guard against accidental DDL does not warrant. Recorded rather than silently tolerated. |
| F3 plan Task 6 (docs sweep) unexecuted | **ACCEPT** | Not a defect — remaining plan work, deliberately deferred so the standards agent was not reading `CLAUDE.md` and lab-notes mid-edit. Executed this round. |
| F4 repo-wide test's stated rationale is inverted | **ACCEPT — the round's most useful finding** | Orchestrator's own error, propagated into the plan, a Task 5 commit message, a code comment, and intake `observability[1]`. The test asserts the offender list is empty, so a blind detector PASSES it — the exact #694 mode it claimed to catch. Corrected in the comment (batch A) and in both intake copies (D6). Reach is pinned by the reach fixtures, which assert a finding IS produced. |
| F5 `isUnsafeCall` misses destructured / `.bind` / bracket-indexed `unsafe` | **ACCEPT, partially** | Added the cheap `ElementAccessExpression` form with a test. Destructuring and `.bind` are out of reach for a walk with no type information and have zero occurrences; chasing them was rejected. The fix for the rest is honesty — the header no longer claims "every `.unsafe()` call" and names the bound, matching this audit's own convention of declaring its blast radius. |

## Standards & maintainability axis

| id | verdict | resolution |
|---|---|---|
| S1 Proxy silently drops `begin(options, cb)` | **ACCEPT** | Live bug, not theoretical: `src/lib/escalations/list.ts:43` passes `'isolation level repeatable read read only'`. Extraction widened it from one inline site to any future caller, and the failure mode is the worst available — the test still passes. Now forwards `args.slice(0, -1)`. Confirmed empirically: SQLSTATE **25006** through the wrapper, with a negative control proving the option arrived. |
| S2 the poison's justification comment is false | **ACCEPT** | Worse than a wrong comment: `gbp_connected` was chosen to dodge a migration-102 precondition the same `beforeAll` already acquires at `:169`. Fixed by DELETING the divergence — both callers now use `import_decision_recorded` — rather than re-explaining it. The `poison` parameter is kept and its justification moved to the true one (a poison is the caller's fixture; the helper cannot know which constraints an arbitrary writer satisfies). |
| S3 `String(fn)` DDL grep is theatre and fails open | **ACCEPT** | It greped a `Function.toString()`, inspected only the poison rather than the mechanism its title names, and duplicated this branch's own static gate in a strictly weaker place. Replaced with a `pg_constraint` count on `job_outbox` before/after the aborted transaction — the exact regression the old temporary-constraint approach caused. Locked title kept, body made real. Proven non-vacuous (1 → 2 → 1). |
| S4 `CLAUDE.md` + lab-notes state R2 as "apply migration SQL", pragma undocumented | **ACCEPT** | Same as F3. Both updated: R2 restated as executed DDL, both allowlists named, `live-db-ddl-ignore` documented following the `outbox-seam-ignore` precedent the reviewer cited, and `abort-injection.ts` named as the sanctioned way to force an abort. |
| S5 `sql-tag-scan.ts` header omits its fifth consumer | **REJECT as a source edit, concern satisfied elsewhere** | The file is outside `allowed_edit_surface`, a locked invariant requires its behavior byte-identical, and its claim is still TRUE — merely incomplete. Editing it would spend a surface amendment on a cross-reference. Redirected into the lab-notes #694 entry, which closes with the instruction for anyone editing `SQL_TAG_NAMES`. See D6. |
| S6 cast instead of narrowing | **ACCEPT** | `rejects.toMatchObject({ code })`, the house spelling. Also removes the bare `TypeError` when nothing throws — the case most in need of a readable message. |
| S7 stale R2 sentence (D3 residue) | **ACCEPT** | Restated as executed DDL. |
| S8 census numbers wrong | **ACCEPT** | `770 of 1201` / `78 suites` → `770 of 1469` / `80 suites`. Recount surfaced a further correction (D4): 1470 was the count one commit before `abort-injection.ts` moved templates out of the `*.test.ts` census. `770` and `21 distinct forms` were exact. The argument strengthens with the right denominator. |
| S9 redundant parameter, per-finding array copy | **ACCEPT** | `unpragmaedDdlLines(source)` derives its own lines; the copying spread at the `lineHasPragma` call is gone. |

## Not carried forward

Both axes' low-confidence appendices were read and left untriaged by design — the
confidence filter exists so that speculative observations do not become work.
Nothing in either appendix described a failure scenario.
