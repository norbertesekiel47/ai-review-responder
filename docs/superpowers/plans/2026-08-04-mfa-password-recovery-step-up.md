# MFA Step-Up in Password Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make self-service password recovery work for MFA-enrolled accounts by challenging the enrolled factor before the password write, instead of letting GoTrue refuse it with a masked error.

**Architecture:** The reset-password route gains an AAL2 gate that mirrors GoTrue's own `insufficient_aal` predicate, placed after the rate limit and before the body parse. The reset page collects a TOTP code inline via a new headless `useRecoveryStepUp` hook that challenges/verifies against the existing `/api/auth/mfa/challenge` route, so the session is already AAL2 by the time the password POST fires. Accounts with no factor take an unchanged path.

**Tech Stack:** Next.js 16 App Router, `@supabase/ssr` (server) + `@supabase/supabase-js` browser client, Vitest + Testing Library, Zod schemas.

**Spec:** `docs/superpowers/specs/2026-08-04-mfa-password-recovery-step-up-design.md`

**Branch:** `fix-mfa-recovery-step-up` (already created off `main`; the spec is already committed on it).

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/components/auth/useRecoveryStepUp.ts` | Headless state machine for the recovery step-up: probe session + verified factors, hold the code, challenge/verify against `/api/auth/mfa/challenge`. No rendering. |
| `src/components/auth/RecoveryStepUpField.tsx` | Presentational only: the factor picker (when >1) and the 6-digit input. Styling arrives via className props so each portal keeps its own design language. |
| `src/components/auth/__tests__/useRecoveryStepUp.test.tsx` | Hook unit tests, jsdom, no card rendering. |
| `docs/runbooks/mfa-factor-reset.md` | Operator break-glass procedure for a locked-out user who lost their authenticator. |
| `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md` | Staging proof that `mfa.verify` upgrades a recovery-minted session. |

**Modified:**

| File | Change |
|---|---|
| `src/lib/auth/mfa.ts` | Gains `ChallengeFactor` + `normalizeChallengeFactor(s)`, extracted from `MfaChallengeForm`. |
| `src/app/mfa/challenge/MfaChallengeForm.tsx:24-51` | Deletes its local normalizers, imports the shared ones. |
| `src/app/api/auth/reset-password/route.ts` | AAL gate (new step 6); error-status pass-through at the `updateError` branch. |
| `src/components/auth/ResetPasswordFormClient.tsx` | Both cards consume the hook; admin card gains the session probe; new error copy. |
| `src/app/api/auth/mfa/challenge/route.ts:215` | Comment names the runbook that now exists. |
| `src/app/api/auth/__tests__/reset-password.test.ts` | Mock gains `getAuthenticatorAssuranceLevel`; seven new cases. |
| `src/components/auth/__tests__/ResetPasswordFormClient.test.tsx` | Mock gains `auth.mfa.listFactors`. |
| `src/lib/auth/__tests__/mfa.test.ts` | New `describe` block for the normalizers. |
| `docs/directory.md:391` | New rows for the two new client modules. |

### ⚠ Landmine: there are two *different* factor normalizers, and they must stay different

`src/app/mfa/challenge/MfaChallengeForm.tsx` and `src/components/auth/useMfaEnrollment.ts` both define `normalizeFactor` / `normalizeFactors`. They look like duplicates. **They are not.**

- `MfaChallengeForm`'s projects to `{ id, label }` and **filters out anything whose `status !== 'verified'`** — a half-enrolled factor cannot satisfy a challenge.
- `useMfaEnrollment`'s projects to `{ id, friendlyName, factorType, status, createdAt }` and **deliberately keeps every status**, because the settings surfaces must render an unverified factor so the user can finish or abandon that enrollment.

This plan extracts **only** the challenge-shaped pair, and names the exports `normalizeChallengeFactor(s)` specifically so nobody later collapses them into `useMfaEnrollment`'s. Merging the two would silently hide in-progress enrollments from `/settings/security` and `/admin/security`. Do not touch `useMfaEnrollment.ts`.

---

## Task 1: Staging proof (gates every other task)

The whole design rests on one unproven claim: that `mfa.verify` upgrades a session minted by the recovery OTP (`login_method: otp`) to `aal2`. If it does not, tasks 2-9 are wasted work. Prove it before writing code.

**Files:**
- Create: `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md`

- [ ] **Step 1: Trigger recovery on staging**

Use the staging admin account `norbertesekiel@gmail.com` (auth id `728769a7-4c92-4413-9641-40361d1c38ca`). Go to the staging `/admin/forgot-password`, submit the email, open the recovery link from the inbox. You should land on `/admin/reset-password` with a session cookie.

- [ ] **Step 2: Confirm the session is AAL1 with a pending factor**

In the browser console on that page:

```js
const { data } = await window.__supabase?.auth?.mfa?.getAuthenticatorAssuranceLevel?.() ?? {};
console.log(data);
```

If `window.__supabase` is not exposed, read the same fact from the Supabase auth logs instead — the `/verify` entry with `login_method: otp` is sufficient evidence of an AAL1 recovery session.

Expected: `currentLevel: 'aal1'`, `nextLevel: 'aal2'`.

- [ ] **Step 3: Perform the step-up by hand against the existing route**

Still on `/admin/reset-password`, in the console:

```js
const factors = await (await fetch('/api/auth/mfa/challenge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'challenge', factorId: '<FACTOR_ID>' }),
})).json();
console.log(factors); // expect { challengeId: '...' }

const verified = await fetch('/api/auth/mfa/challenge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'verify',
    factorId: '<FACTOR_ID>',
    challengeId: factors.challengeId,
    code: '<6-DIGIT CODE FROM AUTHENTICATOR>',
  }),
});
console.log(verified.status); // expect 200
```

Get `<FACTOR_ID>` from the Supabase dashboard (Authentication → Users → the user → MFA factors), or from `await supabase.auth.mfa.listFactors()` if the client is reachable.

Expected: challenge 200, verify 200.

- [ ] **Step 4: Confirm the session is now AAL2 and the password write succeeds**

```js
const res = await fetch('/api/auth/reset-password', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: '<A NEW STRONG PASSWORD>' }),
});
console.log(res.status); // expect 200
```

Expected: **200**. This is the line that has never once succeeded.

- [ ] **Step 5: STOP CONDITION**

If step 4 returns 403 or 401 rather than 200, **do not proceed to Task 2.** The assumption is false and the design collapses. Report back: the fallback is break-glass-only (the reset page states up front that MFA-enrolled accounts recover through support, and Task 8's runbook becomes the entire fix). Tasks 2-7 would be dead code.

- [ ] **Step 6: Record the evidence**

Create `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md`:

```markdown
# Evidence — MFA step-up on a recovery session (staging)

**Date:** 2026-08-04
**Env:** staging
**Account:** norbertesekiel@gmail.com (728769a7-4c92-4413-9641-40361d1c38ca)
**Question:** Does `mfa.verify` upgrade a recovery-minted (`login_method: otp`)
session to `aal2`, allowing the password write that currently 401s?

## Result: PASS

| Time (UTC) | Event | Result |
|---|---|---|
| <FILL> | `POST /recover` | 200 — email sent |
| <FILL> | `POST /verify` | 200 — session created, `login_method: otp` |
| <FILL> | `POST /factors/{id}/challenge` | 200 |
| <FILL> | `POST /factors/{id}/verify` | 200 — aal2 |
| <FILL> | `PUT /user` | 200 |

Source: Supabase staging dashboard → Authentication → Logs, filtered to the
account above.

## Conclusion

The design in `docs/superpowers/specs/2026-08-04-mfa-password-recovery-step-up-design.md`
is viable. GoTrue does not inspect the originating `amr` when verifying a
factor, so an OTP-origin session upgrades to aal2 like any other.
```

Replace every `<FILL>` with the real timestamp from the staging auth log. Leaving a `<FILL>` in the committed file is a plan failure.

- [ ] **Step 7: Commit**

```bash
git add docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md
git commit -m "docs(evidence): MFA step-up succeeds on a recovery-minted session"
```

---

## Task 2: Extract the challenge-factor normalizers

**Files:**
- Modify: `src/lib/auth/mfa.ts` (append)
- Modify: `src/app/mfa/challenge/MfaChallengeForm.tsx:19-51` (delete locals, import shared)
- Test: `src/lib/auth/__tests__/mfa.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/auth/__tests__/mfa.test.ts` (the file already ends with `});` closing its last `describe` — add this *after* that line):

```ts
describe('normalizeChallengeFactors', () => {
  it('keeps verified factors and projects them to id + label', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Phone' }]);
  });

  it('drops unverified factors — a half-enrolled factor cannot satisfy a challenge', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'unverified' }],
      }),
    ).toEqual([]);
  });

  it('falls back to a generic label when the factor has no friendly name', () => {
    expect(
      normalizeChallengeFactors({ totp: [{ id: 'f1', status: 'verified' }] }),
    ).toEqual([{ id: 'f1', label: 'Authenticator app' }]);
  });

  it('accepts the camelCase spelling of friendlyName', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendlyName: 'Laptop', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Laptop' }]);
  });

  it('dedupes a factor appearing in both totp and all', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
        all: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Phone' }]);
  });

  it('returns an empty array for junk input rather than throwing', () => {
    expect(normalizeChallengeFactors(null)).toEqual([]);
    expect(normalizeChallengeFactors('nope')).toEqual([]);
    expect(normalizeChallengeFactors({})).toEqual([]);
  });

  it('skips entries with no string id', () => {
    expect(
      normalizeChallengeFactors({ totp: [{ friendly_name: 'X', status: 'verified' }] }),
    ).toEqual([]);
  });
});
```

Add `normalizeChallengeFactors` to the existing import statement at the top of that test file (it already imports from `@/lib/auth/mfa` or `../mfa` — extend whichever specifier is there rather than adding a second import line).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/auth/__tests__/mfa.test.ts`
Expected: FAIL — `normalizeChallengeFactors is not a function` (or a TS/import resolution error naming that symbol).

- [ ] **Step 3: Implement the normalizers**

Append to `src/lib/auth/mfa.ts`:

```ts
/**
 * A verified MFA factor reduced to what a challenge UI needs: an id to
 * challenge against and a label to show. Anything not `verified` is dropped —
 * a factor mid-enrollment cannot satisfy a challenge.
 *
 * NOTE: `src/components/auth/useMfaEnrollment.ts` has a similar-looking
 * normalizer that deliberately keeps EVERY factor with its full shape, because
 * the settings surfaces must render an unverified factor so the user can finish
 * or abandon that enrollment. The two are not duplicates. Do not merge them.
 */
export interface ChallengeFactor {
  id: string;
  label: string;
}

export function normalizeChallengeFactor(raw: unknown): ChallengeFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.status !== 'verified') return null;
  const label =
    typeof record.friendly_name === 'string'
      ? record.friendly_name
      : typeof record.friendlyName === 'string'
        ? record.friendlyName
        : 'Authenticator app';
  return { id: record.id, label };
}

export function normalizeChallengeFactors(data: unknown): ChallengeFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, ChallengeFactor>();
  for (const candidate of candidates) {
    const factor = normalizeChallengeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}
```

`src/lib/auth/mfa.ts` imports nothing and stays pure, so it is safe to import from both server routes (which already do) and client components (which now will). Do **not** add `'use client'` to it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/auth/__tests__/mfa.test.ts`
Expected: PASS, including the pre-existing cases in that file.

- [ ] **Step 5: Point MfaChallengeForm at the shared normalizers**

In `src/app/mfa/challenge/MfaChallengeForm.tsx`, delete lines 19-51 — the `ChallengeFactor` interface and both local `normalizeFactor` / `normalizeFactors` functions — and add to the imports:

```ts
import { normalizeChallengeFactors, type ChallengeFactor } from '@/lib/auth/mfa';
```

Then replace the single call site at line 206:

```ts
      const nextFactors = normalizeChallengeFactors(data);
```

`ChallengeFactor` is still referenced by the component's `MfaState`, which is why it is imported as a type rather than dropped.

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm vitest run src/app/mfa src/lib/auth && pnpm typecheck`
Expected: PASS on both.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/mfa.ts src/lib/auth/__tests__/mfa.test.ts src/app/mfa/challenge/MfaChallengeForm.tsx
git commit -m "refactor(auth): extract challenge-factor normalizers into lib/auth/mfa"
```

---

## Task 3: Server AAL gate in the reset-password route

**Files:**
- Modify: `src/app/api/auth/reset-password/route.ts`
- Test: `src/app/api/auth/__tests__/reset-password.test.ts`

- [ ] **Step 1: Teach the existing mock about `getAuthenticatorAssuranceLevel` (green → green)**

The route does not call it yet, so this changes no behavior — it just stops all 15 existing tests from throwing the moment step 3 lands.

In `src/app/api/auth/__tests__/reset-password.test.ts`, extend the hoisted block (lines 6-28) to:

```ts
const {
  mockCheckRateLimit,
  mockSql,
  mockGetUser,
  mockUpdateUser,
  mockSignOut,
  mockGetAal,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  const getUser = vi.fn();
  const updateUser = vi.fn();
  const signOut = vi.fn();
  const getAal = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockUpdateUser: updateUser,
    mockSignOut: signOut,
    mockGetAal: getAal,
    mockCreateServerClient: vi.fn(() => ({
      auth: {
        getUser,
        updateUser,
        signOut,
        mfa: { getAuthenticatorAssuranceLevel: getAal },
      },
    })),
  };
});
```

And extend `beforeEach` (after the `mockSignOut` block at lines 94-95) with the default no-factor session:

```ts
  mockGetAal.mockReset();
  // Default fixture: an account with NO enrolled factor. GoTrue reports
  // nextLevel 'aal1' for these, which is what makes every pre-existing test in
  // this file exercise the unchanged pass-through path.
  mockGetAal.mockResolvedValue({
    data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    error: null,
  });
```

And update the `mockCreateServerClient.mockImplementation` in `beforeEach` (lines 97-104) to match the factory shape:

```ts
  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: {
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
      signOut: mockSignOut,
      mfa: { getAuthenticatorAssuranceLevel: mockGetAal },
    },
  }));
```

- [ ] **Step 2: Run the suite to confirm it is still green**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: PASS, 15 tests. Nothing has changed behaviorally yet.

- [ ] **Step 3: Write the failing tests**

Add a new section to the same file, before the closing `});` of the outer `describe`:

```ts
  // ── MFA step-up gate ─────────────────────────────────────────────

  it('returns 403 mfa_required and NEVER calls updateUser when a factor is enrolled but unchallenged', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_required');
    // The ABSENCE of the write is the point of this test. A status-only
    // assertion would also pass against the shipped bug, where the route
    // reached GoTrue and merely relabelled the refusal.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('proceeds normally when the session is already AAL2', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: 'a-new-strong-password',
    });
  });

  it('fails CLOSED with 403 mfa_check_failed when the AAL probe errors', async () => {
    mockGetAal.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_check_failed');
    // An unreadable AAL is not permission to write a password.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('runs the rate limit BEFORE the AAL probe so a prober spends its own budget', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(429);
    expect(mockGetAal).not.toHaveBeenCalled();
  });

  it('refuses the step-up BEFORE parsing the body, so a refused request never reads the password', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    // A body that would fail schema validation with 400 if it were ever parsed.
    const res = await POST(mkReq({ password: 'short' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_required');
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: FAIL — the three step-up cases return 200/400 instead of 403, and the ordering case sees `mockGetAal` never called because no gate exists yet.

- [ ] **Step 5: Implement the gate**

In `src/app/api/auth/reset-password/route.ts`, add to the imports at the top:

```ts
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
```

Insert this block immediately after the rate-limit `try/catch` (which ends at line 135) and immediately *before* the `// 6. Parse + validate body.` comment:

```ts
  // 6. MFA step-up gate. The recovery OTP mints an AAL1 session; GoTrue refuses
  //    a password write on it whenever the account has a verified factor, and
  //    every RepWorth admin has one by construction (AAL2 is required to use
  //    the console at all). Mirror GoTrue's own predicate rather than
  //    re-deriving it, so the pre-check and the provider cannot disagree —
  //    accounts with no factor report nextLevel='aal1' and fall through
  //    untouched, with no branch to write.
  //
  //    Placed BEFORE the body parse so a refused request never destructures the
  //    plaintext password, and AFTER the rate limit so a scripted prober spends
  //    its own 5/hr budget. Fails CLOSED: an unreadable AAL is not permission to
  //    write a password. 403 (not 401) because the client reads 401 as "recovery
  //    session lapsed" and would bounce the user to /forgot-password for a fresh
  //    link that fails identically.
  const aal = await requireAal2FromSupabase(
    readOnlySupabase as unknown as SupabaseMfaAalClient,
  );
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403 });
  }
```

Then renumber the trailing comments in the file so they stay honest: `// 6. Parse + validate body.` → `// 7.`, `// 7. Build the success response` → `// 8.`, `// 8. Update password` → `// 9.`, `// 9. Explicitly end the recovery session` → `// 10.`

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: PASS, 20 tests (15 pre-existing + 5 new).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/auth/reset-password/route.ts src/app/api/auth/__tests__/reset-password.test.ts
git commit -m "fix(auth): gate password reset on AAL2 when a factor is enrolled"
```

---

## Task 4: Stop flattening provider errors to 400

**Files:**
- Modify: `src/app/api/auth/reset-password/route.ts` (the `updateError` branch)
- Test: `src/app/api/auth/__tests__/reset-password.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the same file, after the step-up section:

```ts
  // ── Provider error status pass-through ───────────────────────────

  it('maps an insufficient_aal write failure to 403 mfa_required, not 400', async () => {
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: null },
      error: {
        code: 'insufficient_aal',
        status: 401,
        message: 'AAL2 session is required to update email or password when MFA is enabled.',
      },
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_required');
  });

  it('passes a provider status through instead of flattening it to 400', async () => {
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 422, message: 'New password should be different from the old one.' },
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('New password should be different from the old one.');
    expect(mockSignOut).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: FAIL — both cases return 400.

- [ ] **Step 3: Implement the pass-through**

Replace the `if (updateError)` block (route.ts lines 186-188 pre-change):

```ts
  if (updateError) {
    // Backstop for the step-up gate above: if the pre-check ever drifts from
    // GoTrue's own rule, surface the refusal in the vocabulary the client
    // already handles rather than a masked 400.
    //
    // Every other provider error keeps its real status. Flattening them all to
    // 400 is precisely what made an `insufficient_aal` 401 read as a password
    // validation failure and hid this bug — and it also swallowed the genuine
    // 401 of a session that lapsed mid-request, which the client knows how to
    // turn into the expired-link state.
    //
    // Matched on `code` alone, not the message text: the message is provider
    // copy that can be reworded at any time, and a bare 401 here is more likely
    // a lapsed session than an AAL refusal now that the gate above exists.
    const { code, status, message } = updateError as {
      code?: string;
      status?: number;
      message: string;
    };
    if (code === 'insufficient_aal') {
      return NextResponse.json({ error: 'mfa_required' }, { status: 403 });
    }
    return NextResponse.json({ error: message }, { status: status ?? 400 });
  }
```

The pre-existing test at line 192 passes an error with no `status`, so `status ?? 400` keeps it at 400 and that test stays green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/reset-password/route.ts src/app/api/auth/__tests__/reset-password.test.ts
git commit -m "fix(auth): pass provider status through instead of flattening to 400"
```

---

## Task 5: The `useRecoveryStepUp` hook

**Files:**
- Create: `src/components/auth/useRecoveryStepUp.ts`
- Test: `src/components/auth/__tests__/useRecoveryStepUp.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/auth/__tests__/useRecoveryStepUp.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockGetUser, mockListFactors } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockListFactors: vi.fn(),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getUser: mockGetUser,
      mfa: { listFactors: mockListFactors },
    },
  }),
}));

import { useRecoveryStepUp } from '@/components/auth/useRecoveryStepUp';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VERIFIED_FACTOR = {
  id: 'factor-1',
  friendly_name: 'Authenticator',
  status: 'verified',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } } });
  mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
});

describe('useRecoveryStepUp — probe', () => {
  it('reports no-session when there is no recovery session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('no-session'));
    // No point listing factors for a session that does not exist.
    expect(mockListFactors).not.toHaveBeenCalled();
  });

  it('reports no-factor when the account has no verified factor', async () => {
    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('no-factor'));
  });

  it('reports code-required when a verified factor exists', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('code-required'));
    expect(result.current.factors).toEqual([
      { id: 'factor-1', label: 'Authenticator' },
    ]);
    expect(result.current.selectedFactorId).toBe('factor-1');
  });

  it('treats an unverified-only account as no-factor', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ ...VERIFIED_FACTOR, status: 'unverified' }] },
      error: null,
    });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('no-factor'));
  });

  it('fails toward code-required when listFactors errors', async () => {
    mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { result } = renderHook(() => useRecoveryStepUp());

    // Guessing no-factor would walk the user into a submit the server refuses
    // anyway; asking for a possibly-unneeded code is the cheaper wrong answer.
    await waitFor(() => expect(result.current.status).toBe('code-required'));
  });
});

describe('useRecoveryStepUp — verify', () => {
  async function mountWithFactor() {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('code-required'));
    return result;
  }

  it('challenges then verifies, and reports verified on success', async () => {
    const result = await mountWithFactor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    act(() => result.current.setCode('123456'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(result.current.status).toBe('verified');

    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0]!;
    expect(challengeUrl).toBe('/api/auth/mfa/challenge');
    expect(JSON.parse(challengeInit.body)).toEqual({
      action: 'challenge',
      factorId: 'factor-1',
    });

    const [, verifyInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(verifyInit.body)).toEqual({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'chal-1',
      code: '123456',
    });
  });

  it('reports a rejected code without advancing to verified', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'verify_failed' }, 400)),
    );

    act(() => result.current.setCode('000000'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(result.current.status).toBe('code-required');
    expect(result.current.error).toBe('The verification code was not accepted.');
  });

  it('surfaces the rate-limit copy on 429', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe(
      'Too many MFA attempts. Try again in a few minutes.',
    );
  });

  it('survives a network failure without wedging', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    act(() => result.current.setCode('123456'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(result.current.status).toBe('code-required');
    expect(result.current.error).toContain('connection');
  });

  it('stays verified across a later failed password write — no second code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });
    expect(result.current.status).toBe('verified');

    // The card retries the password write; verify() must be a no-op that
    // reports success rather than demanding a fresh code. This is the client
    // half of the route's deliberate choice not to signOut on updateError.
    const secondFetch = vi.fn();
    vi.stubGlobal('fetch', secondFetch);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('is a no-op returning true when the account has no factor', async () => {
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('no-factor'));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/auth/__tests__/useRecoveryStepUp.test.tsx`
Expected: FAIL — cannot resolve `@/components/auth/useRecoveryStepUp`.

- [ ] **Step 3: Implement the hook**

Create `src/components/auth/useRecoveryStepUp.ts`:

```ts
'use client';

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { normalizeChallengeFactors, type ChallengeFactor } from '@/lib/auth/mfa';

/**
 * Headless owner of the MFA step-up inside the password-recovery flow.
 *
 * The recovery OTP mints an AAL1 session, and GoTrue refuses a password write
 * on one whenever the account has a verified factor. This hook probes for that
 * situation at mount and, when it applies, challenges + verifies the factor
 * through `/api/auth/mfa/challenge` (which owns rate-limiting and audit) so the
 * session is already AAL2 by the time the card POSTs the new password.
 *
 * Both reset cards consume it, so the flow has one authoritative implementation
 * and each surface owns only its presentation.
 */
export type RecoveryStepUpStatus =
  | 'probing'
  | 'no-session'
  | 'no-factor'
  | 'code-required'
  | 'verified';

const RATE_LIMITED_COPY = 'Too many MFA attempts. Try again in a few minutes.';
const REJECTED_COPY = 'The verification code was not accepted.';
const CHALLENGE_FAILED_COPY = 'Could not start MFA verification.';
const NETWORK_COPY =
  'Could not reach the server. Check your connection and try again.';

interface State {
  status: RecoveryStepUpStatus;
  factors: ChallengeFactor[];
  selectedFactorId: string;
  code: string;
  error: string | null;
}

const initialState: State = {
  status: 'probing',
  factors: [],
  selectedFactorId: '',
  code: '',
  error: null,
};

type Action =
  | { type: 'noSession' }
  | { type: 'probed'; factors: ChallengeFactor[] }
  | { type: 'probeFailed' }
  | { type: 'selectFactor'; factorId: string }
  | { type: 'setCode'; code: string }
  | { type: 'verifyStart' }
  | { type: 'verifyFailed'; error: string }
  | { type: 'verified' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'noSession':
      return { ...state, status: 'no-session' };
    case 'probed':
      return {
        ...state,
        status: action.factors.length > 0 ? 'code-required' : 'no-factor',
        factors: action.factors,
        selectedFactorId: action.factors[0]?.id ?? '',
      };
    case 'probeFailed':
      // Fail TOWARD asking for a code, but with no factor id — `verify` turns
      // that into an honest "reload and try again" rather than posting a blank
      // factorId the challenge route would reject as a malformed body.
      return { ...state, status: 'code-required', factors: [], selectedFactorId: '' };
    case 'selectFactor':
      return { ...state, selectedFactorId: action.factorId };
    case 'setCode':
      return { ...state, code: action.code };
    case 'verifyStart':
      return { ...state, error: null };
    case 'verifyFailed':
      return { ...state, error: action.error };
    case 'verified':
      return { ...state, error: null, status: 'verified' };
    default:
      return state;
  }
}

export interface UseRecoveryStepUp {
  status: RecoveryStepUpStatus;
  factors: ChallengeFactor[];
  selectedFactorId: string;
  selectFactor: (factorId: string) => void;
  code: string;
  setCode: (code: string) => void;
  error: string | null;
  /** Resolves true when the session is (or already was) cleared to write a password. */
  verify: () => Promise<boolean>;
}

export function useRecoveryStepUp(): UseRecoveryStepUp {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!user) {
          dispatch({ type: 'noSession' });
          return;
        }
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (cancelled) return;
        if (error) {
          // Fail TOWARD asking for a code. Guessing no-factor would walk the
          // user into a submit the server refuses anyway; a possibly-unneeded
          // code prompt is the cheaper wrong answer, and the server stays
          // authoritative either way.
          dispatch({ type: 'probeFailed' });
          return;
        }
        dispatch({ type: 'probed', factors: normalizeChallengeFactors(data) });
      } catch {
        if (!cancelled) dispatch({ type: 'noSession' });
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const verify = useCallback(async (): Promise<boolean> => {
    // Already cleared, or never needed clearing. Idempotent by design: the
    // route does not signOut on a failed password write, so a retry must not
    // demand a second code.
    if (state.status === 'verified' || state.status === 'no-factor') return true;
    if (state.status !== 'code-required') return false;
    if (!state.selectedFactorId) {
      // Only reachable via `probeFailed` — we know a code is probably needed but
      // never learned which factor to challenge.
      dispatch({
        type: 'verifyFailed',
        error: 'Could not load your security settings. Reload the page and try again.',
      });
      return false;
    }

    dispatch({ type: 'verifyStart' });
    try {
      // A fresh challenge per attempt. The verify budget (8/hr) is tighter than
      // the challenge budget (15/hr), so reusing a challenge id saves nothing
      // and only adds a stale-challenge failure mode.
      const challengeRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'challenge',
          factorId: state.selectedFactorId,
        }),
      });
      if (challengeRes.status === 429) {
        dispatch({ type: 'verifyFailed', error: RATE_LIMITED_COPY });
        return false;
      }
      const challenge = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok || typeof challenge.challengeId !== 'string') {
        dispatch({ type: 'verifyFailed', error: CHALLENGE_FAILED_COPY });
        return false;
      }

      const verifyRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          factorId: state.selectedFactorId,
          challengeId: challenge.challengeId,
          code: state.code,
        }),
      });
      if (verifyRes.status === 429) {
        dispatch({ type: 'verifyFailed', error: RATE_LIMITED_COPY });
        return false;
      }
      if (!verifyRes.ok) {
        dispatch({ type: 'verifyFailed', error: REJECTED_COPY });
        return false;
      }

      dispatch({ type: 'verified' });
      return true;
    } catch {
      dispatch({ type: 'verifyFailed', error: NETWORK_COPY });
      return false;
    }
  }, [state.status, state.selectedFactorId, state.code]);

  return {
    status: state.status,
    factors: state.factors,
    selectedFactorId: state.selectedFactorId,
    selectFactor: (factorId: string) =>
      dispatch({ type: 'selectFactor', factorId }),
    code: state.code,
    setCode: (code: string) => dispatch({ type: 'setCode', code }),
    error: state.error,
    verify,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/auth/__tests__/useRecoveryStepUp.test.tsx`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/useRecoveryStepUp.ts src/components/auth/__tests__/useRecoveryStepUp.test.tsx
git commit -m "feat(auth): add useRecoveryStepUp hook for MFA step-up during recovery"
```

---

## Task 6: The `RecoveryStepUpField` component

**Files:**
- Create: `src/components/auth/RecoveryStepUpField.tsx`

No dedicated test file — it has no logic beyond conditional rendering, and Task 7's card tests exercise it through both portals. Adding a separate suite here would test React, not us.

- [ ] **Step 1: Implement the component**

Create `src/components/auth/RecoveryStepUpField.tsx`:

```tsx
'use client';

import type { ChallengeFactor } from '@/lib/auth/mfa';

const SUPPORT_EMAIL = 'support@repworth.net';

export interface RecoveryStepUpFieldProps {
  factors: ChallengeFactor[];
  selectedFactorId: string;
  onSelectFactor: (factorId: string) => void;
  code: string;
  onCodeChange: (code: string) => void;
  /** Portal-owned styling — the two reset cards use different design languages. */
  labelClassName: string;
  inputClassName: string;
  supportLinkClassName: string;
}

/**
 * The TOTP code field shown inline on the reset-password cards when the account
 * has a verified factor. Presentational only: all state lives in
 * `useRecoveryStepUp`, and all styling arrives via props so neither portal's
 * look has to migrate into a shared component.
 */
export function RecoveryStepUpField({
  factors,
  selectedFactorId,
  onSelectFactor,
  code,
  onCodeChange,
  labelClassName,
  inputClassName,
  supportLinkClassName,
}: RecoveryStepUpFieldProps) {
  return (
    <div>
      {factors.length > 1 ? (
        <div className="mb-3">
          <label className={labelClassName} htmlFor="recovery-mfa-factor">
            Authenticator
          </label>
          <select
            id="recovery-mfa-factor"
            className={inputClassName}
            value={selectedFactorId}
            onChange={(event) => onSelectFactor(event.target.value)}
          >
            {factors.map((factor) => (
              <option key={factor.id} value={factor.id}>
                {factor.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <label className={labelClassName} htmlFor="recovery-mfa-code">
        Authenticator code
      </label>
      <input
        id="recovery-mfa-code"
        className={inputClassName}
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        required
      />
      {/* No self-service factor removal: `unenroll` requires a currently
          stepped-up AAL2 session by design, which an AAL1 recovery session
          structurally cannot reach. Support is the correct answer here. */}
      <a className={supportLinkClassName} href={`mailto:${SUPPORT_EMAIL}`}>
        Lost your authenticator? Contact support
      </a>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/RecoveryStepUpField.tsx
git commit -m "feat(auth): add RecoveryStepUpField presentational component"
```

---

## Task 7: Wire both reset cards

**Files:**
- Modify: `src/components/auth/ResetPasswordFormClient.tsx`
- Test: `src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`

- [ ] **Step 1: Teach the existing card mock about `mfa.listFactors` (green → green)**

The hook is not wired in yet, so this changes nothing — it just stops the existing 5 tests from throwing once step 3 lands.

In `src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`, extend the hoisted block and the `@/lib/db/browser` mock:

```ts
const { routerPush, mockGetUser, mockListFactors } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  // Default: a recovery session is present so the owner form renders. Tests
  // that need the expired state override the resolved value per-call. Typed as
  // `user: { id } | null` so both the present and absent shapes are assignable.
  mockGetUser: vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    async () => ({ data: { user: { id: 'auth-1' } } }),
  ),
  // Default: no enrolled factor, so every pre-existing test keeps exercising
  // the unchanged no-step-up path.
  mockListFactors: vi.fn(async () => ({ data: { totp: [] }, error: null })),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getUser: mockGetUser,
      mfa: { listFactors: mockListFactors },
    },
  }),
}));
```

And add to the existing `afterEach`:

```ts
  mockListFactors.mockReset();
  mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
```

- [ ] **Step 2: Run the suite to confirm it is still green**

Run: `pnpm vitest run src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 3: Write the failing tests**

Add to the same file, inside the existing outer `describe`:

```tsx
  it('shows no code field when the account has no enrolled factor', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/new password/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull();
  });

  it('reveals the code field when a verified factor exists', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });
  });

  it('verifies the code BEFORE posting the password', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ redirectTo: '/dashboard' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/mfa/challenge');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/mfa/challenge');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/auth/reset-password');
  });

  it('never reaches the reset route when the code is rejected', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'verify_failed' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: 'a-new-strong-password' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-new-strong-password' },
    });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: '000000' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => {
      expect(screen.getByText(/verification code was not accepted/i)).toBeTruthy();
    });
    // A mistyped code must never spend one of the reset route's 5/hr.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('admin portal also reveals the code field', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
      error: null,
    });

    render(<ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy();
    });
  });

  it('admin portal dead-ends on an expired recovery link', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    render(<ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />);

    await waitFor(() => {
      expect(screen.getByText(/reset link expired/i)).toBeTruthy();
    });
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`
Expected: FAIL — no `authenticator code` label exists, and the admin card renders the form rather than the expired state.

- [ ] **Step 5: Rewire the card**

In `src/components/auth/ResetPasswordFormClient.tsx`:

**5a.** Replace the imports of `useEffect`/`useMemo`/`useState` usage for the probe. Change the import block at lines 3-16 to:

```tsx
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { fetchWithTimeout } from '@/components/auth/shared/fetchWithTimeout';
import { MIN_PASSWORD_LENGTH } from '@/lib/shared/schemas';
import {
  useRecoveryStepUp,
  type UseRecoveryStepUp,
} from '@/components/auth/useRecoveryStepUp';
import { RecoveryStepUpField } from '@/components/auth/RecoveryStepUpField';
```

`createBrowserSupabaseClient` is no longer imported here — the hook owns the client now.

**5b.** Add the two new error codes to `RESET_PASSWORD_ERROR_COPY` (after the `account_incomplete` entry):

```ts
  mfa_required:
    'Enter the current code from your authenticator app to continue.',
  mfa_check_failed:
    'We could not verify your security settings. Please try again in a moment.',
```

**5c.** Extend `AdminResetPasswordProps` and the `AdminResetPassword` component so the admin card can render the field and the dead-end. Replace the interface with:

```tsx
interface AdminResetPasswordProps {
  brandName: string;
  password: string;
  setPassword: (v: string) => void;
  confirmPw: string;
  setConfirmPw: (v: string) => void;
  error: string;
  loading: boolean;
  handleSubmit: (e: React.FormEvent) => Promise<void>;
  stepUp: UseRecoveryStepUp;
}
```

Inside `AdminResetPassword`, add `stepUp` to the destructured props, and insert this block immediately after the confirm-password `<div>` and before the `{error && ...}` line:

```tsx
          {stepUp.status === 'code-required' ? (
            <RecoveryStepUpField
              factors={stepUp.factors}
              selectedFactorId={stepUp.selectedFactorId}
              onSelectFactor={stepUp.selectFactor}
              code={stepUp.code}
              onCodeChange={stepUp.setCode}
              labelClassName="block text-sm font-medium text-gray-700 mb-1"
              inputClassName="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              supportLinkClassName="mt-2 block text-sm text-blue-600 hover:underline"
            />
          ) : null}
          {stepUp.error && <p className="text-sm text-red-600">{stepUp.error}</p>}
```

**5d.** Replace the body of `ResetPasswordFormClient` down to `handleSubmit`. Delete the `supabase` memo, the `sessionReady` state, and the whole probe `useEffect` (lines 147-181), replacing them with:

```tsx
export function ResetPasswordFormClient({ portal, brandName }: ResetPasswordFormProps) {
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  // Owns the recovery-session probe AND the MFA step-up for BOTH portals. The
  // callback handler exchanges the recovery code into a session cookie before
  // this page renders; if the link was already used or has expired there is no
  // session, so we show the expired-link state up front instead of letting the
  // user type a password the server will reject.
  const stepUp = useRecoveryStepUp();
  const sessionExpired = stepUp.status === 'no-session';
```

**5e.** Rewrite `handleSubmit` so the step-up runs first:

```tsx
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setLoading(true);
    try {
      // Step up FIRST. A mistyped code stops here and never reaches the reset
      // route, which is what keeps a bad code off the reset route's 5/hr budget
      // — it spends the challenge route's 8/hr verify budget instead.
      // No-ops and reports success when the account has no factor, or when a
      // previous submit already cleared the session to AAL2.
      const cleared = await stepUp.verify();
      if (!cleared) return;

      const res = await fetchWithTimeout('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json()) as {
        error?: string;
        redirectTo?: string;
      };
      if (!res.ok) {
        // A 401 here means the recovery session lapsed between mount and
        // submit — flip to the expired-link state rather than a transient error.
        if (res.status === 401) {
          setSessionExpiredFallback(true);
          return;
        }
        setError(mapResetPasswordError(body));
        return;
      }
      router.push(body.redirectTo ?? '/login');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }
```

Because the hook owns the probe, the mid-flight 401 needs its own local flag. Add it alongside the other `useState` calls in 5d:

```tsx
  const [sessionExpiredFallback, setSessionExpiredFallback] = useState(false);
```

and widen the derived value in 5d to:

```tsx
  const sessionExpired = stepUp.status === 'no-session' || sessionExpiredFallback;
```

**5f.** Move the expired-link dead-end **above** the portal fork so both cards get it, and pass `stepUp` into the admin card. Replace the `if (portal === 'admin')` block and the `if (sessionReady === false)` block with:

```tsx
  // Expired / missing recovery session: dead-end both portals with a clear path
  // to request a fresh link. Previously owner-only — the admin card had no
  // probe at all and let the user type a password into a dead session.
  if (sessionExpired) {
    const href = portal === 'admin' ? '/admin/forgot-password' : '/forgot-password';
    if (portal === 'admin') {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
              {brandName}
            </h1>
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
              <h2 className="text-base font-medium text-gray-900">
                Reset link expired
              </h2>
              <p className="text-sm text-gray-600">{SESSION_EXPIRED_COPY}</p>
              <Link href={href} className="text-sm font-medium text-blue-600 hover:underline">
                Request a new reset link
              </Link>
            </div>
          </div>
        </div>
      );
    }
    return (
      <AuthCardShell width="sm">
        <LiveRegion level="assertive" message={SESSION_EXPIRED_COPY} />
        <h1 className="text-2xl font-semibold text-rw-ink">Reset link expired</h1>
        <p className="mt-2 text-rw-ink-soft">{SESSION_EXPIRED_COPY}</p>
        <Link
          href={href}
          className="mt-6 inline-block text-sm font-medium text-rw-teal-strong hover:underline"
        >
          Request a new reset link
        </Link>
      </AuthCardShell>
    );
  }

  if (portal === 'admin') {
    return (
      <AdminResetPassword
        brandName={brandName}
        password={password}
        setPassword={setPassword}
        confirmPw={confirmPw}
        setConfirmPw={setConfirmPw}
        error={error}
        loading={loading}
        handleSubmit={handleSubmit}
        stepUp={stepUp}
      />
    );
  }
```

**5g.** Add the field to the owner card. In the owner `<form>`, insert immediately after the confirm-password `<div>` (the one ending with the `confirm-password-feedback` paragraph) and before `{error && ...}`:

```tsx
        {stepUp.status === 'code-required' ? (
          <RecoveryStepUpField
            factors={stepUp.factors}
            selectedFactorId={stepUp.selectedFactorId}
            onSelectFactor={stepUp.selectFactor}
            code={stepUp.code}
            onCodeChange={stepUp.setCode}
            labelClassName={authLabelClass}
            inputClassName={authFieldClass}
            supportLinkClassName="mt-2 block text-sm font-medium text-rw-teal-strong hover:underline"
          />
        ) : null}
        {stepUp.error && (
          <p className="text-sm text-rw-error" aria-hidden="true">{stepUp.error}</p>
        )}
```

And widen the owner card's `LiveRegion` so step-up errors are announced too:

```tsx
      <LiveRegion level="assertive" message={error || stepUp.error || ''} />
```

**Important:** the card must keep rendering the form while `stepUp.status === 'probing'` — only `'no-session'` dead-ends. This preserves the existing synchronous admin assertion in the test file (`admin portal keeps gray/blue exactly`, which renders without `await`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
git add src/components/auth/ResetPasswordFormClient.tsx src/components/auth/__tests__/ResetPasswordFormClient.test.tsx
git commit -m "feat(auth): collect the TOTP code inline on both reset-password cards"
```

---

## Task 8: Runbook and documentation

**Files:**
- Create: `docs/runbooks/mfa-factor-reset.md`
- Modify: `src/app/api/auth/mfa/challenge/route.ts:213-215`
- Modify: `docs/directory.md:391`

- [ ] **Step 1: Confirm the operator-side removal mechanism**

Before writing the runbook, verify how an operator actually removes a factor on this project — the spec deliberately does not assert this. Check the Supabase dashboard under Authentication → Users → (a user) → for a factor-removal control, and check whether `supabase.auth.admin.mfa.deleteFactor` is available in the installed `@supabase/supabase-js` version:

```bash
rg -n "deleteFactor" node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.d.ts
```

Write down whichever path actually exists. Do not document a mechanism you have not seen.

- [ ] **Step 2: Write the runbook**

Create `docs/runbooks/mfa-factor-reset.md`:

```markdown
# Runbook — MFA factor reset (break-glass)

**When to use:** A user can receive email at their registered address but has
lost the authenticator device holding their TOTP factor. They cannot sign in and
cannot complete password recovery, because the recovery flow requires a code
from that device.

**When NOT to use:** The user still has their authenticator and merely forgot
their password. That is self-service — send them to `/forgot-password` (owners)
or `/admin/forgot-password` (admins); the recovery flow will ask for their code
inline and complete normally.

## Why there is no self-service path

Removing a factor requires a currently stepped-up AAL2 session
(`src/app/api/auth/mfa/challenge/route.ts`, the `unenroll` branch). A user who
has lost the factor cannot reach AAL2, so they cannot remove it. That is
deliberate: a self-service AAL1 removal would make the factor worthless as a
second factor, since anyone holding the password alone could strip it.

## Identity verification — complete BEFORE touching anything

Removing someone's second factor is an account-takeover-shaped action. Do not
start until all of these hold:

- [ ] The request arrived from the address already registered on the account —
      not a forwarded message, not a new address.
- [ ] The requester can state the account's business name and at least one
      connected location.
- [ ] For an admin account: a second RepWorth admin has confirmed the request
      out of band (not by replying to the same email thread).
- [ ] No account-status change (offboarding, cancellation, ownership transfer)
      is in flight for this account.

If any box is unchecked, stop and escalate. A delayed reset is recoverable; a
reset granted to an attacker is not.

## Procedure

1. Record the account id, auth user id, and the requester's evidence in the
   support ticket before making any change.
2. Remove the factor via <THE MECHANISM CONFIRMED IN STEP 1 — dashboard path or
   admin API call, written out concretely>.
3. Confirm the removal: the user's next sign-in should complete at AAL1 without
   a code prompt.
4. Tell the user to sign in and **immediately re-enroll** at `/settings/security`
   (owners) or `/admin/security` (admins). An admin cannot use the console at
   all until they re-enroll, because AAL2 gates every admin surface
   (`src/proxy.ts`).
5. Append the outcome to the support ticket: who authorized it, on what
   evidence, and when the user re-enrolled.

## Audit

The `unenroll` route writes an `mfa_factor_unenrolled` audit event when a user
removes their own factor. An operator-side removal performed outside the app
does NOT produce that event — which is exactly why step 5 is mandatory. The
support ticket is the only record.
```

Replace `<THE MECHANISM CONFIRMED IN STEP 1 …>` with the concrete steps you verified. Leaving the placeholder in the committed file is a plan failure.

- [ ] **Step 3: Point the dangling comment at the runbook**

In `src/app/api/auth/mfa/challenge/route.ts`, replace the comment at lines 213-215:

```ts
    // Removing a factor is account-takeover-sensitive: require a currently
    // stepped-up (AAL2) session, not merely an enrolled factor. A lost factor
    // is handled by the break-glass procedure in
    // `docs/runbooks/mfa-factor-reset.md`, not an AAL1 self-serve removal.
```

- [ ] **Step 4: Update the code map**

In `docs/directory.md`, add two rows immediately after line 391 (`auth/ResetPasswordFormClient.tsx`), matching the surrounding table format:

```markdown
| `auth/useRecoveryStepUp.ts` | Headless MFA step-up for password recovery: probes the recovery session + verified factors, then challenges/verifies via `/api/auth/mfa/challenge` so the session is AAL2 before the password write. Consumed by both reset cards. |
| `auth/RecoveryStepUpField.tsx` | Presentational TOTP code field (plus factor picker when >1) shown inline on the reset cards. Styling arrives via className props. |
```

Also add the runbook to the `docs/runbooks/` description near line 1192, following whatever list format is already there.

- [ ] **Step 5: Verify the cross-references resolve**

Run: `rg -n "mfa-factor-reset" src docs`
Expected: at least three hits — the runbook itself, the route comment, and `docs/directory.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/mfa-factor-reset.md docs/directory.md src/app/api/auth/mfa/challenge/route.ts
git commit -m "docs(auth): add the MFA factor-reset break-glass runbook"
```

---

## Task 9: Full gate and PR

**Files:** none — verification only.

- [ ] **Step 1: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all three PASS. No schema changed, so `ci:tenant-scope` and `ci:rls-audit` have nothing new to inspect, but they run inside `lint` regardless.

If `pnpm test` surfaces failures in files this plan did not touch, check whether a live DB is awake — `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` isolates that. Do not "fix" unrelated integration suites inside this branch.

- [ ] **Step 2: Manual smoke on staging — the MFA path**

Push the branch, let the Vercel preview build, then run the full recovery loop against the preview URL with the MFA-enrolled staging admin:

1. `/admin/forgot-password` → submit → open the emailed link.
2. The reset card should render **with** the authenticator code field.
3. Enter a wrong code → expect "The verification code was not accepted." and confirm in the network tab that `/api/auth/reset-password` was **never** called.
4. Enter the correct code plus a new password → expect a redirect to `/admin/login`.
5. Sign in with the new password → expect the normal `/mfa/challenge` step, then the console.

- [ ] **Step 3: Manual smoke — the no-factor path is unchanged**

Repeat with an owner account that has no enrolled factor. The reset card must show **no** code field and complete in a single submit, exactly as before.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin fix-mfa-recovery-step-up
gh pr create --base main --title "fix(auth): MFA step-up in password recovery" --body "$(cat <<'EOF'
## Problem

Password reset was permanently impossible for any account with MFA enrolled.
`/api/auth/reset-password` called `updateUser` on the AAL1 recovery session, so
GoTrue returned `401 insufficient_aal` on every attempt, and the route's flat
`status: 400` mapping disguised it as a validation error. Every RepWorth admin
was affected — AAL2 is required to use the console at all, so every admin has an
enrolled factor by construction.

## Fix

- Gate the route on `requireAal2FromSupabase`, placed after the rate limit and
  before the body parse. Mirrors GoTrue's own predicate, so the pre-check and the
  provider cannot disagree; no-factor accounts fall through untouched.
- Collect the TOTP code inline on both reset cards via a new headless
  `useRecoveryStepUp` hook, which challenges/verifies through the existing
  `/api/auth/mfa/challenge`. A mistyped code never reaches the reset route.
- Pass provider statuses through instead of flattening to 400 — which also
  un-masks the genuine 401 of a session that lapses mid-request.
- Admin card gains the recovery-session probe the owner card already had.
- Ships the break-glass runbook that `mfa/challenge/route.ts` already claimed
  existed.

## Verification

- Staging proof that `mfa.verify` upgrades a recovery-minted session:
  `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md`
- New route test asserts `updateUser` is **not called** when a factor is enrolled
  but unchallenged — the case whose absence let this ship.
- `pnpm lint && pnpm typecheck && pnpm test` green.

Spec: `docs/superpowers/specs/2026-08-04-mfa-password-recovery-step-up-design.md`
Plan: `docs/superpowers/plans/2026-08-04-mfa-password-recovery-step-up.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DN2QcHgMCGcHXrKU66gxK3
EOF
)"
```

- [ ] **Step 5: Confirm CI is green before requesting review**

Run: `gh pr checks --watch`
Expected: `lint`, `typecheck`, `test`, `build` all pass. `llm-eval` is path-filtered and should skip — this branch touches no LLM surface.
