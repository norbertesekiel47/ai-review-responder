# SMS channel "coming soon" — honest copy (Launch-ready P0 #12)

**Date:** 2026-05-29
**Source:** `docs/launch-ready-part2.md` — P0 #12 ("Fix SMS 'coming soon' hardcode to honor `CHANNELS_SMS_ENABLED`") and the detailed finding at line 88 ("SMS hardcoded 'coming soon' even when `CHANNELS_SMS_ENABLED=true` (`ChannelsClient.tsx:72-77`)").
**Scope chosen:** De-scope owner SMS to post-launch. Make the SMS channel row one honest, consistent "coming soon" and remove the dead flag→owner-UI plumbing. (Decided with the user; the alternatives — building an `OwnerSmsWidget` + owner SMS routes, or a flag-on "request" CTA — were rejected as out of scope / regulatory risk for a launch blocker.)

## Problem

The owner channels settings page (`settings/channels`) renders the SMS row as a
`ComingSoonChannelRow` **unconditionally** (`ChannelsClient.tsx:72-77`). The only thing the
`CHANNELS_SMS_ENABLED`-derived `initialAvailability.sms` flag does is swap the row's *reason*
sub-text:

```tsx
reason={initialAvailability.sms ? 'SMS owner widget ships in a follow-up phase' : 'Available once 10DLC verification clears'}
```

This is misleading on two counts:

1. **There is no owner self-service SMS path at all.** SMS enrollment exists only as admin
   tooling (`src/components/admin/SmsEnrollmentWidget.tsx` + `/api/admin/channels/sms/*`,
   Twilio Verify OTP + 10DLC). Telegram and WhatsApp have `Owner*Widget` components and
   owner routes under `/api/dashboard/channels/{telegram,whatsapp}/*`; SMS has neither. So
   when the flag is on, the owner still cannot use SMS — the row just says "ships in a
   follow-up phase," which leaks internal roadmap language to customers.
2. **The flag plumbing is dead.** `smsAvailable()` (`page.tsx:33-38`) is computed and threaded
   through `page.tsx → ChannelsTabClient → ChannelsClient` solely to toggle that reason
   string. Nothing else reads `initialAvailability.sms`. This is exactly the misleading,
   single-purpose flag wiring the audit flags — it implies the flag controls owner SMS
   availability when it does not.

`CHANNELS_SMS_ENABLED` keeps its real, separate jobs regardless of this change: gating
backend notification dispatch (`worker/jobs/notification/eligibility.ts:45`), admin
enrollment routes (`src/app/api/admin/channels/sms/_shared.ts`), the channel factory
(`src/lib/notifications/channels/index.ts:33`), and the worker boot assertion
(`worker/config/startup-assert.ts`). This change does **not** touch any of those.

## Goal

The SMS row shows a single, truthful "coming soon" message that does not vary with
`CHANNELS_SMS_ENABLED` and does not imply imminent owner availability. The now-dead owner-UI
flag plumbing (`smsAvailable()` + the `sms` field of `initialAvailability`) is removed, so the
flag has exactly one authoritative meaning per consumer and no fake one. The SMS row stays
visible (consistent with the Telegram/WhatsApp coming-soon rows), and is pinned by a test it
currently lacks.

## Non-goals

- **No `OwnerSmsWidget`, no owner SMS routes, no 10DLC/consent work.** Owner self-service SMS
  is explicitly post-launch (per the existing in-code note "ships in a follow-up phase" and
  `page.tsx:13` `VAL-SETTINGS-032`).
- **No change to `CHANNELS_SMS_ENABLED` semantics** for backend dispatch, admin enrollment,
  the channel factory, or worker boot. Those consumers are untouched.
- **No change to the per-location override panel** (`ChannelsTabClient`); it is a separate
  component and does not read `initialAvailability.sms`.
- **No change to the Telegram or WhatsApp rows.** Their `availability` branches stay as-is.
- **No change to `GET /api/dashboard/channels` (`route.ts`).** It owns a *separate, symmetric*
  availability status contract (`available: { telegram, sms, whatsapp }`) with its own independent
  `smsAvailable()`. That `available.sms` field is currently unconsumed by any client or test (verified:
  `useEnrollment` reads `enrollments`, not `available`; `status-get.test.ts` asserts neither), but it is
  left intact — it is **not** the visible "coming soon" hardcode the audit flagged (line 88 names
  `ChannelsClient.tsx:72-77`), and mutating a JSON response shape carries different (contract) risk than
  fixing display copy. Removing/realigning it is a reasonable follow-up cleanup, deliberately out of
  scope for this P0.

## Design

### 1. `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`

- **Prop type (line 20):** drop `sms` from `initialAvailability` →
  `initialAvailability: { telegram: boolean; whatsapp: boolean }`. Removing the field (rather
  than leaving it unused) makes the type tell the truth: nothing in this component reacts to
  SMS availability.
- **SMS row (lines 72-77):** replace the branching `reason` with a single constant. The
  right-side badge already reads "Coming soon" (from `ComingSoonChannelRow`), so the sub-line
  carries the specific, non-redundant message:

  ```tsx
  {/* SMS — owner self-service is post-launch; backend/admin SMS is gated separately by CHANNELS_SMS_ENABLED */}
  <ComingSoonChannelRow
    icon="📱"
    name="SMS"
    reason="SMS notifications are coming soon"
  />
  ```

  The comment records *why* the row is flag-independent (the one non-obvious fact a future
  reader needs), per the project comment rule.

### 2. `src/app/(authenticated)/settings/channels/page.tsx`

- **Remove `smsAvailable()`** (lines 33-38) — it has no remaining caller once the prop field
  is gone.
- **Remove `sms: smsAvailable()`** from the `initialAvailability` object literal passed to
  `ChannelsTabClient` (line ~184), leaving `{ telegram: telegramAvailable(), whatsapp: whatsappAvailable() }`.
- `telegramAvailable()` and `whatsappAvailable()` and all SMS-unrelated logic are untouched.

`ChannelsTabClient.tsx` needs no edit — it only spreads `{...props}` and `Props extends
ChannelsClientProps`, so the narrowed type flows through automatically.

### 3. Test — `src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx` (new)

The SMS row is currently untested. Add an RTL component test (repo-standard:
`@testing-library/react` + jsdom, matching the 35 existing `.test.tsx` render tests) that
pins the contract:

- **SMS row is an honest, flag-independent "coming soon":** renders with name "SMS", the exact
  reason "SMS notifications are coming soon", and the "Coming soon" status badge.
- **Regression guard — the misleading branch is gone:** the SMS reason text contains no
  roadmap/jargon language (assert it does **not** match `/follow-up phase|10DLC|owner widget/`).
  Because `sms` no longer exists on the prop, the row cannot react to flag state — the test
  documents that intent at the rendered-output level. (Telegram/WhatsApp availability is still
  passed in props and varied across renders to show the SMS row is unaffected.)
- **Sanity anchors:** Email row renders "Always on" given an email enrollment; the Telegram
  coming-soon branch still renders when `telegram: false`.

Example shape:

```tsx
const baseProps = {
  initialEnrollments: [{ channel: 'email', handle: 'owner@example.com', status: 'active', /* …nulls… */ }],
  initialAvailability: { telegram: false, whatsapp: false },
  ownerEmailFallback: 'owner@example.com',
};

it('renders SMS as a flag-independent "coming soon" row', () => {
  render(<ChannelsClient {...baseProps} />);
  const sms = screen.getByText('SMS').closest('.channel-row')!;
  expect(within(sms).getByText('SMS notifications are coming soon')).toBeInTheDocument();
  expect(within(sms).getByText('Coming soon')).toBeInTheDocument();
  expect(sms.textContent).not.toMatch(/follow-up phase|10DLC|owner widget/i);
});
```

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` (full suite) from the worktree. This work is in an
  **external** worktree (`../RepWorth-worktrees/fix-launch-p0-12-sms`), deliberately not nested
  under `.claude/worktrees/`, so local lint/test resolution is clean (CLAUDE.md nested-worktree
  caveat sidestepped). Authoritative check remains the 4 CI checks green on the PR.
- No DB / schema changes → `ci:tenant-scope` / `ci:rls-audit` not required.
- Grep guard after the change: `grep -rn "smsAvailable\|initialAvailability\.sms"` in the
  page/client layer returns no hits (confirms the owner-UI plumbing is fully removed, not just
  unused). The one remaining hit — `src/app/api/dashboard/channels/route.ts`'s own `smsAvailable()`
  — is expected and intentionally out of scope (see Non-goals).
- Visual: SMS row still appears under "Pick one extra channel" with the new sub-line and the
  "Coming soon" badge, in single-location, multi-location, and locations-enabled modes (all
  three render the same `ChannelsClient`).

## Files touched

| File | Change |
|---|---|
| `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` | Constant honest SMS `reason`; drop `sms` from `initialAvailability` prop type; explanatory comment |
| `src/app/(authenticated)/settings/channels/page.tsx` | Delete `smsAvailable()`; drop `sms` from the `initialAvailability` literal |
| `src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx` | New: pins the honest, flag-independent SMS row + regression guard against the old jargon |
