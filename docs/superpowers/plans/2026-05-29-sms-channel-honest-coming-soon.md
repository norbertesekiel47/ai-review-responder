# SMS channel "coming soon" honest copy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SMS channel row on `settings/channels` show one honest, flag-independent "coming soon" message and delete the dead `CHANNELS_SMS_ENABLED`→owner-UI plumbing (P0 #12).

**Architecture:** `ChannelsClient` renders an Email row plus a "pick one extra channel" group (Telegram/WhatsApp interactive when available, else a `ComingSoonChannelRow`; SMS always a `ComingSoonChannelRow`). Today the SMS row's `reason` text branches on `initialAvailability.sms`, which the server computes via `smsAvailable()` and threads through purely to swap that string. We replace the branch with a constant, drop the `sms` field from the prop (server + type), and pin the behavior with a new RTL test. `CHANNELS_SMS_ENABLED`'s real consumers (worker dispatch, admin enrollment, channel factory, boot assertion) are untouched.

**Tech Stack:** Next.js 16 (App Router, React Server + Client Components), TypeScript (strict), Vitest 4 + `@testing-library/react` + jsdom, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-29-sms-channel-honest-coming-soon-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` | Owner channel-row UI (org-level defaults) | Constant SMS `reason`; drop `sms` from `initialAvailability` prop type; add a "why flag-independent" comment |
| `src/app/(authenticated)/settings/channels/page.tsx` | Server component: auth/sub guard, enrollment fetch, availability computation | Delete `smsAvailable()`; drop `sms` from the `initialAvailability` literal |
| `src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx` | **New** — pins the honest, flag-independent SMS row | Create |

`ChannelsTabClient.tsx` is intentionally **not** modified: it spreads `{...props}` and its `Props extends ChannelsClientProps`, so the narrowed prop type propagates automatically. No worker, admin-route, factory, or flag changes.

---

## Task 1: Honest, flag-independent SMS row (TDD)

**Files:**
- Create: `src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx`
- Modify: `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` (prop type line ~20; SMS row lines ~72-77)
- Modify: `src/app/(authenticated)/settings/channels/page.tsx` (`smsAvailable()` lines ~33-38; `initialAvailability` literal line ~182-186)

> Note on TDD ordering: Vitest transpiles without type-checking, so the new test (which passes `initialAvailability` **without** `sms`) compiles and runs against the *current* component — it renders the old reason text and fails the assertions (red). `pnpm typecheck` validates the type narrowing separately in Step 6.

- [ ] **Step 1: Write the failing test**

Create `src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChannelsClient, type InitialEnrollment } from '../ChannelsClient';

// The owner Telegram/WhatsApp widgets fetch status on mount. Stub them so we
// can freely flip telegram/whatsapp availability and prove the SMS row never
// reacts to any flag state. (Same vi.mock-with-JSX pattern as SettingsClient.test.tsx.)
vi.mock('@/components/dashboard/OwnerTelegramWidget', () => ({
  OwnerTelegramWidget: () => <div data-testid="telegram-widget" />,
}));
vi.mock('@/components/dashboard/OwnerWhatsAppWidget', () => ({
  OwnerWhatsAppWidget: () => <div data-testid="whatsapp-widget" />,
}));

function emailEnrollment(): InitialEnrollment {
  return {
    channel: 'email',
    handle: 'owner@example.com',
    status: 'active',
    verified_at: null,
    disabled_at: null,
    unsubscribed_at: null,
    unsubscribed_reason: null,
    expires_at: null,
  };
}

const baseProps = {
  initialEnrollments: [emailEnrollment()],
  ownerEmailFallback: 'owner@example.com',
};

function smsRow(): HTMLElement {
  return screen.getByText('SMS').closest('.channel-row') as HTMLElement;
}

describe('ChannelsClient — SMS row', () => {
  it('renders SMS as an honest "coming soon" row', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);

    const sms = smsRow();
    expect(within(sms).getByText('SMS notifications are coming soon')).toBeInTheDocument();
    expect(within(sms).getByText('Coming soon')).toBeInTheDocument();
    // Regression guard: the old flag-dependent roadmap jargon must be gone.
    expect(sms.textContent).not.toMatch(/follow-up phase|10DLC|owner widget/i);
  });

  it('keeps the SMS row identical when other channels become available', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: true, whatsapp: true }} />);

    // Other channels mount their interactive widgets…
    expect(screen.getByTestId('telegram-widget')).toBeInTheDocument();
    expect(screen.getByTestId('whatsapp-widget')).toBeInTheDocument();
    // …SMS is unchanged.
    const sms = smsRow();
    expect(within(sms).getByText('SMS notifications are coming soon')).toBeInTheDocument();
    expect(sms.textContent).not.toMatch(/follow-up phase|10DLC|owner widget/i);
  });

  it('shows the email row as Always on', () => {
    render(<ChannelsClient {...baseProps} initialAvailability={{ telegram: false, whatsapp: false }} />);

    const email = screen.getByText('Email').closest('.channel-row') as HTMLElement;
    expect(within(email).getByText('Always on')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run "src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx"`
Expected: FAIL. The first two tests fail because the current component (with `sms` undefined) renders the falsy branch `"Available once 10DLC verification clears"` — `getByText('SMS notifications are coming soon')` throws "Unable to find an element", and the `not.toMatch(/…10DLC…/i)` guard fails. (The "Always on" email test should already pass.)

- [ ] **Step 3: Edit `ChannelsClient.tsx` — constant reason + narrowed prop type**

In `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`:

Change the prop type (line ~20) from:

```tsx
  initialAvailability: { telegram: boolean; sms: boolean; whatsapp: boolean };
```

to:

```tsx
  initialAvailability: { telegram: boolean; whatsapp: boolean };
```

Replace the SMS row (lines ~72-77) from:

```tsx
        {/* SMS — always coming-soon in Phase 4 */}
        <ComingSoonChannelRow
          icon="📱"
          name="SMS"
          reason={initialAvailability.sms ? 'SMS owner widget ships in a follow-up phase' : 'Available once 10DLC verification clears'}
        />
```

to:

```tsx
        {/* SMS — owner self-service is post-launch. The CHANNELS_SMS_ENABLED flag
            gates backend dispatch + admin enrollment, NOT this owner row, so the
            row is intentionally flag-independent. */}
        <ComingSoonChannelRow
          icon="📱"
          name="SMS"
          reason="SMS notifications are coming soon"
        />
```

- [ ] **Step 4: Edit `page.tsx` — remove the dead `smsAvailable()` plumbing**

In `src/app/(authenticated)/settings/channels/page.tsx`:

Delete the `smsAvailable()` function (lines ~33-38):

```tsx
function smsAvailable(): boolean {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_VERIFY_SERVICE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}
```

In the `initialAvailability` literal (lines ~182-186), drop the `sms` line. Change from:

```tsx
        initialAvailability={{
          telegram: telegramAvailable(),
          sms: smsAvailable(),
          whatsapp: whatsappAvailable(),
        }}
```

to:

```tsx
        initialAvailability={{
          telegram: telegramAvailable(),
          whatsapp: whatsappAvailable(),
        }}
```

Leave `telegramAvailable()`, `whatsappAvailable()`, and everything else unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run "src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx"`
Expected: PASS — 3 passed.

- [ ] **Step 6: Typecheck (proves the prop narrowing is consistent end-to-end)**

Run: `pnpm typecheck`
Expected: clean exit, no errors. (If `page.tsx` still passed `sms`, TS would flag an excess property here — confirms the dead plumbing is gone from both ends.)

- [ ] **Step 7: Grep guard — no dead references remain in the page/client layer**

Run: `grep -rn "smsAvailable\|initialAvailability\.sms" "src/app/(authenticated)/settings/channels/"`
Expected: no output (zero matches) — confirms the owner-UI plumbing is fully removed, not merely unused.

A repo-wide `grep -rn "smsAvailable" src/` will still show **one** hit:
`src/app/api/dashboard/channels/route.ts`. That is a *separate*, intentionally out-of-scope
availability status contract (its `available.sms` is unconsumed by any client/test) — leave it untouched.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(authenticated)/settings/channels/ChannelsClient.tsx" \
        "src/app/(authenticated)/settings/channels/page.tsx" \
        "src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx"
git commit -m "$(cat <<'EOF'
fix(channels): honest SMS "coming soon" row; drop dead flag plumbing (P0 #12)

The SMS channel row rendered "ships in a follow-up phase" when
CHANNELS_SMS_ENABLED was on and "Available once 10DLC verification clears"
when off — but there is no owner self-service SMS path either way (SMS
enrollment is admin-only). The flag's only effect on this row was that
misleading text swap.

Replace it with one honest, flag-independent reason and remove the now-dead
owner-UI plumbing (smsAvailable() + the sms field of initialAvailability).
CHANNELS_SMS_ENABLED's real jobs — worker dispatch, admin enrollment, channel
factory, boot assertion — are untouched. Adds the first test for the SMS row,
including a regression guard against the old jargon.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Full local verification gate

No code changes — run the project gate before declaring done. (This work is in an external worktree, so local lint/test resolution is clean; CI on the PR remains the authoritative check.)

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all suites pass (≈4450+ tests), including the new `ChannelsClient.test.tsx`.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: build succeeds (the `channels` route compiles with the narrowed prop type).

No DB/schema changes → `pnpm ci:tenant-scope` / `pnpm ci:rls-audit` are not required.

---

## Done criteria

- New `ChannelsClient.test.tsx` passes; the SMS row shows "SMS notifications are coming soon" with a "Coming soon" badge and no flag-dependent jargon.
- `grep -rn "smsAvailable\|initialAvailability\.sms" "src/app/(authenticated)/settings/channels/"` is empty (the unrelated `route.ts` `smsAvailable()` is intentionally retained — out of scope).
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green locally.
- Ready for PR (handled separately via `superpowers:finishing-a-development-branch`); the launch-audit doc tick for P0 #12 is updated as part of that step.
