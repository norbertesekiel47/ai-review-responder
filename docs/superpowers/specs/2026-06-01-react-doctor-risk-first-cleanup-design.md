# React Doctor Risk-First Cleanup — Design Spec

- **Date:** 2026-06-01
- **Status:** Draft, design approved; not implemented
- **Owner:** Norbert Esekiel
- **Origin:** React Doctor full scan reported score 49/100 with 548 diagnostics.
- **Trace:** `/var/folders/x0/7xsr73k947jcdnk0qp827dr00000gn/T/react-doctor-3f4df799-631b-48bf-aa90-bc23bf76d0d9`

## 1. Problem

React Doctor reports a large volume of findings across the app:

- 13 errors
- 535 warnings
- 153 architecture warnings
- 138 performance warnings
- 80 state/effect warnings
- 70 accessibility warnings
- 36 Next.js warnings
- 29 correctness warnings

The raw score is useful as a signal, but the findings are not equally valuable.
Some are likely real defects or accessibility gaps. Others are broad style,
copy, or bundle-size cleanup that would create noisy churn without reducing
launch risk.

The goal is a solvable remediation pass that improves user-facing correctness
and safety without turning into a repository-wide score-chasing PR.

## 2. Goals

- Prioritize findings with plausible behavioral, accessibility, or security
  impact.
- Keep each implementation slice reviewable and independently verifiable.
- Treat React Doctor findings as hypotheses, not commands.
- Preserve project invariants, especially approval-token security, outbox use,
  subscription gating, and worker ordering semantics.
- Measure improvement with `pnpm doctor -- --verbose --diff`, but do not make
  score movement the primary success criterion.

## 3. Non-goals

- No broad copy cleanup for em dashes, ellipses, or similar presentation-only
  rules in this pass.
- No large `useReducer` rewrites unless needed to fix a concrete stale-state
  bug.
- No marketing-page component decomposition just to satisfy "giant component"
  warnings.
- No bulk async parallelization in workers, pollers, queue dispatch, billing,
  audit, or third-party integration code.
- No `LazyMotion`, module-scope static-value, or internal `Link` sweep unless a
  touched file makes the fix trivial and low-risk.

## 4. Diagnostic Tiers

### Tier 0: Errors

Fix error-class diagnostics first, but classify each one before editing.

**Fix by default**

- `react-doctor/effect-needs-cleanup`
  - Missing `removeEventListener`, `clearTimeout`, `clearInterval`, or
    equivalent cleanup can leak work after unmount or after an effect reruns.
  - Current examples include `PlaceAutocomplete`, dashboard hash-scroll timers,
    aggregate dashboard hash-scroll timers, and edit-reply polling timers.
  - The edit-reply polling timer is the highest-risk target because it is a
    self-rescheduling `setTimeout(tick, ...)` loop. Preserve recursive polling:
    store the active timer id, clear exactly that id in cleanup, and add a
    dedicated regression test proving polling continues while regenerating and
    stops after unmount/state exit.

- `react-doctor/no-adjust-state-on-prop-change`
  - Fix only where the state reset can show stale UI, reset user input
    incorrectly, or cause hydration/render glitches.
  - Prefer deriving state, lazy initialization, or render-time prev-prop
    reconciliation over effect-driven resets.
  - Treat each refactor as a behavior change. If a touched component has no
    existing test, add a focused regression test or defer the refactor.

**Review carefully before changing**

- `react-doctor/nextjs-no-side-effect-in-get-handler` on
  `src/app/api/approve/[token]/route.ts`.
  - This is likely a false positive because the rule appears to flag
    `createHash(...).update(...)`, not a database mutation.
  - The project `approval-security` skill explicitly allows read-only GET
    validation plus CSRF/device cookie setup for the approval page.
  - Do not convert this route to POST unless a manual security review finds a
    real unsafe state mutation.
  - Do not remove or relocate `setDeviceCookie` or `setCsrfCookie` to appease
    the rule. Cookie setup on GET is part of the approved approval-security
    flow; the actual approval mutation stays in POST routes.

### Tier 1: Accessibility

Fix accessibility warnings that affect real app use:

- unlabeled controls
- click handlers on non-interactive elements without keyboard support
- static elements used as controls
- tiny body text
- unnecessary `autoFocus`
- non-interactive `tabIndex`

Preferred fixes use semantic controls first: `button`, `label`, `fieldset`,
`legend`, and visible text. Use `aria-label` or `aria-labelledby` only when a
visible label would be inappropriate for the existing UI.

When replacing a clickable non-button with `button`, preserve the existing
non-submit behavior with `type="button"` unless the control is intentionally
submitting a form. Reset or reuse existing classes so native button styling does
not shift layout, and spot-check tab order after the change.

### Tier 2: Correctness

Fix correctness warnings when the underlying list or state is dynamic:

- array-index keys in editable, reorderable, filterable, or stateful lists
- hook dependency warnings where a stale closure is plausible
- hydration mismatch warnings involving `Date.now()` or time-based render output
- uncontrolled input warnings in forms that can lose user edits

Static decorative maps on marketing pages may be deferred unless they are
trivial to fix with a stable data-derived key.

For key changes, the replacement key must be both stable and unique among
siblings. If the data has no unique identifier, use a deterministic composite
that is proven unique for that list; otherwise defer the finding rather than
replacing an index key with a collision-prone key.

### Tier 3: Async And Server Performance

Only parallelize independent async work when independence is proven.

Do not bulk-convert:

- `for...of` loops that intentionally bound concurrency
- queue dispatch loops where per-row failure handling matters
- pollers that mark rows in sequence
- Stripe/Zernio/Twilio/Telegram/Resend calls with rate, ordering, or idempotency
  concerns
- work inside `sql.begin()` transactions
- audit writes that must follow a state transition

Safe candidates usually look like adjacent server reads with no shared mutable
state and no dependency between results. Use `Promise.all` only after checking
that errors, logging, and partial-failure behavior remain equivalent.

## 5. Work Slices

### Slice A: Error Cleanup

Scope:

- effect cleanup fixes
- state reset fixes with clear stale-UI risk
- approval GET route manual review and explicit no-op decision if false
  positive

Validation:

- targeted unit tests for touched hooks/components; add a focused test when the
  change alters polling, state reset, or lifecycle behavior
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm doctor -- --verbose --diff`

### Slice B: Accessibility Cleanup

Scope:

- unlabeled controls
- keyboard access gaps
- semantic-control replacements
- tiny text and autofocus only where user-facing

Validation:

- relevant component or page tests if present
- browser spot-check for any changed UI flow
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm doctor -- --verbose --diff`

### Slice C: Correctness Cleanup

Scope:

- dynamic/stateful array keys
- hydration-time warnings
- concrete hook dependency issues
- uncontrolled inputs with user data risk

Validation:

- targeted tests around changed behavior
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm doctor -- --verbose --diff`

### Slice D: Async Triage

Scope:

- inspect async warnings and classify each as `fix`, `defer`, or `intentional`
- implement only obvious independent server read parallelization
- leave worker/poller/provider loops unchanged unless a proof of equivalence is
  documented in the PR

Validation:

- narrow tests for touched route/service/worker code
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm doctor -- --verbose --diff`

## 6. Review Rules

- Each PR should mention which tiers and rules it covers.
- Each deferred rule should have a one-line reason in the PR notes if it was
  inspected.
- Do not suppress rules unless the code is intentionally correct and a local
  comment would help future reviewers.
- Avoid mixing high-risk behavior fixes with cosmetic score cleanup.
- Preserve unrelated user changes; do not rewrite touched files broadly.
- `pnpm doctor -- --verbose --diff` is a regression signal for touched files,
  not a replacement for the app test suite. Shared-component edits can break
  downstream flows that do not appear in the doctor diff.

## 7. Success Criteria

The cleanup is successful when:

- all real Tier 0 errors are fixed or explicitly classified as false positives
  with project-specific reasoning
- accessibility issues in active product surfaces are materially reduced
- dynamic/stateful key and hydration issues are addressed where they can affect
  correctness
- async changes are limited to proven-independent operations
- behavior-changing fixes have focused regression coverage, even when no prior
  test existed
- `pnpm lint` passes
- `pnpm typecheck` passes
- `pnpm test` passes
- `pnpm build` passes
- `pnpm doctor -- --verbose --diff` shows no regressions in touched files

React Doctor score improvement is useful, but it is not the acceptance gate for
this risk-first pass.

## 8. Implementation Plan Entry Point

When ready to implement, use the `writing-plans` skill to turn this design into
a phased plan. Start with Slice A because it has the highest signal-to-risk
ratio and the smallest review surface.
