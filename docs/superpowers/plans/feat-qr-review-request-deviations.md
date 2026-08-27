# feat-qr-review-request — deviations

- [2026-08-26] Codex R3 (final round, REVISE on 3/8): all three accepted —
  two mechanical TS fixes, plus a real correction: my R2 "file-granular
  allowlist" rationale was factually wrong (statement-granular in reality),
  so `getQrRedirectRow` moved INTO repo.ts per its ownership header. Round
  cap reached; owner sign-off substitutes for APPROVED per protocol.

- [2026-08-26] AMENDMENT #1 (narrowing, auto-approved per step 2 rule): removed
  `src/app/api/locations/review-qr/**` from `allowed_edit_surface`. The owner
  PNG endpoint is not built at all — the settings page server-renders QR data
  URLs (the `src/app/api/_shared/channels/start.ts` `QRCode.toDataURL`
  precedent), and the download anchor uses the data URL directly. One fewer
  route, no route-auth surface, smaller diff. Both intake copies updated.
- [2026-08-26] Test retitle (deviations-file entry, not an amendment — the
  #643 rule): "rejects a review-qr asset request for a location outside the
  caller's account" → "returns only the caller's account locations from
  getOwnerReviewQrLocations". Same tenant-scope intent; with the endpoint
  dropped, scoping is enforced by the module query (`WHERE account_id = …`)
  plus `requireOwnerAccess` on the settings pages. Recorded for owner
  visibility at step 6 read-back.
- [2026-08-26] AMENDMENT #2 (owner-approved via sign-off question): added
  `scripts/ci/tenant-scope-allowlist.ts` + `docs/analytics/events.md` to
  `allowed_edit_surface`. Codex R1: (a) the public QR redirect's by-UUID
  lookup needs one allowlist entry (category `pre-auth-token` — the audit's
  own designed escape); (b) `ci:analytics-events` compares the registry to
  `docs/analytics/events.md`, so the new event needs its doc row in the same
  PR. Amendment budget now at 2 — the step-5 `reclassify` WARN will fire by
  rule; disposition: both amendments are additive one-file scope, owner-signed,
  lane stays `high` (already the heaviest non-epic lane).
- [2026-08-26] Intake edge-case CORRECTION (codex R1 finding 1, verified at
  `src/lib/auth/require-owner-access.ts:81`): `requireOwnerAccess` redirects
  `pending_payment` owners to `/onboarding/pay` on EVERY settings page. The
  intake line "pending_payment owners can see and print" was my invention at
  grill time, not an owner decision; corrected to the standard settings
  posture. The redirect-side gate (`subscriptionAllowsQrRedirect`) is
  unchanged.
- [2026-08-26] `tests_to_add` ADDITIONS (5 titles, codex R1 accepted
  findings): distinct event keys per scan; live tenant-exclusion; live
  authoritative-column gate; never client-enqueueable; ids shipped in event
  properties. Recorded as deviations-file entries per the #643 rule.
- [2026-08-26] AMENDMENT #3 (auto-approved category — 2 files inside
  directory trees the surface already covers): `src/lib/locations/repo.ts`
  (header gains the documented exception for the pre-auth QR read) and
  `src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`
  (extended with the Review QR nav assertion). Driven by codex R2 reversing
  two of my R1 rejections — its evidence was verified real (settings
  component tests ARE house standard; the sidebar test exists). Amendment
  count now 3 (one narrowing, one owner-signed widening, one auto-approved
  category); the step-5 reclassify disposition in the AMENDMENT #2 entry
  covers all three — all plan-time, all owner-visible, lane already `high`.
- [2026-08-26] `tests_to_add` ADDITIONS (3 UI titles, codex R2): sidebar nav
  entry, eligible-only download/print actions, PrintButton single
  window.print call. Authored test-first inside Task 6 (they need that
  task's component files), not in the Task 1 eval commit.
- [2026-08-26] Codex R1 REJECTIONS (recorded with reasoning, full table in
  the plan's review appendix): framework-level HEAD test (Next.js implements
  HEAD via GET; staging smoke covers it), UI component tests M17–M19 (no
  house precedent for page-component tests; build + staging screenshots
  cover), nav-visibility test M20 (the sidebar renders entries
  unconditionally — a constant cannot regress), the `feature-surface` RED
  complaint (fails by design until the surface's files exist), and the
  "missing skills" citation (subagent-driven-development / executing-plans
  are harness skills, verified present in this session).
