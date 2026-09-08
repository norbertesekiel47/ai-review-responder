# Triage — review wave round 1 (#1178)

Wave at `8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`, fork
`b23172836bc5c435dc429f1fa7505812c168fa87`. Four axes: spec-correctness,
standards-maintainability, adversarial approach (Codex), red team.

Totals: **0 P0**. 26 findings triaged — 22 ACCEPTED and fixed, 2 REJECTED with
reasoning, 2 ACCEPTED-BUT-DEFERRED (each needs a file outside
`allowed_edit_surface`, i.e. surface amendment #2, which the orchestrator brief
makes a hard stop).

## Accepted and fixed

| Id | Axis | Finding | Fix |
|---|---|---|---|
| A1 | adversarial | The runbook's manual recovery re-created the hazards the code guards: elapsed time + absence permitted deletion, and any linked row counted as success. | § "Reconciling an uncertain run" rewritten to mirror the code exactly: confirm by BOTH the printed `users.id` and the `admin_minted` row; a different id escalates; deletion requires a `pg_stat_activity` check showing the transaction terminated, not just an absent row. |
| A2 | adversarial | Commit uncertainty handled only for Postgres — a lost `createUser` response claimed "nothing was written". | Both `createUser` failure arms now report the Auth outcome as **UNKNOWN**, name the email, and route to the read-only reconciliation. Two new tests. |
| A3 | adversarial | Self-attribution recorded the privilege recipient as actor with no operator, contradicting the runbook's provenance claim. | Payload gains `actor_is_subject`, `attribution: 'bootstrap_self_actor'`, and `operator` (`os_user`/`host`/`provenance: 'unauthenticated_shell'`) — recorded WITH its provenance rather than dressed up as authentication. |
| S1 | spec | `TARGET` printed only after `mintAdmin` returned, and not at all on a throw — contradicting `user_visible_behavior[0]` ("before it writes anything"). | `formatMintTarget` split out and printed in `main()` before the call; the report still repeats it so a captured report is self-contained. |
| S2 | spec | `isDuplicateEmailError` accepted any 422, so `email_address_invalid` reported `auth_user_exists`. | 422 alone no longer qualifies; `email_exists` or an "already registered" message does. Test added for the non-duplicate 422. |
| S3 | spec | `flagValue` took the next token unconditionally: `--name --dry-run` minted an admin named `--dry-run`. | A value starting with `--` is treated as absent. |
| S4 | spec | Handoff doc stale — claimed phase `plan_approved` with tracers merely registered. | Rewritten; a resuming session is told explicitly not to re-run T1. |
| S5 | spec | Audit-actor assertion used `toContain`, so `entity_id` alone satisfied it. | Positional assertion on the actor bind, plus the payload shape. |
| S6 | spec | The live-DB "audit write fails" test never failed the real writer. | The bound is now stated in the test, and the real-writer rejection path is covered in the unit suite, where it is reachable. |
| M1 | standards | Abort injection re-implemented inline as the `{ begin } as unknown as Sql` cast its own helper forbids, with a one-arg `begin` that drops `begin(options, cb)`. | Replaced with the canonical `abortingExecutor` (`helpers/abort-injection.ts`). |
| M2 | standards | `refFromDatabaseTarget` duplicated `extractProjectRefForLog`; `main()` called both on the same value, so the printed and validated refs came from different parsers. | Bespoke parser deleted. `assertMintTarget` takes `dbProjectRef`, produced once by `extractProjectRefForLog` and reused for the printed target. |
| M5 | standards | `orphanAuthId` optional on one union arm, nullable on the other. | `string \| null`, always present, on both. |
| M6 | standards | `reconcileAfterTransaction`'s `context.email` never read. | Removed. |
| M7 | standards | Test greps SQL text out of the real `writeAdminAuditLog`. | Kept as an ordering proof (the FK depends on statement order) and strengthened positionally; the text grep is now load-bearing rather than incidental. |
| M8 | standards | Runbook restated three env facts owned by `mfa-factor-reset.md`, and warned about a `source` step it does not contain. | Cites the owner instead; the `source` note now says why the hazard does not arise here. |
| M4 / RT-08 | standards + red team | `confirmsRollback`, `MintRefusal`, `readMintConfig` had zero direct consumers, and the 22/23/42 rule was sampled at three codes through `mintAdmin`. | Direct suites added for all three. |
| RT-01 | red team | The Auth-API duplicate refusal — the second "independent closer", and the ONLY one on a database with no `auth.users` — had no test. | Covered, with `authSchema: false` so it is the only closer. |
| RT-02 | red team | "createUser returns no user with no error" — locked edge case, no test. | Covered. |
| RT-03 | red team | "generateLink fails after commit" — locked edge case, no test. | Covered. |
| RT-04 | red team | **Mutant survived**: adding class 08 to `CONFIRMED_ROLLBACK_SQLSTATE` passed the whole suite. | `describe('confirmsRollback')` pins 5 confirming and 7 non-confirming classes by code, including `08007` and `57014` by name. |
| RT-05 | red team | **Mutant survived**: `{20}` → `{16,}` on the ref pattern passed, because the test asserted only that something threw. | The assertion now attributes the refusal to the complete-ref rule (`/complete Supabase project ref/`). |
| RT-06 | red team | `inTransaction` is a time-window flag, so an audit write escaping the transaction survived. | Statement ORDER asserted (users INSERT before audit INSERT) — the property the FK actually depends on. |
| RT-09 | red team | Only the `minted` arm of `formatMintReport` was ever rendered. | `describe('formatMintReport')` covers the target line, the dry-run warning, the committed-without-link warning, and orphan reporting on both arms. |
| RT-10 | red team | Plan cited `staging-guard.ts:65,76` as "the `includes()` test"; `:76` is an equality test. | Citation corrected to `:82` (and `:126`), with the correction recorded. The design comparison stands. |
| RT-11 | red team | Runbook documented no exit codes and omitted the two `createUser` FAILED outputs. | Both sections added. |

## Rejected, with reasoning

| Id | Finding | Verdict |
|---|---|---|
| F3-remedy (plan round 2) | "Add a paginated, read-only Auth API lookup before dry-run success." | **REJECT the remedy, ACCEPT the gap.** `@supabase/auth-js@2.106.2`'s `listUsers(params?: PageParams)` takes `{ page, perPage }` and nothing else, so it means walking an entire project's Auth users on every dry run. The guarded `auth.users` probe gets the same property in one indexed query and is the shape `provision-auth-user.ts:67-77` already uses. Round 2 accepted this substitution: "reasonably addresses the gap without listing every Auth user." |
| RT-07 | "The direct `db.<ref>.` target form and the unparseable-target refusal are unreachable by any test." | **REJECT as written — the code it describes no longer exists.** M2's fix deleted `refFromDatabaseTarget` entirely; the database ref now comes from `extractProjectRefForLog`, which `staging-guard.ts` owns and `scripts/ci/__tests__/staging-guard.test.ts` tests, including both host forms. `assertMintTarget` no longer parses the database side at all, so there is no branch here left to reach. Its miss sentinels fail the equality check, which IS covered. |

## Accepted but DEFERRED — each needs surface amendment #2 (hard stop)

| Id | Finding | Why deferred |
|---|---|---|
| M3 | `assertMintTarget` is a third connection-target mode living outside `scripts/staging-guard.ts`, whose docblock calls itself "the SINGLE owner" with "Two modes" — so the diff makes that docblock false. | The fix edits `scripts/staging-guard.ts`, outside `allowed_edit_surface`. Amendment #1 is already spent on `.claude/reference/arch-review-log.md`; a second is a hard stop under the orchestrator brief. M2's fix removes the duplicated PARSER (the part with a correctness consequence); what remains is placement and a stale docblock sentence. **Owner decision required** — see the run report. |
| M9 | `scripts/mint-admin.ts` has no row in `docs/directory/repo-surfaces.md`'s `scripts/` table. | Same reason. Note the table is **curated, not complete**: 9 of ~18 scripts are absent, including `staging-guard.ts` and `ws8-staging-smoke.ts` — the two precedents this change cites — and `ci:directory-map` does not scan `scripts/`. So the omission matches the page's actual practice rather than breaking a maintained invariant. **Owner decision required.** |

---

# Triage — red-team round 2 (scoped to the fix hunks)

Round 2 ran against `2eaac333`, scoped to
`git diff 8c4108b4..2eaac333`. **0 P0.** It verified all 10 round-1 findings
fixed and confirmed both round-1 survivors now KILLED:

- class `08` added to `CONFIRMED_ROLLBACK_SQLSTATE` → **exactly 3** tests fail
  (08006, 08007, 08003), 51 pass.
- `PROJECT_REF_PATTERN` `{20}` → `{16,}` → the complete-ref test fails; both
  halves of that fix are load-bearing (the 16/19/21-char inputs AND the
  attributed message).

It then found **4 P1 and 3 P2 defects the fixes themselves introduced**. All
four P1s and two of the three P2s are now closed:

| Id | Finding | Verdict |
|---|---|---|
| RT-07 (widened) | My M2 fix did not close RT-07 — it WIDENED it. Moving the parser out made the guard depend entirely on `extractProjectRefForLog`, which has **zero tests anywhere in the repo**; stubbing its whole body to `return '(ref-not-found)'` survived 146 tests across 5 suites, because every `assertMintTarget` test injects `dbProjectRef` as a literal. | **ACCEPT.** A new `describe('extractProjectRefForLog — the parser assertMintTarget depends on')` pins both real forms (`postgres.<ref>@…`, `db.<ref>.supabase.co`) by equality against a specific ref, and pins that a miss returns a parenthesised sentinel that cannot satisfy the 20-char shape. The stub mutant now dies by construction: a constant `'(ref-not-found)'` cannot equal `kubdiqdhqbhwmqfditeg`. **The guard itself was never weakened** — round 2 confirms a sentinel can never equal a 20-character `--confirm-ref`, so the failure direction is closed (the mutant refuses every mint rather than allowing a wrong one). It is an oracle gap under an auth guard, which is reason enough. |
| RT2-01 | `flagValue`'s new `--` guard had no test; reverting it survived 54/54. | **ACCEPT** — `treats a flag-shaped value as a missing value, not as the value`, covering all three required flags. |
| RT2-02 | The new TARGET-line test was a tautology: all three fixture fields contained `STAGING_REF`, and the assertion compared the line to `formatMintTarget`'s own output, so deleting `project=` survived. | **ACCEPT** — distinct per-field fixtures and the exact line asserted, plus a no-password-in-the-descriptor check. |
| RT2-04 | The duplicate-email fixture carried BOTH `code: 'email_exists'` and an "already registered" message, so deleting either arm of `isDuplicateEmailError` survived — the same "looks strengthened, cannot discriminate" shape as RT-05. | **ACCEPT** — split into an `it.each` with ONE signal per case. |
| RT2-03 (P2) | The `dbProjectRef` row added to the prod-denylist loop was unasserted. | **ACCEPT** — `refuses a production ref reaching the guard through dbProjectRef alone`. |
| RT2-06 (P2) | The exit-code table called `2` "a flag"; a missing env var also exits 2. | **ACCEPT** — table row corrected. |
| RT2-05 (P2) | The sibling `argValue` in `scripts/diff-coverage.ts:36` has the same unguarded-next-token shape. | **REJECT for this branch.** Real, but pre-existing, in an unrelated ops script, outside `allowed_edit_surface`, and not introduced by this change — fixing it would spend surface amendment #2 (a hard stop) on a defect this feature did not create. Worth its own ticket. |

**No hole in the unsafe direction.** Round 2 re-verified that every
`createUser` error returns BEFORE the transaction, so the 422 narrowing can
never MINT a duplicate; that every absence claim in the diff is true; that
`orphanAuthId` is set at all 10 construction sites; that `abortingExecutor`'s
`begin(options, cb)` forwarding is intact; and that every changed doc claim
re-resolves, including `staging-guard.ts:82` and `:126`.

**No round 3** — `mutation-runner.mjs round-start` refuses one at the hard cap
of 2, and the RT-07 stub could not be re-run as a journaled mutation for the
same reason (its target is also outside this branch's edit surface, so the
write guard blocks it). The kill is established by construction from the
assertion instead, which is weaker evidence than a re-run and is recorded here
as such.

---

# Owner decisions, 2026-09-07 — post-review

Three decisions arrived after the review wave. All three are implemented.

1. **Production refs: the outright refusal is REVERSED.** The ticket stands —
   the script serves BOTH projects. Production is now reachable behind TWO
   independent controls, neither sufficient alone: the explicit `--env
   production` selector, AND a `--confirm-ref` equal to the ref parsed from
   both halves of the target. Nothing defaults to production; `ambient`,
   `local` and `staging` still cannot reach it; `--dry-run` works there. The
   promised title `refuses a production project ref outright` is **retired**
   from `tests_to_add` — it asserted the behaviour the owner removed — and is
   replaced by the three the owner specified. #1179 remains only the
   developer's account. **Nothing was run against production in this run.**
2. **`assertMintTarget` MOVED into `scripts/staging-guard.ts`** (standards
   finding M3, previously deferred). Its docblock now declares three modes and
   states the one sanctioned production exception. Surface amendment #2,
   owner-approved, reason recorded verbatim in `.feature/state.json`. The
   mint-mode tests and the `extractProjectRefForLog` pins moved with it, so the
   function and its suite stay together. Three promised titles kept VERBATIM
   through the move.
3. **A third red-team round is owner-authorized** at the final HEAD.

Gate note: one full-gate run went RED on
`src/lib/locations/__tests__/review-qr.test.ts` at 10.3 s. Re-run in isolation
it passes in 864 ms, and `src/lib/locations/` is untouched by this branch — a
timeout flake under full-suite load, not a regression. Recorded rather than
silently re-run.
