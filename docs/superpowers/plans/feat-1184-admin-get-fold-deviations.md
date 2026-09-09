# feat/1184-admin-get-fold — deviations

Entries are things the plan did not anticipate, or a locked expectation the
tree falsified. Every entry carries a **Verdict:** ACCEPT or RE-PLAN before the
review wave (`/feature` step 6).

---

## D1 — Surface amendment #1: one test file for the new shim

**What.** `src/lib/auth/__tests__/admin-gate-mocks.test.ts` was added to
`allowed_edit_surface` after the plan-skeptic round.

**Why.** Plan-skeptic finding 5: the shared shim needs its own suite, and the
anti-vacuity pin (the nine folded suites must not mock
`@/lib/auth/admin-mfa-gate`) needs somewhere to live. `vitest` only collects
`*.test.ts`, so the helper's tests cannot be colocated inside the helper file.

**Authority.** Auto-approved by the step 2 rule — one file, inside
`src/lib/auth/__tests__/`, a tree the surface already reaches. Counted:
`surfaceAmendments=1`. A second amendment is a hard stop for this run.

**Verdict:** ACCEPT

---

## D2 — `/admin/businesses/[id]`'s recorded `aal2: false` reason is falsified

**What.** The audit header (`scripts/ci/admin-aal2-audit.ts`, "WHAT P2 IS
DELIBERATELY NOT") and the page's own comment both record
`/admin/businesses/[id]` as deliberately `aal2: false`, reasoned as "Gate parity
with GET /api/admin/businesses/[id] — plain admin role, no AAL2". Folding that
GET onto `requireAdminWithAal2` makes the sentence false.

**Why it is not a re-plan.** The orchestrator's brief anticipated exactly this:
keep the anchor at `aal2: false` ONLY if its recorded reason still holds, and
otherwise follow rule P2 and record the flip. The reason does not hold, so the
page flips with the other five. P2 itself is unchanged — it was always parity,
never "pages hosting mutations need AAL2", and the header still teaches that,
restated so it no longer cites a page that is now AAL2.

**Verdict:** ACCEPT

---

## D3 — The transport knob in the first shim draft

**What.** The plan's first shim API exposed `gateTransport: { current }` so a
suite could declare bearer mode. Replaced by deriving transport from the request
through the production `isBearerRequest`.

**Why.** Plan-skeptic finding 4: `requireAdminWithAal2` reads only `authUserId`
and `aal`, so a knob-driven "bearer ok" test asserts nothing the cookie test
does not. Deriving from a real `Authorization` header makes the per-route bearer
case a genuine transport test and keeps the predicate single-owner (ADR 0025 D6).

**Verdict:** ACCEPT

---
