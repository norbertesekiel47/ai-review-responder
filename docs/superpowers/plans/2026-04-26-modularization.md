# Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose 11 oversized source files into focused, single-purpose modules without changing observable behavior; deduplicate `parseArray`.

**Architecture:** Pure mechanical extraction with safe cleanups. Each big-file split keeps the original path as a barrel re-export so call sites compile unchanged in the same commit. Wave-ordered (shared utilities → leaf UI → service-layer → high-risk worker/ingress) so blast radius grows monotonically.

**Tech Stack:** TypeScript 5 strict, Next.js 14 App Router, Postgres.js + Supabase, BullMQ, Vitest, Resend, Twilio, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-04-26-modularization-design.md` (local-only).

**Branch:** `refactor/modularization` (already created).

---

## Architecture invariants — DO NOT violate

These are reproduced from `.claude/CLAUDE.md` because this refactor must not subtly weaken any of them:

1. **Vercel UI only.** No LLM calls / external API calls / long-running ops in Next.js routes.
2. **Transactional outbox.** Every state change + follow-up enqueue in the same `sql.begin(...)` block.
3. **Third-party ingress on Railway.** Webhook handlers stay in `worker/ingress/*`.
4. **No auto-posting.** Approval is non-bypassable.
5. **Approval tokens hashed only.** Raw tokens never persisted.
6. **ReviewSource contract.** No source-specific fields leak into prompt builder.
7. **Auth scope is app-enforced.** `users.auth_id` mapping; `business_id` checked by handler; service key never reaches browser.
8. **Native crypto.** `import { createHash, randomUUID } from 'node:crypto'`.

If any task in this plan looks like it would weaken one of these, STOP and ask. Behavior preservation is non-negotiable.

---

## Per-commit gate

Run, in order, before every commit. If any step fails, fix the underlying cause and create a NEW commit (do not `--amend`).

```bash
pnpm lint
pnpm tsc --noEmit
pnpm test
pnpm build
```

After each commit:

```bash
SHA=$(git rev-parse --short HEAD)
SUBJECT=$(git log -1 --format=%s)
wsl bash -c "bash ~/dev/codex-bridge/nudge 'review commit $SHA: $SUBJECT'"
```

Skip the nudge if `CODEX_BRIDGE_DISABLED=1` or WSL2 is unreachable. Do not block on codex output — it is async.

---

## Wave 0: Preflight

### Task 0.1: Verify environment and baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch + worktree state**

```bash
git branch --show-current   # expect: refactor/modularization
git status --short           # expect: only ` M .claude/CLAUDE.md` (the doc-sync from main); no other dirty files
```

If anything else is dirty, stash it before starting. Do NOT include unrelated changes in modularization commits.

- [ ] **Step 2: Capture baseline test/build state**

```bash
pnpm install        # ensure lockfile match
pnpm lint           # baseline must be green
pnpm tsc --noEmit   # baseline must be green
pnpm test           # record pass/fail/skip counts
pnpm build          # baseline must be green
```

If any are red on the unmodified branch, halt and surface — refactor cannot proceed on a broken baseline.

- [ ] **Step 3: Start codex bridge**

```bash
wsl bash -c 'bash ~/dev/codex-bridge/start'   # idempotent
```

Expected: `Started session 'cdx'` or `Session 'cdx' already running`.

- [ ] **Step 4: Verify NotificationWorker has test coverage (Wave 4.3 prerequisite)**

```bash
ls worker/__tests__/NotificationWorker*.test.ts
```

Expected: at least `NotificationWorker.test.ts`. The repo also has `-sms` and `-telegram` variants, which is good.

If the main file is missing, halt before Wave 4.3 starts and add coverage first. Other waves may proceed.

- [ ] **Step 5: No commit for Task 0.1.** Pure verification.

---

## Wave 1: Shared utilities

Lowest blast radius. Wave 1 establishes the small modules that later waves depend on.

### Task 1.1: Extract `parseDbArray` to a shared module

**Files:**
- Create: `src/lib/shared/db-array.ts`
- Create: `src/lib/shared/__tests__/db-array.test.ts`
- Modify: `src/app/api/dashboard/route.ts` (remove local `parseArray`, import shared)
- Modify: `src/app/api/admin/businesses/[id]/route.ts` (same)
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (same)

**Why:** `parseArray` is duplicated verbatim 3 times. The lab note dated 2026-04-09 documents the JSONB-from-PgBouncer-as-string trap that all three implementations work around. One canonical implementation reduces the chance of one drifting.

- [ ] **Step 1: Read all three current implementations**

```bash
# Compare to confirm they are functionally identical:
sed -n '80,86p' src/app/api/dashboard/route.ts
sed -n '11,17p' src/app/api/admin/businesses/\[id\]/route.ts
sed -n '100,107p' worker/jobs/ResponseGeneratorWorker.ts
```

If they diverge, the extraction must preserve the most-correct version. Expected: all three are equivalent — `Array.isArray(val) ? val : typeof val === 'string' ? JSON.parse(val) catch [] : []`.

- [ ] **Step 2: Create the shared module**

```ts
// src/lib/shared/db-array.ts

/**
 * Parse a TEXT[] column that PgBouncer may return as a JSON-encoded string.
 *
 * Postgres.js + PgBouncer (transaction pooling mode) sometimes serializes
 * arrays as JSON strings instead of native arrays. See lab note 2026-04-09.
 * Returns `[]` on any parse failure or unexpected shape.
 */
export function parseDbArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
```

- [ ] **Step 3: Write a unit test for the new module**

```ts
// src/lib/shared/__tests__/db-array.test.ts
import { describe, it, expect } from 'vitest';
import { parseDbArray } from '../db-array';

describe('parseDbArray', () => {
  it('returns arrays unchanged', () => {
    expect(parseDbArray(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('parses JSON-encoded array strings (PgBouncer path)', () => {
    expect(parseDbArray('["x","y"]')).toEqual(['x', 'y']);
  });
  it('returns empty array for null', () => {
    expect(parseDbArray(null)).toEqual([]);
  });
  it('returns empty array for undefined', () => {
    expect(parseDbArray(undefined)).toEqual([]);
  });
  it('returns empty array for invalid JSON string', () => {
    expect(parseDbArray('not-json')).toEqual([]);
  });
  it('returns empty array for JSON that decodes to non-array', () => {
    expect(parseDbArray('{"x":1}')).toEqual([]);
  });
  it('returns empty array for unexpected types', () => {
    expect(parseDbArray(42)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test alone**

```bash
pnpm test src/lib/shared/__tests__/db-array.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Replace the three call sites**

In `src/app/api/dashboard/route.ts`:
- Delete the local `parseArray` (lines 79-86) including its JSDoc.
- Add `import { parseDbArray } from '@/lib/shared/db-array';` next to the other `@/lib/...` imports.
- Replace every occurrence of `parseArray(` with `parseDbArray(` in this file (use Find & Replace; verify count == 2 in this file based on current grep results).

In `src/app/api/admin/businesses/[id]/route.ts`:
- Delete the local `parseArray` (lines 11-17).
- Add the same import.
- Replace `parseArray(` → `parseDbArray(` (5 occurrences).

In `worker/jobs/ResponseGeneratorWorker.ts`:
- Delete the local `parseArray` (lines 100-107).
- Add `import { parseDbArray } from '../../src/lib/shared/db-array';` (worker uses relative paths; mirror existing imports in the file).
- Replace `parseArray(` → `parseDbArray(` (4 occurrences).

- [ ] **Step 6: Verify no `parseArray` left**

```bash
# Grep should return zero hits in these three files (the new util is named parseDbArray):
grep -rn "function parseArray" src/ worker/
grep -n "parseArray(" src/app/api/dashboard/route.ts src/app/api/admin/businesses/\[id\]/route.ts worker/jobs/ResponseGeneratorWorker.ts
```

Expected: no `function parseArray` definitions remain. No unqualified `parseArray(` calls remain.

- [ ] **Step 7: Run the full per-commit gate**

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

Expected: all green. Existing tests that exercise the modified routes/workers must still pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/shared/db-array.ts src/lib/shared/__tests__/db-array.test.ts \
        src/app/api/dashboard/route.ts \
        "src/app/api/admin/businesses/[id]/route.ts" \
        worker/jobs/ResponseGeneratorWorker.ts
git commit -m "$(cat <<'EOF'
refactor(shared): extract parseArray → parseDbArray (3 call sites)

Removes 3 verbatim copies. New module documents the PgBouncer-as-string
trap from lab note 2026-04-09 in one place. Behavior identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Codex nudge**

```bash
SHA=$(git rev-parse --short HEAD)
wsl bash -c "bash ~/dev/codex-bridge/nudge 'review commit $SHA: extract parseDbArray to shared module'"
```

---

### Task 1.2: Extract shared inbound-event helpers in `worker/ingress/shared.ts`

**Files:**
- Modify: `worker/ingress/shared.ts` (add `markInboundEventProcessed`, `markInboundEventFailed`)
- Modify: `worker/ingress/telegram.ts` (delete local `markProcessed`/`markFailed`; import shared; rename call sites)
- Modify: `worker/ingress/twilio-whatsapp.ts` (same)

**Why:** Both ingress files have private `markProcessed(dedupKey)` and `markFailed(dedupKey, reason)` helpers that wrap identical UPDATE statements against `inbound_events`. Promoting them removes the duplication without touching ingress logic.

- [ ] **Step 1: Read the existing helpers in both files to confirm equivalence**

```bash
sed -n '106,120p' worker/ingress/telegram.ts
sed -n '168,180p' worker/ingress/twilio-whatsapp.ts
```

Confirm both helpers issue the same UPDATE shape (`SET status='processed'` / `SET status='failed', error_reason=$2`). If they diverge, extraction must preserve both shapes via separate parameters — surface to the user before continuing.

- [ ] **Step 2: Append the shared helpers to `worker/ingress/shared.ts`**

```ts
// at the end of worker/ingress/shared.ts

import { sql } from '../../src/lib/db/server';

/**
 * Mark an inbound webhook event as successfully processed.
 * Idempotent — if the dedup key has no row, the UPDATE is a no-op.
 */
export async function markInboundEventProcessed(dedupKey: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'processed', processed_at = NOW()
    WHERE dedup_key = ${dedupKey}
  `;
}

/**
 * Mark an inbound webhook event as failed with a reason.
 * Used when validation/dispatch fails after the event has been claimed.
 */
export async function markInboundEventFailed(dedupKey: string, reason: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'failed', error_reason = ${reason}, processed_at = NOW()
    WHERE dedup_key = ${dedupKey}
  `;
}
```

(If `shared.ts` already imports `sql` for `claimInboundEvent`, do not duplicate the import.)

- [ ] **Step 3: Update `worker/ingress/telegram.ts`**

- Delete the local `markProcessed` (line 106) and `markFailed` (line 114) functions.
- Add to the existing import block: `import { markInboundEventProcessed, markInboundEventFailed } from './shared';` (or extend the existing `./shared` import).
- Replace every internal call: `markProcessed(` → `markInboundEventProcessed(`, `markFailed(` → `markInboundEventFailed(`.

- [ ] **Step 4: Update `worker/ingress/twilio-whatsapp.ts`** with the same three changes (the local helpers are at line 168 / 175 in this file).

- [ ] **Step 5: Verify no orphan helpers**

```bash
grep -n "function markProcessed\|function markFailed" worker/ingress/
```

Expected: no matches.

- [ ] **Step 6: Run the per-commit gate**

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

Tests of interest: `worker/ingress/__tests__/telegram*.test.ts`, `worker/ingress/__tests__/twilio-whatsapp*.test.ts` if present. They must still pass.

- [ ] **Step 7: Commit**

```bash
git add worker/ingress/shared.ts worker/ingress/telegram.ts worker/ingress/twilio-whatsapp.ts
git commit -m "$(cat <<'EOF'
refactor(ingress): promote markProcessed/markFailed to shared module

Telegram + WhatsApp ingress both had identical private helpers for
inbound_events status transitions. Now in worker/ingress/shared.ts as
markInboundEventProcessed / markInboundEventFailed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Codex nudge** (same pattern as Task 1.1 Step 9)

---

### Task 1.3: Create `src/lib/approval/audit.ts` (extract audit log helpers)

**Files:**
- Create: `src/lib/approval/audit.ts`
- Modify: `src/lib/approval/service.ts` (delete the three functions; import from new module; keep all call sites)

**Why:** Three audit helpers (`insertAuditLog`, `insertAuditLogSession`, `buildCallbackAudit`) are isolated and stable. Extracting them into their own module is a low-risk preparation for the larger Wave 4.2 split.

- [ ] **Step 1: Read the existing functions to copy them verbatim**

Functions and types to move (from `src/lib/approval/service.ts`):
- Lines 39-43: `interface AuditContext`
- Lines 45-47: `function hashToken` (KEEP this in service.ts because lockValidLink uses it)
- Lines 49-70: `async function insertAuditLog`
- Lines 308-311: `interface SessionAuditContext`
- Lines 313-333: `async function insertAuditLogSession`
- Lines 443-447: `interface CallbackAuditContextBase`
- Lines 449-459: `type CallbackAuditContext` (export)
- Lines 461-466: `interface CallbackApprovalInput` — KEEP in service.ts because adapters consume it (we'll move it in Wave 4.2)
- Lines 488-520: `function buildCallbackAudit`

**Strategy for this task:** Move only what's purely audit-related. `CallbackApprovalInput` is touched by adapters too, so leave it for now. `hashToken` is used by `lockValidLink` so leave it.

- [ ] **Step 2: Create `src/lib/approval/audit.ts`**

```ts
// src/lib/approval/audit.ts
//
// Audit log writers for approval transitions. Three modes share the
// approval_audit_log table but differ in context shape:
//   - token mode    → AuditContext (token hash + device cookie + IP)
//   - session mode  → SessionAuditContext (session-bound, no token hash)
//   - callback mode → AuditContext (token hash from link) + provider metadata
//
// See approval/service.ts for callers.

import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';
import type { ApprovalLink } from './service';

type TxClient = postgres.TransactionSql;

// ── Audit context shapes ──────────────────────────────────────────────────

export interface AuditContext {
  tokenHash: string;
  deviceCookieHash: string | null;
  ipAddress: string | null;
}

export interface SessionAuditContext {
  /* COPY VERBATIM from service.ts:308-311 */
}

interface CallbackAuditContextBase {
  /** Stable provider event identifier — Telegram update_id as string, Twilio MessageSid. */
  providerEventId: string;
  ipAddress: string | null;
}

/** Existing public input union — DO NOT rename. */
export type CallbackAuditContext =
  | (CallbackAuditContextBase & {
      telegramUpdateId: number;
      twilioMessageSid?: never;
    })
  | (CallbackAuditContextBase & {
      twilioMessageSid: string;
      telegramUpdateId?: never;
    });

/** Return shape of buildCallbackAudit — distinct from the input union above. */
export interface CallbackAuditArtifacts {
  audit: AuditContext;
  metadata: Record<string, unknown>;
}

// ── Insert helpers ────────────────────────────────────────────────────────

export async function insertAuditLog(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: AuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata)
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${audit.tokenHash},
      ${audit.deviceCookieHash},
      ${action},
      ${audit.ipAddress},
      ${jsonb(metadata ?? {})}
    )
  `;
}

export async function insertAuditLogSession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: SessionAuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  /* COPY VERBATIM the body from service.ts:313-333 */
}

// ── Callback audit builder ────────────────────────────────────────────────

// CallbackApprovalInput is still defined in service.ts for now; this builder
// imports it. After Wave 4.2 it moves to callback-mode.ts and this file
// imports from there. Until then, keep the import path stable.
import type { CallbackApprovalInput } from './service';

export function buildCallbackAudit(
  link: ApprovalLink,
  input: CallbackApprovalInput,
  correlationId: string,
): CallbackAuditArtifacts {
  const chatHandleHash = createHash('sha256').update(input.chatHandle).digest('hex');
  const metadata: Record<string, unknown> = {
    via_channel: input.viaChannel,
    chat_handle_hash: chatHandleHash,
    correlation_id: correlationId,
    provider_event_id: input.audit.providerEventId,
  };
  if (input.audit.telegramUpdateId !== undefined) {
    metadata.update_id = input.audit.telegramUpdateId;
  }
  if (input.audit.twilioMessageSid !== undefined) {
    metadata.message_sid = input.audit.twilioMessageSid;
  }
  return {
    audit: {
      tokenHash: link.token_hash,
      deviceCookieHash: null,
      ipAddress: input.audit.ipAddress,
    },
    metadata,
  };
}
```

The two `/* COPY VERBATIM */` markers must be filled with the actual current contents of `service.ts:308-311` and `service.ts:313-333`. Do not paraphrase.

- [ ] **Step 3: Resolve the circular import**

`audit.ts` imports `ApprovalLink` and `CallbackApprovalInput` from `service.ts`, and `service.ts` will (after this task) import the audit functions from `audit.ts`. TypeScript handles this cleanly because the imports are type-only on the audit side (`import type { ApprovalLink } ...`).

If at compile time you see a "circular reference" warning, switch the `audit.ts` import line to:

```ts
import type { ApprovalLink, CallbackApprovalInput } from './service';
```

(Both are type-only.)

- [ ] **Step 4: Update `src/lib/approval/service.ts`**

- Delete: lines 39-43 (`AuditContext`), 49-70 (`insertAuditLog`), 308-311 (`SessionAuditContext`), 313-333 (`insertAuditLogSession`), 443-447 (`CallbackAuditContextBase`), 449-459 (`CallbackAuditContext`), 488-520 (`buildCallbackAudit`).
- Keep: `hashToken` (lines 45-47), `interface ApprovalLink` (26-37), all approve/edit/regenerate functions, locking helpers, `CallbackApprovalInput` (461-466).
- Add at the top of the imports section:

```ts
import {
  AuditContext,
  SessionAuditContext,
  CallbackAuditContext,
  CallbackAuditArtifacts,
  insertAuditLog,
  insertAuditLogSession,
  buildCallbackAudit,
} from './audit';
```

- Re-export the audit module's public API to preserve external imports:

```ts
// at the bottom of service.ts, near other re-exports if any
export type { AuditContext, SessionAuditContext, CallbackAuditContext, CallbackAuditArtifacts } from './audit';
export { insertAuditLog, insertAuditLogSession, buildCallbackAudit } from './audit';
```

- [ ] **Step 5: Run the per-commit gate**

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

The approval test suite (`src/lib/approval/__tests__/*.test.ts` if present, plus the route-level integration tests in `src/app/api/approve/**` and `src/app/api/dashboard/reviews/**`) must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/approval/audit.ts src/lib/approval/service.ts
git commit -m "$(cat <<'EOF'
refactor(approval): extract audit helpers into approval/audit.ts

Pulls insertAuditLog, insertAuditLogSession, buildCallbackAudit, and
their context types out of service.ts. service.ts re-exports them so
external imports are unchanged.

Adds CallbackAuditArtifacts as the explicit return type of
buildCallbackAudit so it doesn't collide with the existing
CallbackAuditContext input union.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Codex nudge.**

---

## Wave 2: Leaf UI extractions

Pure React/UI. No worker risk.

### Task 2.1: Decompose `src/app/admin/businesses/[id]/page.tsx`

**Files:**
- Read first: `src/app/admin/businesses/[id]/page.tsx` (entire file, ~990 lines)
- Create: `src/app/admin/businesses/[id]/components/ProfileEditor.tsx`
- Create: `src/app/admin/businesses/[id]/components/TrackedKeywordsSection.tsx`
- Create: `src/app/admin/businesses/[id]/components/ManualRankingSection.tsx`
- Create: `src/app/admin/businesses/[id]/components/ChannelsPanel.tsx`
- Create: `src/app/admin/businesses/[id]/components/ReviewsList.tsx`
- Create: `src/app/admin/businesses/[id]/components/ManualPostFlow.tsx`
- Create: `src/app/admin/businesses/[id]/hooks/useBusinessDetail.ts`
- Modify: `src/app/admin/businesses/[id]/page.tsx` (becomes thin orchestrator, ~150 lines)

**Why:** The page mixes data loading, mutations, profile editing, keyword tracking, ranking, channels, bounce clearing, review rendering, and manual-post flow.

This task is decomposed into 7 sub-commits — one per extraction. Each sub-commit lifts ONE section into its own component, updates the page to consume it, and runs the gate. This keeps every commit small and codex-reviewable.

- [ ] **Step 1: Read the page top-to-bottom and write down the section list**

```bash
wc -l src/app/admin/businesses/\[id\]/page.tsx
```

Open the file and identify the JSX sections by their visual headings or comment markers. Map each to a planned component. If a planned component has fewer than ~30 lines of UI, leave it inlined — extraction adds import noise without value.

The 6 components above are best-guesses from the spec. Confirm against the actual render tree before extracting.

- [ ] **Step 2-7 (one per component, repeat the pattern):**

For each target component:

  - [ ] **a. Read the source range** for that section in the page (note the line span).
  - [ ] **b. Identify the props the section needs** by inspecting its references to outer-scope state (loaded business, mutation handlers, etc.).
  - [ ] **c. Create the component file** with:

```tsx
// src/app/admin/businesses/[id]/components/<Name>.tsx
'use client';

import type { /* prop types */ } from '../types';   // or inline if small

interface <Name>Props {
  /* derive from c. above */
}

export function <Name>(props: <Name>Props) {
  /* JSX moved verbatim from the source range */
  /* event handlers stay as props — no inline mutation logic */
}
```

  - [ ] **d. Replace the source range in `page.tsx`** with `<Name prop1={...} prop2={...} />`.
  - [ ] **e. If shared types are needed**, extract to `src/app/admin/businesses/[id]/types.ts` and import from both.
  - [ ] **f. Run gate:** `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build`.
  - [ ] **g. Commit** with message `refactor(admin business detail): extract <Name>`.
  - [ ] **h. Codex nudge.**

- [ ] **Step 8: Extract `useBusinessDetail` hook**

After all section components are extracted, lift the data-loading and mutation logic into a colocated hook:

```tsx
// src/app/admin/businesses/[id]/hooks/useBusinessDetail.ts
'use client';

import { useState, useEffect, useCallback } from 'react';
import type { BusinessDetail } from '../types';

export function useBusinessDetail(businessId: string) {
  /* moves the existing useState + fetch logic from page.tsx verbatim */
  /* exposes: data, loading, error, refresh, mutate functions */
  return { data, loading, error, refresh, /* mutators */ };
}
```

The exact function signature is determined by what `page.tsx` currently does — copy verbatim.

  - Run the gate, commit `refactor(admin business detail): extract useBusinessDetail hook`, codex nudge.

- [ ] **Step 9: Final review of `page.tsx`**

It should now be ~150 lines. Verify by reading top-to-bottom:

```bash
wc -l src/app/admin/businesses/\[id\]/page.tsx
```

If it's still over 250 lines, identify the remaining oversized chunk and extract it. Otherwise the task is complete.

---

### Task 2.2: Decompose `src/app/admin/businesses/new/page.tsx`

**Files:**
- Read first: `src/app/admin/businesses/new/page.tsx` (entire file, ~549 lines)
- Create (component files, names finalized after reading): `src/app/admin/businesses/new/components/<SectionName>.tsx` for each fieldset
- Create: `src/app/admin/businesses/new/hooks/useBusinessPrefill.ts`
- Create: `src/app/admin/businesses/new/schema.ts`
- Modify: `src/app/admin/businesses/new/page.tsx`

**Why:** Form + Zod schema + prefill race + payload shaping + presentation are all tangled.

**Strategy:** Same per-section commit pattern as Task 2.1.

- [ ] **Step 1: Read the page and identify field groups**

Identify form sections by their fieldset / heading boundaries. Common candidates: identity (name, place ID, address), brand voice (tone, sample responses, products/services), onboarding meta (admin handoff fields, pricing tier).

- [ ] **Step 2: Extract the schema first**

The schema is currently inline. Move it (verbatim, including any refinements) to `src/app/admin/businesses/new/schema.ts`:

```ts
// src/app/admin/businesses/new/schema.ts
import { z } from 'zod';

export const newBusinessSchema = z.object({
  /* COPY VERBATIM from the inline z.object in page.tsx */
});

export type NewBusinessForm = z.infer<typeof newBusinessSchema>;
```

Update `page.tsx` to import from the new module.

Run gate. Commit `refactor(admin new business): colocate schema in schema.ts`. Codex nudge.

- [ ] **Step 3: Extract the prefill hook**

```ts
// src/app/admin/businesses/new/hooks/useBusinessPrefill.ts
'use client';

export function useBusinessPrefill(/* args mirroring current usage */) {
  /* moves the SerpAPI prefill race-condition handling from page.tsx verbatim */
  return { prefillData, prefillLoading, prefillError };
}
```

Run gate. Commit. Codex nudge.

- [ ] **Step 4-N: Extract each form section component**

Same a-h pattern as Task 2.1 Step 2-7. One commit per section.

- [ ] **Step Final: Verify `page.tsx` is ~120 lines**

```bash
wc -l src/app/admin/businesses/new/page.tsx
```

---

### Task 2.3: Decompose `src/components/DashboardContent.tsx` and create shared types

**Files:**
- Read first: `src/components/DashboardContent.tsx` (~470 lines), `src/app/api/dashboard/route.ts` (for shared types)
- Create: `src/lib/dashboard/types.ts`
- Create: `src/components/dashboard/ValueSummary.tsx`
- Create: `src/components/dashboard/Charts.tsx`
- Create: `src/components/dashboard/ReviewsList.tsx`
- Create: `src/components/dashboard/ReviewActions.tsx`
- Create: `src/components/dashboard/AccountStateScreens.tsx`
- Create: `src/hooks/useDashboardData.ts`
- Modify: `src/components/DashboardContent.tsx`
- Modify: `src/app/api/dashboard/route.ts` (re-import shared types)

**Why:** The component imports types directly from the route handler (an unsound pattern that breaks if the route's exports change), and conflates fetch/state/render concerns.

- [ ] **Step 1: Move the route's `DashboardData*` interfaces to a shared module**

Read `src/app/api/dashboard/route.ts:9-77` and copy all `DashboardSettings`, `DashboardDataActive`, `DashboardDataPendingPayment`, `DashboardDataPendingAdminHandoff`, `DashboardDataActivePendingBusiness`, and `DashboardData` types verbatim into `src/lib/dashboard/types.ts`:

```ts
// src/lib/dashboard/types.ts

export interface DashboardSettings {
  /* COPY VERBATIM from src/app/api/dashboard/route.ts:9-20 */
}

export interface DashboardDataActive {
  /* COPY VERBATIM from src/app/api/dashboard/route.ts:22-52 */
}

export interface DashboardDataPendingPayment {
  /* ... */
}

export interface DashboardDataPendingAdminHandoff {
  /* ... */
}

export interface DashboardDataActivePendingBusiness {
  /* ... */
}

export type DashboardData =
  | DashboardDataActive
  | DashboardDataPendingPayment
  | DashboardDataPendingAdminHandoff
  | DashboardDataActivePendingBusiness;
```

- [ ] **Step 2: Update `src/app/api/dashboard/route.ts`**

- Delete the inline interfaces (lines 9-77).
- Add: `import type { DashboardData, DashboardDataActive, DashboardDataPendingPayment, DashboardDataPendingAdminHandoff, DashboardDataActivePendingBusiness, DashboardSettings } from '@/lib/dashboard/types';`
- Re-export the types so any existing direct importers stay compatible:

```ts
export type { DashboardData, DashboardDataActive, DashboardDataPendingPayment, DashboardDataPendingAdminHandoff, DashboardDataActivePendingBusiness, DashboardSettings } from '@/lib/dashboard/types';
```

- [ ] **Step 3: Update `src/components/DashboardContent.tsx`**

Replace its current `import type { ... } from '@/app/api/dashboard/route'` (or however it currently imports) with `import type { ... } from '@/lib/dashboard/types';`.

- Run gate. Commit `refactor(dashboard): extract DashboardData types to lib/dashboard/types.ts`. Codex nudge.

- [ ] **Step 4-8: Extract dashboard sub-components** (same a-h pattern as Task 2.1)

Order: `ValueSummary` → `Charts` → `ReviewsList` → `ReviewActions` → `AccountStateScreens`. One commit per component.

- [ ] **Step 9: Extract `useDashboardData` hook**

```ts
// src/hooks/useDashboardData.ts
'use client';
import { useEffect, useState, useCallback } from 'react';
import type { DashboardData } from '@/lib/dashboard/types';

export function useDashboardData() {
  /* moves fetch + state from DashboardContent verbatim */
  return { data, loading, error, refresh };
}
```

Run gate. Commit. Codex nudge.

- [ ] **Step 10: Verify `DashboardContent.tsx` is ~120 lines**

```bash
wc -l src/components/DashboardContent.tsx
```

---

## Wave 3: Service-layer extractions

### Task 3.1: Extract `src/lib/dashboard/service.ts`

**Files:**
- Create: `src/lib/dashboard/service.ts`
- Modify: `src/app/api/dashboard/route.ts` (delete heavy assembly; call service)

**Why:** The route at `src/app/api/dashboard/route.ts` is ~405 lines, dominated by 8 queries + ranking grouping + brief selection. Per spec §7.1, the route keeps the preflight (3 state-discriminated early returns) but delegates the active-path heavy assembly to a service module.

- [ ] **Step 1: Read the heavy assembly block** in `src/app/api/dashboard/route.ts:173-405`

Identify everything between the preflight `return jsonResponse({ subscriptionStatus: 'active_pending_business', ... })` and the final `return jsonResponse(activeData)`. This is the block that moves.

- [ ] **Step 2: Create the service module**

```ts
// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription and
// completed business onboarding. The route handler runs preflight checks
// (subscription status, place_id_verified, etc.) and only calls this
// when the active dashboard path is appropriate.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import { sql } from '@/lib/db/server';
import { parseDbArray } from '@/lib/shared/db-array';
import type { DashboardDataActive } from './types';

export async function getActiveDashboardData(businessId: string): Promise<DashboardDataActive> {
  /* COPY VERBATIM from src/app/api/dashboard/route.ts the entire 8-query Promise.all
     block + ranking grouping + brief selection + final assembly into the
     DashboardDataActive shape. */
}
```

The verbatim copy includes every SQL string, every `parseDbArray` call (now sourced from the shared module), and the assembly pattern.

- [ ] **Step 3: Trim `src/app/api/dashboard/route.ts`**

Replace the moved block with a single call:

```ts
// inside GET, after the three preflight early returns:
const data = await getActiveDashboardData(businessId);
return jsonResponse(data);
```

Add: `import { getActiveDashboardData } from '@/lib/dashboard/service';`.

After this, the route should be ~120 lines.

- [ ] **Step 4: Run gate**

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

The dashboard route's existing tests (search `src/app/api/dashboard/__tests__/` and any e2e/playwright that hits `/api/dashboard`) must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/service.ts src/app/api/dashboard/route.ts
git commit -m "$(cat <<'EOF'
refactor(dashboard): extract heavy assembly to lib/dashboard/service.ts

Route keeps the preflight (3 state-discriminated early returns) and
delegates DashboardDataActive assembly to getActiveDashboardData.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Codex nudge.**

---

### Task 3.2: Extract `src/lib/onboarding/admin-onboarding-service.ts`

**Files:**
- Read first: `src/app/api/admin/businesses/route.ts` (~390 lines, focus on the POST handler)
- Create: `src/lib/onboarding/admin-onboarding-service.ts`
- Modify: `src/app/api/admin/businesses/route.ts`

**Why:** Admin onboarding orchestration (`inviteUserByEmail`, `auth_id` patch, compensating delete on invite failure, `createBusinessTx` admin mode) lives inline in the route. The existing `createBusinessTx` is the dual-mode primitive; the service module is one layer above it for admin-specific orchestration.

- [ ] **Step 1: Identify the orchestration boundary**

In the POST handler, find the boundary between auth/Zod parsing (HTTP-level concerns) and the business creation orchestration (calls to Supabase `inviteUserByEmail`, `createBusinessTx`, `auth_id` patch, error compensations). The latter moves to the service.

- [ ] **Step 2: Create the service module**

```ts
// src/lib/onboarding/admin-onboarding-service.ts

import { /* same imports as the route currently has for the orchestration block */ } from '...';
import { createBusinessTx } from './createBusinessTx';
import type { /* the parsed-input type */ } from '...';

export interface AdminOnboardingInput {
  /* shape: parsed Zod output from the route */
}

export interface AdminOnboardingResult {
  businessId: string;
  /* ... whatever the route currently returns post-orchestration ... */
}

export async function onboardBusinessAsAdmin(
  input: AdminOnboardingInput,
): Promise<AdminOnboardingResult> {
  /* COPY VERBATIM from the route POST handler:
       - Supabase auth.admin.inviteUserByEmail call
       - createBusinessTx in admin mode
       - auth_id patch
       - compensating delete on failure
     Return AdminOnboardingResult on success; throw typed errors on failure. */
}
```

- [ ] **Step 3: Trim `src/app/api/admin/businesses/route.ts`**

POST handler shrinks to: requireRole + Zod parse + `onboardBusinessAsAdmin(parsed)` + response shaping. ~80 lines for the handler.

- [ ] **Step 4-6:** Run gate, commit, codex nudge.

---

### Task 3.3: Refactor `src/app/api/admin/businesses/[id]/route.ts` (split GET/PATCH internally)

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

**Decision:** keep the split internal to the file (no separate service module) unless the GET aggregation exceeds ~150 lines after isolation. Decide during execution.

- [ ] **Step 1: Read the file**

```bash
wc -l src/app/api/admin/businesses/\[id\]/route.ts
sed -n '1,50p' src/app/api/admin/businesses/\[id\]/route.ts
```

- [ ] **Step 2: Identify GET aggregation block** (typically after `requireRole` and `params.id` extraction, before the response shaping).

- [ ] **Step 3: Extract to a private function** at the bottom of the file:

```ts
async function getBusinessDetail(id: string): Promise<BusinessDetail | null> {
  /* COPY VERBATIM the aggregation block from GET */
}

async function updateBusiness(id: string, patch: BusinessPatch): Promise<void> {
  /* COPY VERBATIM the upsert block from PATCH */
}
```

`BusinessDetail` and `BusinessPatch` types: define inline at the top of the file or in a colocated `types.ts` if they're reused elsewhere.

- [ ] **Step 4: Decision point**

If `getBusinessDetail` is more than ~150 lines, promote it (and `updateBusiness`) to `src/lib/admin/business-detail-service.ts` and update the route to import them. Otherwise leave them as private functions in the route file.

- [ ] **Step 5-7: Run gate, commit, codex nudge.**

---

## Wave 4: High-risk extractions

### Task 4.1: Split `src/lib/notifications/email.ts`

**Files:**
- Read first: `src/lib/notifications/email.ts` (1110 lines, all functions listed below)
- Create: `src/lib/notifications/email/client.ts`
- Create: `src/lib/notifications/email/headers.ts`
- Create: `src/lib/notifications/email/templates/shared.ts` (only if shared HTML helpers are identified)
- Create: `src/lib/notifications/email/templates/approval.ts`
- Create: `src/lib/notifications/email/templates/manual-post.ts`
- Create: `src/lib/notifications/email/templates/internal.ts`
- Create: `src/lib/notifications/email/templates/weekly-value-report.ts`
- Create: `src/lib/notifications/email/templates/monthly-impact.ts`
- Create: `src/lib/notifications/email/templates/owner-nudge.ts`
- Create: `src/lib/notifications/email/templates/partner-alerts.ts`
- Create: `src/lib/notifications/email/templates/onboarding.ts`
- Modify: `src/lib/notifications/email.ts` (becomes a barrel)

**Why:** 8 template families + client + headers + tags in one file. 20 callers across worker + tests.

**Approach:** one commit per template family. Each commit is a verbatim move + barrel re-export update. The barrel file at `src/lib/notifications/email.ts` is updated incrementally so external callers always have a working import.

- [ ] **Step 1: Plan the order of extraction**

Order chosen for blast-radius and dependency:

1. `client.ts` (no deps; rest of file uses `getResend`)
2. `headers.ts` (no deps within email module)
3. `templates/approval.ts` (most-touched template; do early to flush out cross-template helpers)
4. `templates/manual-post.ts`
5. `templates/internal.ts`
6. `templates/weekly-value-report.ts`
7. `templates/monthly-impact.ts`
8. `templates/owner-nudge.ts`
9. `templates/partner-alerts.ts`
10. `templates/onboarding.ts`
11. After all moves: `email.ts` becomes a pure barrel.

If during extraction you discover a helper used by multiple templates, hoist it to `templates/shared.ts` in its own commit before continuing.

- [ ] **Step 2: Extract `client.ts`**

```ts
// src/lib/notifications/email/client.ts
import { Resend } from 'resend';

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}
```

In `src/lib/notifications/email.ts`:
- Delete the local `getResend` and `_resend` (lines 7-14).
- Add `export { getResend } from './email/client';` at the top of the exports section (or `import { getResend } from './email/client';` if the file still has internal callers — keep both for now).

Run gate. Commit `refactor(email): extract Resend lazy client to email/client.ts`. Codex nudge.

- [ ] **Step 3: Extract `headers.ts`**

Move `EmailCategory` (line 26), `extractMailbox` (line 32-39), `getEmailHeaders` (line 61-99), and `getEmailTags` (line 101-103). Verbatim. Update `email.ts` to re-export them.

Run gate. Commit. Codex nudge.

- [ ] **Step 4: Extract `templates/approval.ts`**

Move:
- `ApprovalEmailParams` interface (line 105)
- `sendApprovalEmail` (line 188)
- Any approval-specific HTML builder helpers in lines 105-220 not covered above

```ts
// src/lib/notifications/email/templates/approval.ts
import { getResend } from '../client';
import { getEmailHeaders, getEmailTags } from '../headers';
/* ... copy approval-specific imports ... */

export interface ApprovalEmailParams {
  /* COPY VERBATIM */
}

/* COPY VERBATIM all approval-specific helpers and sendApprovalEmail */
```

Update `email.ts`:
```ts
export { sendApprovalEmail } from './email/templates/approval';
export type { ApprovalEmailParams } from './email/templates/approval';
```

Run gate. Commit `refactor(email): extract approval template`. Codex nudge.

- [ ] **Steps 5-10:** Repeat for each template family.

For each, the pattern is identical:
- Identify the function + interface ranges (use the grep output earlier in the spec):
  - Manual post: lines 221-280
  - Internal: lines 281-338
  - Weekly value report: lines 339-508
  - Monthly impact: lines 509-634
  - Owner nudge: lines 635-697
  - Partner alerts: lines 698-1015 (4 builders + 4 interfaces)
  - Onboarding: lines 839-1109 (3 day variants)
- Move verbatim into the new template file.
- Add the imports the function needs (`getResend`, `getEmailHeaders`, etc.).
- Update `email.ts` to re-export.
- Run gate, commit, codex nudge.

For `templates/partner-alerts.ts`, all 4 partner-related builders go into the same file because they share param-type-like-shape and tend to change together. Keep their interfaces in the same file.

- [ ] **Step 11: Final barrel cleanup of `email.ts`**

After all 8 template families are extracted, `email.ts` should contain ONLY re-exports. Replace its full contents with:

```ts
// src/lib/notifications/email.ts
//
// Barrel re-export of the modularized email layer. New code should import
// directly from email/client, email/headers, or email/templates/<family>.
//
// Existing imports from '@/lib/notifications/email' continue to resolve
// without modification.

export * from './email/client';
export * from './email/headers';
export * from './email/templates/approval';
export * from './email/templates/manual-post';
export * from './email/templates/internal';
export * from './email/templates/weekly-value-report';
export * from './email/templates/monthly-impact';
export * from './email/templates/owner-nudge';
export * from './email/templates/partner-alerts';
export * from './email/templates/onboarding';
```

Run gate. Commit `refactor(email): finalize barrel re-export`. Codex nudge.

- [ ] **Step 12: Verify size**

```bash
wc -l src/lib/notifications/email*.ts src/lib/notifications/email/**/*.ts
```

Each template file is ~50-200 lines (templates can legitimately exceed 250 — see spec §11.6). The barrel `email.ts` is ~15 lines.

---

### Task 4.2: Split `src/lib/approval/service.ts`

**Files:**
- Create: `src/lib/approval/locks.ts`
- Create: `src/lib/approval/token-mode.ts`
- Create: `src/lib/approval/session-mode.ts`
- Create: `src/lib/approval/callback-mode.ts`
- Modify: `src/lib/approval/service.ts` (becomes a barrel)
- Modify: `src/lib/approval/audit.ts` (only if `CallbackApprovalInput` moves here from service.ts)

**Why:** 590 lines of 9 public functions across 3 auth modes. Mode-only split (per spec §8.2) preserves each flow verbatim.

- [ ] **Step 1: Extract `locks.ts`**

Move:
- `hashToken` (private, used by lockValidLink) — lines 45-47
- `lockValidLink` — line 76
- `verifyDevice` — line 126
- `consumeLink` — line 132
- `lockPendingResponse` — line 141
- `revokeSiblings` — line 156
- `lockLinkByIdForCallback` — line 468
- `revokeOpenLinksForResponse` — line 293

```ts
// src/lib/approval/locks.ts
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  ResponseNotPendingError,
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from './errors';
import type { ApprovalLink } from './service';

type TxClient = postgres.TransactionSql;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function lockValidLink(tx: TxClient, rawToken: string): Promise<ApprovalLink> {
  /* COPY VERBATIM from service.ts:76-97 */
}

export function verifyDevice(link: ApprovalLink, deviceCookieHash: string): void {
  /* COPY VERBATIM */
}

export async function consumeLink(tx: TxClient, linkId: string): Promise<void> { /* VERBATIM */ }
export async function lockPendingResponse(tx: TxClient, responseId: string) { /* VERBATIM */ }
export async function revokeSiblings(tx: TxClient, responseId: string, excludeLinkId: string): Promise<void> { /* VERBATIM */ }
export async function lockLinkByIdForCallback(tx: TxClient, approvalLinkId: string, expectedChannel: string): Promise<ApprovalLink> { /* VERBATIM */ }
export async function revokeOpenLinksForResponse(tx: TxClient, responseId: string): Promise<void> { /* VERBATIM */ }
```

Update `service.ts` to import all of these from `./locks` and remove the local definitions.

Run gate. Commit `refactor(approval): extract locks module`. Codex nudge.

- [ ] **Step 2: Extract `token-mode.ts`**

Move:
- `approve` — line 175
- `edit` — line 212
- `regenerate` — line 257

```ts
// src/lib/approval/token-mode.ts
//
// Token-mode approve/edit/regenerate. Caller authentication is by raw
// token + bound device cookie. See locks.ts for the lock helpers and
// audit.ts for the audit writers.

import { v7 as uuidv7 } from 'uuid';
import { distance } from 'fastest-levenshtein';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';
import { verifyDevice, lockPendingResponse, consumeLink, revokeSiblings } from './locks';
import { insertAuditLog } from './audit';
import type { ApprovalLink } from './service';
import type { AuditContext } from './audit';
import type { PublishResponsePayload, GenerateResponsePayload } from '@/lib/shared/worker-types';

type TxClient = postgres.TransactionSql;

export async function approve(/* signature unchanged */): Promise<void> {
  /* COPY VERBATIM from service.ts:175-206 */
}

export async function edit(/* signature unchanged */): Promise<void> {
  /* COPY VERBATIM from service.ts:212-250 */
}

export async function regenerate(/* signature unchanged */): Promise<void> {
  /* COPY VERBATIM from service.ts:257-286 */
}
```

Update `service.ts` to remove these three functions and add re-exports.

Run gate. Commit `refactor(approval): extract token-mode actions`. Codex nudge.

- [ ] **Step 3: Extract `session-mode.ts`**

Move:
- `establishApprovalSession` — line 99
- `approveBySession` — line 335
- `editBySession` — line 369
- `regenerateBySession` — line 410

Same pattern. Imports: `lockPendingResponse`, `revokeOpenLinksForResponse` from `./locks`, `insertAuditLogSession` from `./audit`.

Run gate. Commit `refactor(approval): extract session-mode actions`. Codex nudge.

- [ ] **Step 4: Extract `callback-mode.ts`**

Move:
- `CallbackApprovalInput` interface — line 461
- `approveViaCallback` — line 527
- `regenerateViaCallback` — line 563

Imports: `lockLinkByIdForCallback`, `lockPendingResponse`, `consumeLink`, `revokeSiblings` from `./locks`; `buildCallbackAudit`, `insertAuditLog` from `./audit`; `recoverCorrelationId` from `./correlation`.

Move `CallbackApprovalInput` here AND update `audit.ts` to import it from `./callback-mode` instead of from `./service`. This breaks the temporary circular import we accepted in Task 1.3 Step 3.

Run gate. Commit `refactor(approval): extract callback-mode actions`. Codex nudge.

- [ ] **Step 5: Replace `service.ts` with the barrel**

After all four extractions:

```ts
// src/lib/approval/service.ts
//
// Barrel re-export of the modularized approval layer. New code should
// import directly from approval/locks, approval/audit, approval/token-mode,
// approval/session-mode, or approval/callback-mode.
//
// Existing imports from '@/lib/approval/service' continue to resolve.

export type { ApprovalLink } from './types';   // see step 5a if extracted

export * from './errors';        // existing re-exports if any
export * from './locks';
export * from './audit';
export * from './token-mode';
export * from './session-mode';
export * from './callback-mode';
```

Step 5a: if `ApprovalLink` is only defined in `service.ts` currently, extract it to a small `src/lib/approval/types.ts` so locks.ts and the mode files can import it without a cycle. The interface is on lines 26-37 of the original service.ts.

Run gate. Commit `refactor(approval): finalize barrel re-export`. Codex nudge.

- [ ] **Step 6: Verify**

```bash
wc -l src/lib/approval/service.ts src/lib/approval/locks.ts src/lib/approval/audit.ts src/lib/approval/token-mode.ts src/lib/approval/session-mode.ts src/lib/approval/callback-mode.ts src/lib/approval/types.ts
```

`service.ts` ~30 lines. Each mode file ~100-150 lines. `locks.ts` ~80 lines. `audit.ts` ~80 lines.

---

### Task 4.3: Decompose `worker/jobs/NotificationWorker.ts`

**Files:**
- Read first: `worker/jobs/NotificationWorker.ts` (423 lines), `worker/__tests__/NotificationWorker.test.ts`, `-sms.test.ts`, `-telegram.test.ts`
- Create: `worker/jobs/notification/eligibility.ts`
- Create: `worker/jobs/notification/errors.ts`
- Create: `worker/jobs/notification/sms-budget.ts`
- Create: `worker/jobs/notification/dispatch.ts`
- Modify: `worker/jobs/NotificationWorker.ts` (rewritten in place — NO barrel; this file is the canonical entry)

**Why:** Highest-risk wave. Critical path for owner approval emails. Decomposed into 5 commits, each with the gate run, so a regression is caught immediately.

**Pre-flight gate:**
- [ ] **Step 0: Verify NotificationWorker test coverage exists**

```bash
ls worker/__tests__/NotificationWorker*.test.ts
pnpm test worker/__tests__/NotificationWorker
```

Expected: `NotificationWorker.test.ts` plus optionally the SMS / Telegram variants. All pass on the unmodified branch. If they don't exist, halt and surface — this task does NOT proceed without coverage.

- [ ] **Step 1: Extract `errors.ts`**

```ts
// worker/jobs/notification/errors.ts
//
// Provider error classification for the notification dispatch loop.
// Each error class maps to an enrollment-mutation directive.

import {
  SmsRecipientUnsubscribedError,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
} from '../../../src/lib/notifications/channels';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export type ErrorClassification =
  | { kind: 'owner_intent_unenroll'; reason: string }   // SMS unsub, Telegram block, WA block/invalid
  | { kind: 'config_error'; reason: string }            // WA template config
  | { kind: 'session_window'; reason: string }          // WA 24h window expired
  | { kind: 'transient'; reason: string }               // rate limit, timeout, network
  | { kind: 'unknown'; reason: string };

export function classifyChannelError(
  channelId: ChannelId,
  err: unknown,
): ErrorClassification {
  /* COPY VERBATIM the if/else chain from the current dispatch loop in
     NotificationWorker.ts that maps each error class to an enrollment
     mutation. The classifier returns ErrorClassification; the caller
     applies the mutation. */
}
```

Update `NotificationWorker.ts` to import `classifyChannelError` and use it inline (replacing the existing if/else chain). Behavior must be identical.

Run gate (`pnpm test` is the critical signal here — focus on the NotificationWorker tests). Commit `refactor(notification): extract provider-error classifier`. Codex nudge.

- [ ] **Step 2: Extract `sms-budget.ts`**

```ts
// worker/jobs/notification/sms-budget.ts

import { reserveSmsCost, refundSmsCost, DailySmsLimitExceededError } from '../../../src/lib/costs/sms-tracker';

export { reserveSmsCost, refundSmsCost, DailySmsLimitExceededError };

// If there's wrapping logic in NotificationWorker around reserve/refund
// (typically: try { reserve } catch { mark failed and skip }), move that
// wrapping logic here as `withSmsBudget(businessId, fn)`.
```

This module exists primarily to keep import surface tidy. If there's no wrapping logic to move, the module is a passthrough — still useful so the dispatch loop's imports from `costs/sms-tracker` go through the notification subdir.

Run gate. Commit `refactor(notification): isolate SMS budget wrapper`. Codex nudge.

- [ ] **Step 3: Extract `eligibility.ts`**

```ts
// worker/jobs/notification/eligibility.ts
//
// Determines which channels are eligible to dispatch an approval
// notification: subscription gate, per-channel feature flags, verified
// enrollments. Returns the list of channels that should receive the
// notification.

import { sql } from '../../../src/lib/db/server';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { getVerifiedEnrollments } from '../../../src/lib/notifications/enrollments';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export interface EligibilityInput {
  businessId: string;
  subscriptionStatus: string;
  businessUpdatedAt: Date;
}

export interface EligibleChannel {
  channelId: ChannelId;
  enrollmentId: string;
  recipient: string;
}

export async function getEligibleChannels(
  input: EligibilityInput,
): Promise<{ ok: true; channels: EligibleChannel[] } | { ok: false; reason: string }> {
  /* COPY VERBATIM the subscription gate + per-channel flag check + enrollment
     load logic from NotificationWorker.ts.

     Per-channel flags:
       - email is always allowed if enrolled
       - sms requires CHANNELS_SMS_ENABLED=true
       - telegram requires CHANNELS_TELEGRAM_ENABLED=true
       - whatsapp requires CHANNELS_WHATSAPP_ENABLED=true
     The exact flag names + defaults match the current code.
  */
}
```

Update `NotificationWorker.ts` to call `getEligibleChannels`. The `handleSendNotification` function shrinks accordingly.

Run gate. Commit `refactor(notification): extract channel eligibility`. Codex nudge.

- [ ] **Step 4: Extract `dispatch.ts`**

```ts
// worker/jobs/notification/dispatch.ts
//
// Per-channel send loop with isolated error handling. One failed channel
// does not abort the rest — that's the failover poller's job.

import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../../src/lib/db/server';
import { recordNotificationDelivery, insertFailedDelivery } from '../../../src/lib/notifications/delivery';
import { getChannel } from '../../../src/lib/notifications/channels';
import { createApprovalLink } from '../../../src/lib/approval/create-link';
import { classifyChannelError } from './errors';
import { reserveSmsCost, refundSmsCost, DailySmsLimitExceededError } from './sms-budget';
import type { EligibleChannel } from './eligibility';

export interface DispatchContext {
  responseId: string;
  businessId: string;
  /* + the response/review data needed to render messages */
}

export interface DispatchResult {
  channelId: string;
  outcome: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

export async function dispatchAll(
  ctx: DispatchContext,
  channels: EligibleChannel[],
  logger: { warn: (m: string) => void; error: (m: string) => void; info: (m: string) => void },
): Promise<DispatchResult[]> {
  /* COPY VERBATIM the per-channel for-loop from NotificationWorker.ts:
       - createApprovalLink(channel)
       - SMS cost reserve (if SMS) → on DailySmsLimitExceededError, skip
       - getChannel(id).send(...)
       - try/catch with classifyChannelError + enrollment mutation
       - recordNotificationDelivery on success / insertFailedDelivery on miss
     Each channel's exception path is wrapped so one failure doesn't abort
     the loop. */
}
```

Update `NotificationWorker.ts` to call `dispatchAll`.

Run gate. Commit `refactor(notification): extract per-channel dispatch loop`. Codex nudge.

- [ ] **Step 5: Rewrite `NotificationWorker.ts` as a thin orchestrator**

After Steps 1-4 the file is already much smaller. Tighten further:

```ts
// worker/jobs/NotificationWorker.ts
//
// Approval-notification dispatcher. Loads response + business context,
// asks eligibility for the channel list, hands off to dispatch, finalizes
// outbox. See docs/adding-communication-channels.md §3.1.

import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { getEligibleChannels } from './notification/eligibility';
import { dispatchAll } from './notification/dispatch';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[NotificationWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  /* COPY VERBATIM the data-loading SELECTs at the top of the original file
     (response + review + business). Then the early-exit checks (not found,
     mismatch, not pending). Then: */

  const eligibility = await getEligibleChannels({
    businessId: business_id,
    subscriptionStatus: business.subscription_status,
    businessUpdatedAt: business.updated_at,
  });
  if (!eligibility.ok) {
    logger.warn(`Skipping notification: ${eligibility.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const results = await dispatchAll(/* ctx */, eligibility.channels, logger);

  /* outbox finalization based on results: any sent → completed; all failed → fail
     (matches current behavior — read original file end for the exact rule) */
}
```

After this rewrite the file should be ~80-120 lines.

Run gate. Commit `refactor(notification): rewrite NotificationWorker as thin orchestrator`. Codex nudge.

- [ ] **Step 6: Final test run focused on NotificationWorker**

```bash
pnpm test worker/__tests__/NotificationWorker
```

All four NotificationWorker test files must pass. If any fails, the previous commit's diff is the suspect — bisect by reverting one extraction at a time.

---

### Task 4.4: Split `worker/ingress/twilio-whatsapp.ts`

**Files:**
- Read first: `worker/ingress/twilio-whatsapp.ts` (420 lines)
- Create: `worker/ingress/whatsapp-shared.ts`
- Create: `worker/ingress/twilio-whatsapp-status.ts`
- Create: `worker/ingress/twilio-whatsapp-inbound.ts`
- Modify: `worker/ingress/twilio-whatsapp.ts` (becomes a barrel)

**Why:** Status callback handler + inbound message handler are two distinct flows in one file.

- [ ] **Step 1: Extract shared helpers to `whatsapp-shared.ts`**

Move:
- `fullUrl` (line 21)
- `redactWhatsAppPayload` (line 27)
- `parseButtonPayload` (line 156)

```ts
// worker/ingress/whatsapp-shared.ts
import type { FastifyRequest } from 'fastify';

export function fullUrl(request: FastifyRequest): string {
  /* VERBATIM */
}

export function redactWhatsAppPayload(params: Record<string, string>): Record<string, string> {
  /* VERBATIM */
}

export function parseButtonPayload(/* signature */): /* same return type */ {
  /* VERBATIM */
}
```

Update `twilio-whatsapp.ts` to import these. Run gate, commit, codex nudge.

- [ ] **Step 2: Extract `twilio-whatsapp-status.ts`**

```ts
// worker/ingress/twilio-whatsapp-status.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { fullUrl, redactWhatsAppPayload } from './whatsapp-shared';
/* + the imports the status handler currently uses */

export async function handleTwilioWhatsAppStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  /* COPY VERBATIM from twilio-whatsapp.ts:43-125 */
}
```

Update `twilio-whatsapp.ts` to delete the function and re-export from the new file. Run gate, commit, codex nudge.

- [ ] **Step 3: Extract `twilio-whatsapp-inbound.ts`**

```ts
// worker/ingress/twilio-whatsapp-inbound.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { fullUrl, redactWhatsAppPayload, parseButtonPayload } from './whatsapp-shared';
import { markInboundEventProcessed, markInboundEventFailed } from './shared';
/* + the imports the inbound handler currently uses */

export async function handleTwilioWhatsAppInbound(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  /* COPY VERBATIM from twilio-whatsapp.ts:182-end */
}
```

Run gate, commit, codex nudge.

- [ ] **Step 4: Replace `twilio-whatsapp.ts` with barrel**

```ts
// worker/ingress/twilio-whatsapp.ts
//
// Barrel re-export. New code should import from twilio-whatsapp-status,
// twilio-whatsapp-inbound, or whatsapp-shared directly.

export { handleTwilioWhatsAppStatus } from './twilio-whatsapp-status';
export { handleTwilioWhatsAppInbound } from './twilio-whatsapp-inbound';
export { redactWhatsAppPayload } from './whatsapp-shared';
```

`worker/index.ts` continues to import from `./ingress/twilio-whatsapp` unchanged. Run gate, commit, codex nudge.

---

## Wave 5: Optional cleanup

### Task 5.1: Replace barrel imports with direct imports (optional)

**Decision criterion:** ONLY do this task if the diff for inlining is small enough to remain codex-reviewable in a single commit per barrel. If any single inlining diff exceeds ~300 lines, leave the barrel.

**Files affected:**
- All callers that currently import from `@/lib/notifications/email`
- All callers that import from `@/lib/approval/service`
- `worker/index.ts` imports of `./ingress/twilio-whatsapp` (split or keep)

- [ ] **Step 1: Audit caller diffs**

```bash
grep -rn "from '@/lib/notifications/email'" src/ worker/ | wc -l
grep -rn "from '@/lib/approval/service'" src/ worker/ | wc -l
grep -rn "ingress/twilio-whatsapp'" worker/ | wc -l
```

If totals are reasonable (< ~30 import sites), proceed. Otherwise stop here.

- [ ] **Step 2: Update each caller's imports** to point at the specific submodule.

Example: a caller importing `sendApprovalEmail` from `@/lib/notifications/email` becomes `import { sendApprovalEmail } from '@/lib/notifications/email/templates/approval';`.

- [ ] **Step 3: Delete the barrel files** that are no longer referenced.

- [ ] **Step 4-6: Run gate, commit, codex nudge.**

If at any point the gate fails, revert this task and ship the branch with barrels intact. The barrel re-exports are not a code smell — they are a stable public API.

---

## Final: Branch wrap-up

### Task F.1: Final gate + manual smoke

- [ ] **Step 1: Run the full gate clean**

```bash
pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build
```

All green, no skips that weren't skipped on the baseline.

- [ ] **Step 2: Smoke worker startup**

```bash
pnpm tsx worker/index.ts &
WORKER_PID=$!
sleep 5
curl -fsS http://localhost:${PORT:-3001}/health || true
kill $WORKER_PID
```

Expected: worker boots without throwing, health responds OK. (`MOCK_EXTERNAL_APIS=true` if Twilio/Telegram envs aren't set locally.)

- [ ] **Step 3: Smoke Next.js build run**

```bash
pnpm start &
NEXT_PID=$!
sleep 8
curl -fsS http://localhost:3000/ || true
kill $NEXT_PID
```

Expected: home page returns 200.

- [ ] **Step 4: Inventory the branch**

```bash
git log --oneline main..HEAD | wc -l   # commit count
git diff main..HEAD --stat | tail -5    # files changed / insertions / deletions
wc -l $(git diff main..HEAD --name-only | grep -E '\.(ts|tsx)$')   # file sizes after refactor
```

Confirm no orchestrator/mixed-responsibility file in the affected set exceeds ~250 lines. Template files may exceed (see spec §11.6).

- [ ] **Step 5: Final codex review of the branch as a whole**

```bash
wsl bash -c "bash ~/dev/codex-bridge/nudge 'Final review of refactor/modularization branch — please scan all commits for: behavior preservation, missed barrel re-exports, broken type imports, and any cross-mode contamination in the approval split.'"
```

This is async; do not block on the response. Address codex's findings in follow-up commits if substantive.

- [ ] **Step 6: Open PR (only when ready to merge)**

The user runs `/ultrareview` separately if desired. Do not auto-push or auto-open PR — that's the user's call.

---

## Plan self-review checklist (run by the planner before handing off)

- [x] Spec coverage: every numbered section in the design spec maps to at least one task above.
  - §5.1 → 1.1; §5.2 → 1.2; §5.3 → 1.3 + 4.2
  - §6.1 → 2.1; §6.2 → 2.2; §6.3 → 2.3
  - §7.1 → 3.1; §7.2 → 3.2; §7.3 → 3.3
  - §8.1 → 4.1; §8.2 → 4.2; §8.3 → 4.3; §8.4 → 4.4
  - §9 risk mitigations: Task 0.1 Step 4 (test coverage check), Task 4.3 Step 0 (preflight halt), per-commit gate (every task)
- [x] No "TBD"/"TODO" placeholders. Where the plan says "/* COPY VERBATIM */" it points to a specific line range that the executor reads from the actual source file. That's a deliberate instruction, not a placeholder.
- [x] Type consistency: `parseDbArray`, `getActiveDashboardData`, `onboardBusinessAsAdmin`, `classifyChannelError`, `getEligibleChannels`, `dispatchAll` are referenced consistently across tasks.
- [x] Per-commit gate is referenced explicitly in every commit step, and codex nudge follows.
- [x] Architecture invariants (Vercel UI only, transactional outbox, etc.) are stated in the header and not violated by any task. Refactor is mechanical, so these invariants are preserved by construction.
