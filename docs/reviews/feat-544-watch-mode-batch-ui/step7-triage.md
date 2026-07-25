# Step 7 review triage — #544 watch-mode batch UI

Two review agents ran in parallel on `git diff b266ca00..HEAD`, one per axis, each
returning only >=80%-confidence findings. Full reports alongside this file:
`step7-spec-correctness.md`, `step7-standards.md`.

**Outcome: 9 findings, 9 ACCEPTED, 0 REJECTED.** All fixes landed in `18638afe`.
No finding invalidated a locked intake decision, so the abort criteria did not fire.

> Triage verdicts live in this file rather than being appended into each report,
> so the accept/reject state is in one place for a resumed session. The reports
> themselves are unmodified reviewer output.

## Spec & correctness axis

| # | Severity | Finding | Verdict |
|---|---|---|---|
| S1 | medium | Every 404 mapped to `'gone'`, so an unresolvable *location* scope told the owner the feature was "switched off for your account" | **ACCEPT.** Fixed by softening the copy, deliberately NOT by distinguishing the two 404s — the flag-off 404 must stay indistinguishable from "route does not exist" (invariant #13), so a distinguishing error code would have leaked flag state. Cause-neutral copy fixes the lie without opening that hole. |
| S2 | low | `user_visible_behavior` #11 unimplemented — no header link, so `building`/`stalled`/`error`/aggregate screens had no path to the upload surface | **ACCEPT.** A named contract item was simply missing; `TopBar rightLink` added, asserted across all six states. |
| S3 | low | Internal `Vertical` enum rendered in owner prose ("for `personal_care`") | **ACCEPT.** The withhold codes got owner-readable labels and this second closed enum did not — inconsistent treatment of the same problem. Now a `Record<Vertical, string>` so enum drift is a compile error. |
| S4 | low | `markBatchReviewed`'s 0-vs-1 return discarded; a zero-row update would silently lose the engagement signal | **ACCEPT.** Independently flagged by both axes, which is why it was fixed rather than waved off as theoretical: the client is currently correct, so this was a missing guard-rail on the exact failure the route's own comment names. |

## Standards & maintainability axis

| # | Severity | Finding | Verdict |
|---|---|---|---|
| M1 | medium | `prefers-reduced-motion` override scoped `.rq-stack .section-enter`; 3 of 6 screens still animated | **ACCEPT.** The file claimed to compensate for `console.css`'s unguarded rule and didn't cover its own surface. Re-scoped to `.rq-surface`, pinned by test. |
| M2 | medium | `SOLICITATION_SCOPE_PARAM` claimed single ownership of the `scope` param while `policy.ts:48` reads a literal and four clients hardcoded `?scope=` | **ACCEPT, with a scoped resolution.** The *reader* (`src/app/api/dashboard/policy.ts`) is outside `allowed_edit_surface`, and widening the surface a second time would trip the abort criteria for a naming cleanup. Fixed what is in surface (client call sites now use the constant) and corrected the comment to claim what is true — it MIRRORS the name `policy.ts` reads and must stay in lockstep. An honest smaller claim beats a widened surface. `docs/directory.md` carried the same false claim and was corrected too. |
| M3 | medium | Live region never cleared `message`; a second `building → built` transition re-set an identical string, React bailed, nothing announced | **ACCEPT.** Real a11y defect on a repeat transition reachable via the location switcher. Note the naive "clear it in an effect" fix was rejected by `react-hooks/set-state-in-effect`; the announcement is now produced by the poll loop that observes the transition and carried on scope-keyed state. |
| M4 | low | `markBatchReviewed` return contract honored by no caller — speculative generality plus a comment describing unimplemented behavior | **ACCEPT.** Same defect as S4 from the maintainability side. Resolved by making the contract real (route logs the row count) rather than deleting it, because the diagnostic it promises is genuinely wanted. |
| M5 | low | `GhostPipeline` props admitted invalid states — `mode="no_batch" stalled` typechecked; `stalled` without `onCheckAgain` rendered a dead button | **ACCEPT.** Discriminated union now defines the invalid states away instead of branching around them (design.md). |

## Follow-ups deliberately NOT fixed here

- `console.css`'s `.section-enter` is unguarded for `prefers-reduced-motion` at
  source, and its `.btn` has no `min-height` and no `:focus-visible` rule — so
  other console surfaces likely miss the 44px/focus/reduced-motion criteria this
  surface had to satisfy locally. Outside this ticket's edit surface; needs its
  own ticket.
- `src/app/api/dashboard/policy.ts` should import `SOLICITATION_SCOPE_PARAM`
  instead of reading the literal `'scope'`, making the one-owner claim true.
  Outside edit surface (see M2).
- Task 6 (solicitation route access-policy rename) was dropped — see the
  deviations file for reasoning.
