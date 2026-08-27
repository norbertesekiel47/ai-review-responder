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
- [2026-08-26] Task 1 (eval) LOCAL deviation — noUncheckedIndexedAccess in
  the plan's verbatim test blocks: the plan applied optional chaining only in
  the QR-encoding test (codex R3 #1), but tsconfig enables the flag globally
  and test files are typechecked, so the blocks' other index accesses
  (`calls[0].text`, route-test `insert.text/.values`, `locations[0].qrDataUrl`)
  were TS18048/TS2532 errors that no later task would fix. Extended the
  plan's own optional-chaining treatment to those 11 sites (assertion
  semantics unchanged — `expect(undefined)` still fails the matcher). After
  the fix, `tsc --noEmit` shows ONLY the six expected eval errors: 3×TS2307
  (`../review-qr` ×2, `../route`) + 3×TS2305/TS2339 (missing export
  `subscriptionAllowsQrRedirect`) — all resolved by Tasks 3–5.
- [2026-08-26] Task 1 count note: the plan's "fifteen in this task's files"
  is an off-by-one in prose — 14 intake titles land in Task 1's four files;
  "qr_scan_redirected is never client-enqueueable" lands in Task 2's
  `events.test.ts` (per Task 2 Step 2b and Task 1's binding Files list),
  and 3 UI titles in Task 6. 14 + 1 + 3 = 18. No title is missing.
- [2026-08-26] Task 1 integration-suite note: `seedLocation` models no
  `google_place_id`/`archived_at`/deprecated-`subscription_status`
  overrides ("match their real signatures, do not invent overrides"), so
  the suite seeds via the helper and sets those columns with plain UPDATEs
  (DML — the no-run-time-DDL convention is untouched). `assertSchemaReady`
  gets a suite-local `SchemaRequirement` over the base/multi-location
  columns the module reads — no schema-ready.ts export exists for them and
  creating one would touch a file outside Task 1's Files list.
- [2026-08-26] Task 4 LOCAL deviation — `ALLOWLIST_BASELINE` bump: the plan's
  Step 4 names only the new allowlist ENTRY, but the file enforces an
  exact-match growth gate (`ALLOWLIST_BASELINE`), so adding the entry
  mechanically requires 369 → 370 plus the file's conventional dated history
  comment. Bumped in the same commit; `ci:tenant-scope` passes at 370. One
  entry sufficed — the audit attributes the JOIN statement to `businesses`
  only, so no second `accounts` entry was needed.
- [2026-08-26] Codex R1 REJECTIONS (recorded with reasoning, full table in
  the plan's review appendix): framework-level HEAD test (Next.js implements
  HEAD via GET; staging smoke covers it), UI component tests M17–M19 (no
  house precedent for page-component tests; build + staging screenshots
  cover), nav-visibility test M20 (the sidebar renders entries
  unconditionally — a constant cannot regress), the `feature-surface` RED
  complaint (fails by design until the surface's files exist), and the
  "missing skills" citation (subagent-driven-development / executing-plans
  are harness skills, verified present in this session).
- [2026-08-26] Task 6 LOCAL deviation — print page root is `<section>`, not
  the plan's `<main>`: the authenticated shell already renders
  `<main id="main-content">` around every settings child, and a nested
  second `<main>` is invalid HTML. Same children, same structure otherwise.
- [2026-08-26] Task 6 LOCAL deviation — TopBar props: the plan's code block
  says `<TopBar title="Review QR" />`, but its own parenthetical says to
  check TopBar's actual props against the channels page and match them.
  Every sibling settings page passes `title` + `subtitle` +
  `rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}`, so
  Review QR does too (house shape wins over the minimal block).
- [2026-08-26] Task 6 note — sidebar `icon: 'location'` confirmed against
  the `IconName` union in `@/components/dashboard/shell/Icon` (it exists;
  also used by the Locations entry — icon reuse is the file's precedent,
  e.g. 'chart' and 'shield' each appear twice).

- [2026-08-26] AMENDMENT #4 (auto-approved category — 1 file inside the
  already-covered `.claude/reference/` tree) + gate-fix round 1: the first
  `--review` gate ran RED on exactly two rows. (a) `lint`: the plan's own
  print-page code block used a `../../PrintButton` parent-traversal import,
  which the repo's lint restricts → aliased to
  `@/app/(authenticated)/settings/review-qr/PrintButton`. (b)
  `merge-ledger`: every production PR must add its row to
  `.claude/reference/arch-review-log.md`, a structural requirement of the
  audit that no intake draft anticipated → file added to the surface, row
  added (counter increment deliberately left to step 8, per the audit's own
  text). Everything else was green on the first run — including
  `feature-surface` (now that the declared files exist), `promised-tests`
  (18/18) and `diff-coverage`.

## Step 6 read-back verdicts (orchestrator, 2026-08-26, pre-review)

- ACCEPT — Codex R3 record, AMENDMENTS #1/#2/#3, test retitle, edge-case
  correction, tests_to_add additions (5+3): all plan-time records, all
  owner-visible, decisions stand.
- ACCEPT — Task 1 optional-chaining (11 sites): typecheck-forced extension
  of the codex-R3 fix; assertion semantics unchanged.
- ACCEPT — Task 1 count note: prose off-by-one; 18/18 titles all land.
- ACCEPT — Task 1 integration seeding (helper + plain UPDATEs, suite-local
  SchemaRequirement): DML-only, the no-run-time-DDL convention holds; the
  assert-not-migrate posture is exactly the live-DB convention.
- ACCEPT — Task 4 ALLOWLIST_BASELINE 369→370: mechanically required by the
  file's own growth gate; one statement-granular entry sufficed.
- ACCEPT (superseded in part) — the Codex R1 REJECTIONS entry: M17–M19 and
  M20 were REVERSED in round 2 on real evidence (see AMENDMENT #3); the
  remaining rejections (HEAD test, feature-surface, harness skills) stand.
- ACCEPT — Task 6 `<section>` root (nested `<main>` is invalid HTML),
  TopBar house props (the plan's own parenthetical authorized it), icon
  confirmation.
- RE-PLAN — none. No entry invalidates a locked intake decision.
