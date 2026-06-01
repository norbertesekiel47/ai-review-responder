# React Doctor Risk-First Slice B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce real accessibility diagnostics from React Doctor Slice B on active product surfaces while preserving UI behavior.

**Architecture:** Apply semantic HTML first where low-risk, add `htmlFor`/`id` and `aria-label` only where visible labels are already present or icon-only controls need names, and keep form buttons explicitly `type="button"` unless they intentionally submit. Defer native `<dialog>` rewrites because they change focus trapping, Escape handling, scroll locking, and backdrop behavior.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest, Testing Library, React Doctor.

---

## Scope Check

This plan implements Slice B from `docs/superpowers/specs/2026-06-01-react-doctor-risk-first-cleanup-design.md` on a fresh branch from `origin/main`.

Included:

- `control-has-associated-label`
- `label-has-associated-control`
- `no-autofocus`
- `click-events-have-key-events`
- `no-static-element-interactions`
- `no-noninteractive-tabindex`
- `no-tiny-text`
- `design-no-vague-button-label`
- low-risk `prefer-tag-over-role`
- low-risk `no-gray-on-colored-background`

Deferred:

- `prefer-html-dialog` in `PastDueModal` and `EditReplyDrawer`. Native `<dialog>` conversion is valuable but changes modal lifecycle and focus behavior. It needs a dedicated modal behavior slice with browser checks.
- marketing or demo-only semantic role swaps where the current implementation is not a real keyboard trap and where changing markup could affect layout. These can be handled after active product surfaces.

Canonical React Doctor recipes fetched before this plan:

- `react-doctor/control-has-associated-label`
- `react-doctor/label-has-associated-control`
- `react-doctor/no-autofocus`
- `react-doctor/no-static-element-interactions`
- `react-doctor/click-events-have-key-events`
- `react-doctor/no-noninteractive-tabindex`
- `react-doctor/no-tiny-text`
- `react-doctor/design-no-vague-button-label`
- `react-doctor/prefer-tag-over-role`
- `react-doctor/no-gray-on-colored-background`
- `react-doctor/prefer-html-dialog`

## File Structure

Modify:

- `src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx`
  - Add an explicit label for the search input.
- `src/app/(authenticated)/dashboard/add-location/wizard/steps/Step1Location.tsx`
  - Remove page-load `autoFocus`, associate the address label with the manual URL field, and name the autocomplete custom control.
- `src/app/(authenticated)/dashboard/add-location/wizard/steps/Step3Voice.tsx`
  - Add a visible associated label/id to the products/services textarea.
- `src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx`
  - Associate the locked owner email label/input.
- `src/app/admin/businesses/[id]/components/TrackedKeywordsSection.tsx`
  - Add an accessible name to the new keyword input.
- `src/app/admin/businesses/[id]/components/ManualRankingSection.tsx`
  - Associate keyword, rank, and date labels/inputs.
- `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx`
  - Replace gray text on pale blue status background with blue text.
- `src/app/admin/businesses/[id]/components/ReviewsList.tsx`
  - Replace gray text on pale blue status background with blue text.
- `src/app/onboarding/business/StepLocation.tsx`
  - Add an accessible name to the manual Google Maps URL input.
- `src/app/onboarding/start/StartLocationClient.tsx`
  - Add an accessible name to the manual Google Maps URL input.
- `src/app/mfa/challenge/page.tsx`
  - Remove page-load `autoFocus`; use native `<output>` for the verifying status.
- `src/components/auth/CheckEmailClient.tsx`
  - Remove page-load `autoFocus`.
- `src/components/auth/ForgotPasswordFormClient.tsx`
  - Remove page-load `autoFocus`.
- `src/components/auth/LoginFormClient.tsx`
  - Remove page-load `autoFocus`.
- `src/components/auth/ResetPasswordFormClient.tsx`
  - Remove page-load `autoFocus`.
- `src/components/dashboard/EditReplyDrawer.tsx`
  - Rename the success close button from `Done` to a specific action label.
- `src/components/dashboard/OwnerTelegramWidget.tsx`
  - Raise TTL caption text from 11px to 12px.
- `src/components/dashboard/OwnerWhatsAppWidget.tsx`
  - Raise TTL caption text from 11px to 12px.
- `src/components/dashboard/ReviewActions.tsx`
  - Add an accessible name to the edit textarea.
- `src/components/dashboard/Sidebar.tsx`
  - Raise sign-out error text from 11px to 12px.
- `src/components/dashboard/VelocityCard.tsx`
  - Raise KPI label text from 11px to 12px.
- `src/components/dashboard/aggregate/AggregateVelocityCard.tsx`
  - Raise KPI label text from 11px to 12px.
- `src/components/dashboard/aggregate/AggregateIntelligenceBriefCard.tsx`
  - Raise period label text from 11px to 12px.
- `src/components/dashboard/settings/AccountPanel.tsx`
  - Replace clickable overlay div with a semantic backdrop button and associate locked identity labels/inputs.
- `src/components/dashboard/settings/BrandVoicePanel.tsx`
  - Associate the products/services textarea with its section heading.
- `src/components/dashboard/settings/GeneralPanel.tsx`
  - Associate locked identity labels/inputs.
- `src/components/dashboard/settings/ListEditor.tsx`
  - Give each row input and remove button a specific accessible name.
- `src/components/dashboard/settings/LocationsPanel.tsx`
  - Replace clickable overlay divs with semantic backdrop buttons, name the edit-label input, remove edit `autoFocus`, and raise archived badge text.
- `src/components/dashboard/settings/PerLocationOverridePanel.tsx`
  - Raise primary badge text from 10px to 12px.
- `src/components/dashboard/settings/SettingsSkeleton.tsx`
  - Use native `<output>` for loading status.
- `src/components/dashboard/settings/ToneChipPicker.tsx`
  - Name the custom tone textarea.
- `src/app/(authenticated)/_styles/settings.css`
  - Add modal backdrop button styling for semantic backdrop controls.

Test/update:

- `src/app/(authenticated)/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx`
- `src/components/dashboard/settings/__tests__/ListEditor.test.tsx`
- `src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx`
- `src/components/dashboard/settings/__tests__/AccountPanel.test.ts`
- `src/components/dashboard/settings/__tests__/ToneChipPicker.test.tsx`

## Task 1: Label and Autofocus Fixes

- [ ] Add visible or aria labels to unlabeled inputs and textareas:
  - `aria-label="Search past replies"` for the past replies search input.
  - `id="add-location-address-url"` and `htmlFor="add-location-address-url"` for manual add-location URL input; pass `ariaLabel="Business address"` to `PlaceAutocomplete` only if the component supports it, otherwise add `aria-label` to the manual input.
  - `id`/`htmlFor` pairs for admin manual ranking fields: `manual-ranking-keyword`, `manual-ranking-rank`, `manual-ranking-date`.
  - `aria-label` for custom-edit textareas where a visible label is not present.
- [ ] Remove page-load `autoFocus` from auth, MFA, and wizard fields unless they are modal-only focus management.
- [ ] Run focused tests:

```bash
pnpm exec vitest run \
  'src/app/(authenticated)/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx' \
  src/components/dashboard/settings/__tests__/ToneChipPicker.test.tsx
```

- [ ] Commit:

```bash
git add src
git commit -m "fix: label accessible form controls"
```

## Task 2: Settings Modal Backdrop Semantics

- [ ] In `LocationsPanel.tsx` and `AccountPanel.tsx`, replace overlay-level `onClick` handlers with:

```tsx
<div className="modal-overlay">
  <button
    type="button"
    className="modal-backdrop"
    aria-label="Cancel archive"
    onClick={onCancel}
  />
  <div className="modal-content">
    ...
  </div>
</div>
```

- [ ] Add CSS:

```css
.modal-backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: default;
}
.modal-content {
  position: relative;
  z-index: 1;
}
```

- [ ] Keep every modal action button as `type="button"`.
- [ ] Run focused settings tests:

```bash
pnpm exec vitest run \
  src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx \
  src/components/dashboard/settings/__tests__/LocationsPanel.test.ts \
  src/components/dashboard/settings/__tests__/AccountPanel.test.ts
```

- [ ] Commit:

```bash
git add src/components/dashboard/settings/LocationsPanel.tsx src/components/dashboard/settings/AccountPanel.tsx 'src/app/(authenticated)/_styles/settings.css'
git commit -m "fix: use semantic settings modal backdrops"
```

## Task 3: Tiny Text, Vague Button, and Safe Semantic Swaps

- [ ] Raise text below 12px to 12px in owner channel widgets, velocity cards, settings badges, and sidebar error text.
- [ ] Rename the `EditReplyDrawer` success close button from `Done` to `Close editor`.
- [ ] Replace low-risk `role="status"` wrappers with `<output>` in `SettingsSkeleton` and MFA busy status.
- [ ] Replace gray text on pale blue backgrounds with blue-family text in admin status panels.
- [ ] Defer pricing's horizontally scrollable plan matrix `tabIndex={0}`. It is a public marketing surface, and the existing test asserts the focusable scroll region; changing it belongs in a dedicated pricing accessibility pass.
- [ ] Run focused tests:

```bash
pnpm exec vitest run \
  src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx \
  src/components/dashboard/__tests__/Sidebar.test.tsx \
  src/components/dashboard/settings/__tests__/ListEditor.test.tsx
```

- [ ] Commit:

```bash
git add src
git commit -m "fix: clean up low-risk accessibility polish"
```

## Task 4: Validation

- [ ] Run React Doctor diff:

```bash
pnpm exec react-doctor --verbose --diff
```

- [ ] Run project checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] If `pnpm build` hangs in the same Next/Turbopack production optimization phase as Slice A, record it as inconclusive with timing and do not claim build passes.

## Deferred Notes for PR

- `prefer-html-dialog`: deferred for a dedicated modal accessibility slice because native dialog changes focus trap, Escape handling, top-layer behavior, and backdrop rendering.
- `no-noninteractive-tabindex` in pricing: deferred because the plan matrix is intentionally focusable for keyboard access to a horizontal scroll region, and the existing pricing test asserts that behavior.
- Marketing/demo semantic role findings: defer unless touched by this branch; Slice B prioritizes active product surfaces and low-risk semantic fixes.
