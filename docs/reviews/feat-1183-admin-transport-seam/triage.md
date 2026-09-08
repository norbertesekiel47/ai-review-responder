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
