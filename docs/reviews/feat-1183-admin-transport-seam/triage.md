# Review wave triage — #1183, round 1

Wave dispatched at HEAD `344dcbc0` against fork `4aa132ba`, gate green. Four axes:
spec & correctness, standards & maintainability, adversarial approach (Codex,
session `01a07f14-5bf2-7ae3-be37-50675283dce5`), and the red-team pass.

**Red team: 14 mutations, 0 survived**, across 27 supervised runs — including three
route-suite vacuity checks (`flagged`, `solicitation/batch/halt`,
`channels/telegram/disable`), which confirmed `requireAdminJson` and
`resolveAdminActor` are covered by composition rather than assumed. No P0 from any
axis.

Full reports: `docs/reviews/feat-1183-admin-transport-seam/{spec-correctness,standards}.md`,
`.feature/logs/codex-adversarial-report.md`,
`docs/reviews/red-team/feat-1183-admin-transport-seam-7ee6d4/findings.md`.

## Accepted and fixed

| # | Axis | Sev | Finding | Fix |
|---|---|---|---|---|
| 1 | spec | **P1** | `isTransportFailure` was applied to the COOKIE arm, moving a Supabase fault 401→500 and an AAL fault `mfa_check_failed`→500 — a third and fourth undeclared cookie-path change, against ADR 0025 D4 and the ticket's "byte-for-byte… Do not touch it". | Reverted: `resolveCookieIdentity` classifies nothing. New test *"a cookie-path Supabase fault keeps its pre-ticket answer, not the bearer 500"* pins both answers. This also closes red-team P2-1 (D2's "two refusals moved" is true again). |
| 2 | red team **P1** + adversarial P2 | **P1** | `AuthUnknownError` was missing from the fault taxonomy. `handleError` raises it when `await error.json()` throws — an HTML 502 from a CDN, a WAF block page — so an upstream outage read as 401, the exact mode the classifier exists to prevent. Two axes found it independently. | Added to `isTransportFailure`, name-based like the SDK's own predicates. Test 18 parameterized over `AuthUnknownError` with and without a status. The false "turns EVERYTHING else into `AuthApiError`" comment is corrected in the module, the plan and the arch-review log. |
| 3 | red team | **P1** | "A 500 someone is paged for" was an unproven alerting claim: `internalError` only `console.error`s, `instrumentation.ts` has no console capture, `onRequestError` fires only for escaping errors, and no runbook row watches admin 5xx. | Claim corrected wherever it appeared (module docblock, plan, intake `observability`) to what is true: the signal is CORRECT and greppable, not paged. Routing it to a sink is named as a separate ticket. |
| 4 | standards | **P1** | Three present-tense claims that `src/proxy.ts` already consumes this design. It does not — that is #1185. | Corrected in `admin-transport.ts` and two `lib-platform.md` rows to name today's single consumer and #1185 as next. |
| 5 | standards | **P1** | The rewritten `mfa.ts` row asserted the proxy uses those helpers; it inlines its own lenient AAL read (`src/proxy.ts:92-103`) — the divergence ADR 0025 D6 cites. | Row corrected, and it now states the divergence explicitly. |
| 6 | standards | P2 | The same row dropped `mfa_factor_enrolled`/`mfa_challenge_succeeded` and pointed at a "module docblock" that does not name them. Verified: they appear only in `src/app/api/auth/mfa/challenge/route.ts`. This was the "information silently destroyed" risk the brief warned about, and the reviewer was right. | Both facts restored to the row. |
| 7 | spec | P2 | Test 20 stubbed synthetic throws instead of the plan's promised REAL SDK decode path, so nothing pinned the throw/return split the whole classification rests on. | New unstubbed block in `verified-identity.test.ts` drives the real `getClaims` with `ew.e30.AA`, `bnVsbA.e30.AA`, `aaaa.bbbb.cccc` (must THROW) and `abc` (must RETURN `AuthInvalidJwtError`). A dependency bump that moves a shape between channels now fails there, with a reason. |
| 8 | standards | P2 | "Edge-safe" was a hard constraint enforced only by a comment; the repo owns `eslint-boundaries.test.ts` for exactly this. | Substituted an in-module guard rather than a new eslint rule (which would need a third surface amendment): `admin-transport.test.ts` asserts the file has ZERO imports, no `require(`, no `process.env`, with comments stripped first. |
| 9 | red team | P2 | Refusal-table ORDERING was unpinned — every role case supplied `aal2` and every AAL case supplied an admin, so moving the role check below the AAL checks changed nothing red. | Two precedence tests added: non-admin + unreadable AAL → `Forbidden` (role outranks assurance), and bad credential + non-admin → `Unauthorized` (authentication outranks authorization). |
| 10 | standards | P2 | `getCurrentUser`'s "Migration note (034)" was a second live copy of a fact now owned by `loadAppUser`, attached to code that no longer holds the query. | Note removed from `getCurrentUser`; it lives once, on `loadAppUser`. |
| 11 | standards | P2 | `resolveCookieIdentity` is exported with no production consumer while `resolveBearerIdentity` is private, contradicting the "two sibling resolvers" framing. | Framing corrected in the module header: siblings in structure, deliberately asymmetric in reachability — exporting the bearer arm would hand a caller the bearer path WITHOUT the transport decision, which is the one thing the predicate owns. |
| 12 | red team | P2 | The JWKS "pays no extra fetch" claim is conditional: `fetchJwk` bypasses the TTL on an unknown `kid`. | Intake edge case corrected, and flagged as an amplification surface for #1185 to weigh. |

## Rejected, with reasoning

| # | Axis | Sev | Finding | Verdict |
|---|---|---|---|---|
| 13 | standards | **P1** | The 22 suites carry an identical ~20-line shim with no shared helper; `src/__tests__/helpers/` is the precedent, and the miss mode is a silently vacuous authorization test. | **REJECTED for this branch, deferred to #1184 — and the reviewer is right on the engineering.** A shared helper needs a new file outside the declared surface, which would be surface amendment #3 on a branch that already flagged #2 to the orchestrator. The risk it protects against is a FUTURE edit, and #1184 edits all 22 of these files anyway (it folds the nine role-only GETs and widens `ci:admin-aal2`), so it is both the natural and the cheaper home. Carried into the PR description and the ticket comment so it cannot be lost. Mitigating fact: the red team's three vacuity mutations all went red, so the shim is correct today. |
| 14 | standards | P2 | Dead scaffolding in all 22 suites — `vi.mock('@/lib/auth/mfa', …)` no longer intercepts the gate and the `cookieBackedServerClient` stub is never invoked. | **REJECTED, bundled with #13.** Same 22 files, same follow-up ticket. Removing it now is 22 more edits whose only benefit is tidiness, against a real risk of breaking a suite that uses the mfa mock for something else. |
| 15 | standards | P2 | Four `node_modules` line citations pinned to auth-js 2.106.2, resolving only against `dist/module/`, invalidated by any patch bump, with no pinning test. | **PARTIALLY ACCEPTED.** The brittle line numbers are gone from the module comment, which now cites file + symbol + version. The pinning test the finding really asks for is #7 above — it asserts the BEHAVIOUR the citations describe, which is what a bump would break and what a line number could never catch. |
| 16 | red team | P2 | Invariant #8 is enforced by a regex over SQL text, which breaks on behaviour-preserving reformatting; wants a live-DB row where A.`id` == B.`auth_id`. | **REJECTED, with the limitation recorded in the test.** A live-DB fixture flips the branch to `db_touching` and adds a gate row that SKIPs loudly without `TEST_DATABASE_POOL_URL` — the reviewer's own report grants the current assertion is not vacuous (mutation M6 killed it). The trade is deliberate: deterministic and offline now, and the assertion is written column-adjacent-to-placeholder so the common transposition is caught. |
| 17 | red team | P2 | Claim 1 is a module contract, not end-to-end: proxy branch 4 still gates `/api/admin` on the cookie, so no bearer reaches the gate in any deployed environment. | **ACKNOWLEDGED, no change.** Already declared in the plan, the intake `user_visible_behavior` and the staging-smoke section — it is the #1185 boundary, and the reason this ticket's staging evidence is unit/integration plus a cookie-mode 401 rather than a live bearer call. |

## Round 2 (red team, scoped to the fix hunks) — 6 mutations, 2 survived

Round 2 ran against `dbefb3b8`. It confirmed the round-1 fixes (the `AuthUnknownError`
arm is correct AND complete against all five `handleError` throw sites; the cookie
revert is pinned) and that four of the five rejections above hold. It also broke two
things I had just added.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 18 | **P0** | My own Edge guard was line-oriented: `import 'node:crypto';` (no `from`) and a Prettier-wrapped `import {\n x,\n} from …` both walked through it. Two of six mutations survived, and it was the SOLE mechanical enforcement of the module's hard Edge constraint. | **FIXED.** The guard now scans for the `import` TOKEN over the whole comment-stripped file rather than matching a line shape. Re-verified by mutating all four forms (bare, wrapped, single-line, dynamic `await import()`) into the module: **4 caught, 0 survived**, file restored. A guard that only catches the tidy form of a violation is not a guard. |
| 19 | **P1** | The corrected classifier comment swapped one false enumeration for another — `handleError` raises FIVE shapes, not "exactly three"; `AuthWeakPasswordError` and `AuthSessionMissingError` were omitted. | **FIXED.** The comment now enumerates all five and says why the other two correctly fall through to 401 (both are genuine credential refusals). The arm itself was already complete — round 2 confirmed that separately. |
| 20 | **P1** | The unstubbed SDK test is named "throws **non-AuthError**" but asserted only `.rejects.toThrow()`, which an `AuthError` satisfies — so the exact channel move it exists to catch (a thrown `AuthApiError(500)` letting an unauthenticated caller force admin 500s) kept it green. | **FIXED.** It now captures the thrown value and asserts `isAuthError(thrown) === false`. |
| 21 | P2 | The second refusal-precedence test pinned no precedence — the gate refuses before `loadAppUser`, so its `OWNER_ROW` was inert and the test was behaviourally identical to "bearer with a forged signature". | **FIXED.** The `sql` double now counts calls and the test asserts the users table was NEVER queried, which pins the order and, separately, that a refused credential costs no database round-trip. |
| 22 | P2 | The cookie revert is complete for classification but not for ORDER: the AAL read now precedes the role check, so a non-admin with a THROWING AAL gets 500 where the fork gave 403, plus one extra AAL round-trip per refused cookie request. | **DECLARED, not fixed** — deviations D6 and the gate docblock. Fixing it means a lazy AAL thunk, which trades the seam's flat `{ authUserId, aal, transport }` result (the shape ADR 0025 D1 specifies) for a saving on the path where a non-admin hits the admin API. Fail-closed, needs a Supabase fault and a non-admin simultaneously. |
| 23 | P2 | Two of the nine rewritten `lib-platform.md` rows dropped facts not verbatim in the file they now point at: `mfa.ts`'s remaining consumers, and `reset-password-error.ts`'s "house rule for **every** Supabase error". | **FIXED.** Both restored. The other seven drops re-resolved clean. |
| 24 | P2 | `namedAuthError('AuthUnknownError', 500)` is a shape the SDK cannot produce — its constructor is `(message, originalError)` and never sets a status. | **FIXED.** The impossible variant is gone; the statusless form the SDK actually produces remains, with a comment saying why. |
| 25 | P2 | Rejection #16 above claimed the limitation was "recorded in the test"; `auth.test.ts` was byte-unchanged and its comment recorded the assertion's strength, not its limitation. | **FIXED** — the reviewer was right that the stated fact was false. The limitation is now genuinely in the test: a reformat turns it red, and the comment says the ASSERTION needs updating, not the query. |

**RT2 remains open by design**: the alert-path finding is answered by correcting the
claim, not by building the alert. No authorization to add an alert sink was sought or
granted; it is named as a follow-up in the PR description.

## Owner adjudication — 2026-09-07

Both items this run escalated came back decided.

| Item | Owner decision | Recorded as |
|---|---|---|
| **Surface amendment #2** — `.claude/reference/arch-review-log.md` + `scripts/ci/tenant-scope-allowlist.ts`, both CI-mandated for any production change | **APPROVED** — "CI-mandated ledger files, zero behaviour" | Deviations D5, with the approval line. `surfaceAmendments=2` stands. |
| **RT2** — the admin 5xx has no alert path | **ACCEPT RISK + follow-up ticket** | Sidecar: RT2 → `accepted-risk` referencing `AUTH-RT2` ("owner 2026-09-07: accepted-risk, follow-up alerting ticket"). Follow-up cut as **#1212**, `wayfinder:task,area:alerting`, carrying the measurements so they are not re-derived. |

RT2's disposition changed; the finding did not. The gap is still real and still open
in the codebase — `internalError` remains `console.error` only. What was accepted is
shipping #1183 while it is open, on the argument that this branch made the 500 signal
*correct* rather than laundering an outage into 401s, and that routing it is separate
work. `red-team-status.mjs` now passes with status `CLEAR`: `p0_open` 0, `p1_open` 0,
`p2_open` 0, `accepted_risk` 1, 12 fixed, 3 rejected.

The one rejected finding still worth carrying forward is **#13** — the migration shim
duplicated verbatim across 22 suites. It is deferred to **#1184**, which edits all 22
of those files anyway; its miss mode is a silently vacuous authorization test, so it
should not be lost.
