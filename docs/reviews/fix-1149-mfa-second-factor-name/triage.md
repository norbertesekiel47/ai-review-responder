# Review triage — fix/1149-mfa-second-factor-name, round 1

Reviewed SHA `25bf1b3fda644238778fa1322b3da5055f8e8c30`, merge-base `75c8d54cb77ac34d1f2f7686b9171528871b81f3`.
Measured production diff (tests excluded): 59 added / 3 removed in two files. RISK = high, so the
standards axis ran regardless of the 300-line threshold. Wave: spec-correctness (+ security lens),
standards-maintainability, adversarial-approach (Codex `gpt-6-astra`, session
`01a0c4c8-81bc-7233-82a2-caeb36cba921`), red team (`docs/reviews/red-team/fix-1149-mfa-second-factor-name-05137d/`).
Every axis: REVISE. The per-finding JSONL transcript (`review-log.mjs`) was not populated; this file is the record.

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| Spec F3 · Std S1 · RT-1149-F1 — the invariant property cannot falsify its invariant | P1 | ACCEPT | Three independent reviewers; red team measured it: mutant `return 'RepWorth'` stays green, 0 useful inputs in 100,000 draws of `fc.string()`. Fix: draw names from the `RepWorth N` sequence mixed with arbitrary strings and null. |
| Spec F1 · Codex F2 — the start→cancel→start test puts an unverified factor under `totp`, a payload auth-js 2.106.2 never emits | P2 | ACCEPT | Verified by both reviewers against `GoTrueClient` (`all` gets every factor, `totp` only verified). Deleting the `all` arm of `collectFactors` leaves the suite green and re-creates #1149. Fix: `totp: [], all: [unverified]` plus a mixed fixture. |
| Spec F4 · RT-1149-F2 · Codex (e) — provider text reaches a string `isStepUpRequiredError` (`SecuritySections.tsx:42`) sniffs with `/sign in again/i` | P2 | ACCEPT | New coupling this branch created. Fix inside the hook (the presentation file is a non-goal and outside the surface): provider text that would trigger the step-up affordance is never surfaced. |
| Spec F2 · Codex F1 — every start→cancel now banks another unverified factor; the factor-limit copy points at an AAL2-gated unenroll | P2 | OWNER — DEFERRED TO STAGING | Conflicts with the locked non-goal "no cleanup of abandoned unverified factors". Owner decision 2026-09-21: keep the non-goal, measure GoTrue's unverified-factor expiry during the staging ride, record the result; if they do not expire, file a ticket for a server-side cancel operation and the PR waits for the owner. Nobody could verify GoTrue's behavior offline. |
| Std S2 — three-deep `mockResolvedValueOnce` queue departs from the file's precedent | P3 | ACCEPT | Folded into the F1 test rewrite: re-set `mockResolvedValue` per phase. |
| Std S3 — the fresh list is mined for names and discarded; `state.factors` stays stale under a comment that diagnoses staleness | P3 | ACCEPT (comment) | Dispatching `loadSuccess` would be a behavior the intake does not name. State that the discard is deliberate. |
| Std S4 — `docs/directory/lib-platform.md` row for `mfa.ts` omits the new export and its caller obligation | P3 | ACCEPT | One owner per fact: the code map is where a reader looks. |
| Std S5 — four titles restate the function name; the property is not in an `invariants` block | P3 | PARTIAL | REJECT the rename: the titles are locked verbatim by the intake and grepped by the gate's `promised-tests` row; the fault is the intake's title source, recorded as an intake-authoring lesson. ACCEPT moving the property into a `nextFactorFriendlyName invariants` describe block (house style, `sentiment.test.ts`). |
| Codex (a) — GoTrue's exact/case-sensitive conflict check across statuses is asserted, not evidenced | appendix | NOTED | Verified on staging with the F2 measurement. |
| Codex (c) — read-then-enroll is not atomic; "Reload the page" is unnecessary advice | appendix | REJECT | The copy is locked by the intake and is harmless; the mapped conflict is the recoverable outcome. |
| Codex (f) — numeric suffixes do not identify devices | appendix | REJECT | Locked decision; a user-editable name is a named non-goal. |

# Round 2 (verification-only) — fix commit `e9cdaa2b12bf84575b66f249d13ca91dea49f000`

Members: one Claude verification agent (`round-2-verification.md`, APPROVED, 7/7 accepted findings ADDRESSED),
the Codex session resumed (`adversarial-round-2.md`, no fix-introduced defect; REVISE on the staging plan only),
red team round 2 (7 of 8 mutants killed; the round-1 survivor M4a is KILLED; the one survivor is proven equivalent;
RT-1149-F1 and F2 CLOSED; status OPEN_P1 on one new stale line reference). The red-team cap is two rounds; the
owner authorized a third round on 2026-09-21, scoped to the round-3 fix hunks (recorded in the sidecar).

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| RT-1149-F4 · Verif N1 — the rewritten `lib-platform.md` row re-asserts `src/proxy.ts:92-103` for the lenient AAL read; those lines are `adminCorsPreflight`, the read is `getAalGate` at `:260-271` | P1 | ACCEPT | A stale line span in a row this branch rewrote. One-line fix. |
| RT-1149-F3 · Verif N3 — two unbound copies of `/sign in again/i`; the new test asserts the copy string, not the consumer's predicate | P2 | ACCEPT | Bind them in a test: the hook's error for a provider message carrying the phrase must make `isStepUpRequiredError` false, and the unenroll 403 text must make it true. |
| RT-1149-F5 — property 2 is vacuous when the result is `RepWorth` | P2 | ACCEPT | One line: assert inside property 2 that the result is not taken, so its title is true on its own. |
| Verif N2 — the step-up guard carves an exception into a locked `user_visible_behavior` bullet and D5 does not say so | P3 | ACCEPT | Recorded in the deviations file (D5). |
| Codex round 2 — the staging measurement plan is too loose | — | ACCEPT | D4 now names four measurements: real capacity from zero verified factors, expiry timing and trigger, recovery AT capacity, and how long a first-time owner stays blocked. An inconclusive result also holds the PR. |

Round 3 for this branch is the authorized third red-team round on the fix hunks; no separate Claude verification
agent runs, because the round-3 diff is one doc line and two test assertions and the red team covers exactly that scope.
