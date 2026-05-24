# Spec 19 — Accessibility

> **Goal:** WCAG 2.1 AA conformance, axe + Pa11y in CI blocking new violations, annual specialist audit, public VPAT for enterprise procurement.

---

## 1. Why this matters

Accessibility is the right thing to do and a procurement requirement for any government/education/enterprise customer. Catching violations in CI is cheap; fixing them after a launch screenshot lands on Twitter is not.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Dashboard + auth UI redesigned; design tokens live in `src/app/globals.css` (`--rw-*`), governed by the `repworth-brand-design` skill. No audit run.
- **No Radix/react-aria** — focus management is hand-rolled (e.g. `EditReplyDrawer`'s custom focus trap). ⚠️ Decide: adopt Radix primitives for new modals/dialogs (recommended — they handle focus/ESC/ARIA) vs. standardize the custom approach.
- **No axe-core / Pa11y / a11y tests**; `aria-label` coverage is sparse (~42 sites, selective).
- No VPAT. ⚠️ **No CI** — axe/Pa11y gates are blocked on standing up GitHub Actions ([Spec 24](./24-devops-deployment.md)).

## 3. Target state

### Standards
- **WCAG 2.1 AA conformance.**
- Section 508 compliance follows automatically (subset of WCAG 2.1 AA).
- Annual audit by accessibility specialist ($2–5k) once customer-facing surface stabilizes.

### CI checks
- **axe DevTools (axe-core)** integrated via Playwright E2E.
- **Pa11y CI** on key pages: marketing home, login, signup, dashboard home, response approval modal, settings.
- Fail PR on new violations.
- Allow regression budget = 0; existing violations grandfathered until cleanup PR, but no new violations admitted.

### Keyboard navigation
- Every interactive element tab-reachable.
- Visible focus state (no `outline: none` without replacement).
- Skip-to-main-content link on every page.
- Modal traps focus correctly (use `react-aria` or `@radix-ui/react-dialog`).
- Test every release with **keyboard-only** for 5 minutes on critical flows (signup, approve response, billing).

### Screen reader
- Test with **NVDA (Windows)** and **VoiceOver (macOS/iOS)** on every release.
- ARIA labels on every icon button.
- `aria-live` regions for async status (e.g., "Response published" toast).
- Form labels always associated with inputs.
- Headings in logical order (no jumping h1 → h4).

### Color contrast
- ≥ 4.5:1 for body text.
- ≥ 3:1 for large text and UI components.
- Verify with axe DevTools and the design system (`repworth-brand-design` tokens should already meet AA).

### Forms
- Every input has a visible label (placeholder alone insufficient).
- Error states announce via `aria-describedby` and visual.
- Required fields marked both visually and with `aria-required`.

### Public VPAT (Voluntary Product Accessibility Template)
- Generated at first enterprise ask.
- Use **accessibility.works** ($3–5k) or your auditor.
- Publish at `/legal/vpat`.

### Government / education
- Section 508 = WCAG 2.1 AA + Authority to Operate (ATO) for federal.
- Don't pursue gov/edu market until WCAG 2.1 AA is locked.

### Design system
- Use existing **`repworth-brand-design` skill** as the a11y-default source.
- Every new component goes through the design-system path; ad-hoc components require a11y review before merge.
- Document a11y checklist in `docs/design-system/a11y-checklist.md`.

## 4. Implementation tasks

1. Add `@axe-core/playwright` to E2E tests. Wire to existing `pnpm test:e2e` flow.
2. Add Pa11y CI GitHub Action targeting the 6 key pages listed in §3.
3. Configure CI to fail on **new** violations only (use baseline file `tests/a11y/baseline.json`).
4. Audit current top-5 pages with axe DevTools; log violations in `docs/a11y/findings-YYYY-MM.md`.
5. Fix critical + serious findings in a "Accessibility cleanup" PR.
6. Adopt `@radix-ui/*` primitives for any new modal/dropdown/dialog — they handle focus trap, ESC, ARIA correctly. ⚠️ Net-new dependency (none today); the existing custom focus trap in `EditReplyDrawer` is the migration template / first candidate.
7. Add skip-to-main-content link to root layout.
8. Add `repworth/a11y-icon-button-label` ESLint rule that flags `<button>` containing only an icon without `aria-label`.
9. Document a11y checklist in `docs/design-system/a11y-checklist.md`. Include in PR template for UI changes.
10. Calendar entry: annual specialist audit (book once stable customer-facing surface exists).
11. VPAT placeholder route (renders "VPAT available on request" until generated). ⚠️ No `/legal/*` routes exist yet (legal pages are `(public)/privacy` etc.) — place it per the routing decision in [Spec 17](./17-legal-compliance-docs.md) §3.

## 5. Acceptance criteria

- [ ] axe-core + Pa11y in CI; PRs fail on new violations.
- [ ] Baseline file captures existing violations; cleanup PR brings critical + serious to 0.
- [ ] All 6 key pages tested keyboard-only without dead-end.
- [ ] All 6 key pages pass screen-reader smoke test (NVDA or VoiceOver).
- [ ] Color-contrast violations = 0 on existing UI.
- [ ] Skip-to-main link present on root layout.
- [ ] `docs/design-system/a11y-checklist.md` exists and is in PR template.
- [ ] VPAT generated within 30 days of first enterprise ask.

## 6. Metrics

| Metric | Target |
|---|---|
| WCAG 2.1 AA conformance | Pass on 6 key pages |
| axe violations / PR (new) | 0 |
| Specialist audit cadence | Annual |
| Keyboard-only smoke pass rate | 100% on releases |
| VPAT availability | < 30 days from request |

## 7. Risks & mitigations

- **Risk:** Existing UI has many violations; cleanup PR balloons. **Mitigation:** baseline + new-only enforcement; cleanup is a planned project, not a blocker.
- **Risk:** Custom modal components used instead of Radix primitives. **Mitigation:** lint + design-system audit; deprecate non-Radix dialogs in a tracked issue.
- **Risk:** Color tokens drift from a11y-compliant. **Mitigation:** brand-design skill encodes tokens; design-token PRs require axe re-run.

## 8. Dependencies & cross-links

- [Spec 17 — Legal & Compliance Docs](./17-legal-compliance-docs.md) (VPAT publication)
- [Spec 23 — Testing & QA](./23-testing-qa.md) (CI integration)
- [Spec 18 — i18n](./18-i18n-localization.md) (RTL future support)
- Skill: `repworth-brand-design`
- Code anchors: `src/app/globals.css` (`--rw-*` tokens), `src/components/dashboard/EditReplyDrawer.tsx` (custom focus trap), `package.json` (no Radix/axe today)

## 9. Implementation in the current repo

- **axe + Pa11y are gated on CI** ([Spec 24](./24-devops-deployment.md)) — there's no `.github/workflows/` to fail PRs against. The `@axe-core/playwright` hook can run locally via `pnpm test:e2e` in the interim.
- **Radix is net-new.** The hand-rolled focus trap in `EditReplyDrawer` proves the patterns work but won't scale; introduce `@radix-ui/react-dialog` for new dialogs and migrate `EditReplyDrawer` first.
- **Contrast** is governed by the `--rw-*` tokens in `globals.css` + the `repworth-brand-design` skill — audit those token pairs once; fixes propagate.
- **VPAT route** placement waits on the [Spec 17](./17-legal-compliance-docs.md) `/legal/*`-vs-`(public)` routing decision.
- **The aria-label gap** (icon buttons) is the cheapest high-impact fix — sweep the ~42 existing usages and fill the icon-only buttons.

---
_Verified 2026-05-23 against migration head 042. Noted no Radix/react-aria (custom focus management), no axe/Pa11y, sparse aria-labels, design tokens in globals.css, and the CI + `/legal/*`-routing dependencies._
