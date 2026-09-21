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
