# EditReplyDrawer Modularization — Design

_Date: 2026-05-28 · Branch: `refactor/edit-reply-drawer-modularization` (off `main`)_
_Tier-1 candidate from `docs/modular-requirement.md`._

## Goal

Decompose `src/components/dashboard/EditReplyDrawer.tsx` (1275 LOC, the largest
logic file) so the drawer **composes** behavior instead of **implementing** it,
without changing any runtime behavior or its public contract.

This is a pure structural refactor. The rendered UI, the 11-state machine
semantics, every API call, and every focus/keyboard behavior stay
byte-for-byte equivalent.

## Current state

The file fuses three independent concerns behind one component:

1. **Draft state machine** — an 11-variant `DrawerState` discriminated union,
   9 async action callbacks (`startRegenerate`, `submitManual`,
   `publishExisting`, `cancelDraft`, `retryPosting`, `resumeExistingDraft`,
   `discardExistingDraft`, `restoreOriginal`, `startManualEdit`),
   `handleHttpError`, `readJsonSafe`, the `snapshotRef`, and the 60s polling
   `useEffect`. ~500 LOC.
2. **DOM focus management** — `panelRef`/`openerRef`, the focus-capture /
   Tab-trap / Esc / focus-restore `useEffect`, and the `tryCloseRef` sync
   `useEffect`. ~75 LOC.
3. **Six presentational panels** — `ManualEditor`, `PreviewPanel`,
   `RecoveryPanel`, `DraftConflictPanel`, `ReviewChangedPanel`, `Spinner`.
   ~330 LOC.

### Public contract that MUST stay stable

- `EditReplyDrawer` named export and its `EditReplyDrawerProps` signature.
- File path `src/components/dashboard/EditReplyDrawer.tsx` (3 importers:
  `past-replies/page.tsx`, `PastRepliesClient.tsx`, `PastReplyCard.tsx`).
- `PastReplyRow` continues to be imported from `PastReplyCard.tsx`.

## Target architecture

A feature folder mirroring the existing `components/auth/auth-island/`
precedent. The entry file keeps its path and becomes a thin composing shell.

```
src/components/dashboard/
  EditReplyDrawer.tsx            MODIFIED → composing shell (~300 LOC: the ~260-line
                                 state-switch render JSX stays here; only the
                                 panel definitions, state machine, and focus
                                 logic move out). Same path & export.
  edit-reply/                    NEW feature folder
    useEditReplyDraft.ts         state machine + 9 actions + polling + tryClose;
                                 owns DrawerState, Snapshot, ApiErrorPayload,
                                 readJsonSafe, POLL_INTERVAL_MS, POLL_TIMEOUT_MS
    useFocusTrap.ts              focus capture / Tab-trap / Esc / restore
    ManualEditor.tsx             moved verbatim; owns MAX_REPLY_CHARS
    PreviewPanel.tsx             moved verbatim
    RecoveryPanel.tsx            moved verbatim
    DraftConflictPanel.tsx       moved verbatim (keeps next/link import)
    ReviewChangedPanel.tsx       moved verbatim
    __tests__/
      useEditReplyDraft.test.tsx NEW characterization suite
```

### Stays inline in the shell (pragmatic split)

Per the chosen "pragmatic split", these are too small or too shell-specific to
warrant their own file:

- `Spinner` (8 lines) — stays a local function; it is used by the inline
  loading blocks that remain in the shell.
- The `initial` CTA block, the `creating_draft`/`regenerating` and `publishing`
  loading blocks, and the `error` / `success` blocks — small inline JSX driven
  directly by shell-local handlers (`actions.*`, `onClose`).
- The always-shown review-snapshot and current-Google-reply `<section>`s.

The five extracted panels are exactly the substantial ones the requirement
names, minus `Spinner`.

## Hook interfaces

### `useEditReplyDraft`

```ts
export type DrawerState = /* the 11-variant union, moved verbatim */;

export function useEditReplyDraft(params: {
  row: PastReplyRow;
  initialFailureRecovery: {
    failedResponseId: string;
    failedPostingError: string | null;
  } | null;
  onClose: () => void;
}): {
  state: DrawerState;
  isClosePending: boolean;   // true for creating_draft | regenerating | regenerate_poll_error
  tryClose: () => void;
  actions: {
    startManualEdit(): void;
    startRegenerate(): Promise<void>;
    submitManual(text: string, existingDraftId: string | null): Promise<void>;
    publishExisting(draftResponseId: string): Promise<void>;
    cancelDraft(draftResponseId: string | null): void;
    retryPosting(failedResponseId: string): Promise<void>;
    resumeExistingDraft(existing: { responseId: string; text: string }): void;
    discardExistingDraft(responseId: string): Promise<void>;
    restoreOriginal(failedResponseId: string): Promise<void>;
    // Declarative transitions — replace the three raw setState() calls
    // currently inlined in JSX. Implemented with guarded functional updates
    // (setState(prev => prev.kind === '…' ? … : prev)) so they are
    // stale-closure-safe yet behavior-equivalent.
    resumePolling(): void;   // regenerate_poll_error → regenerating (same outboxId)
    editFurther(): void;     // preview → editing (carry text + draftResponseId)
    reset(): void;           // → initial ("Try again")
  };
};
```

`isClosePending` removes the triple-repeated
`state.kind === 'creating_draft' || … || 'regenerate_poll_error'` boolean from
the shell. The header's per-kind title/aria-label text remains in the shell as
pure presentation (it reads `state.kind`).

### `useFocusTrap`

```ts
export function useFocusTrap(
  open: boolean,
  onEscape: () => void,
): { panelRef: React.RefObject<HTMLElement | null> };
```

Internally creates `panelRef`/`openerRef`, stabilizes `onEscape` through an
internal ref (the same pattern as today's `tryCloseRef` sync effect — listener
attaches once per open, not per state change), runs the focus-capture /
Tab-trap / Esc / restore effect keyed on `[open]`, and returns `panelRef` for
the shell to attach to the `<aside>`.

> **Judgment call (flagged for review):** Extracting `useFocusTrap` as a second
> hook goes one step beyond the requirement, which names only
> `useEditReplyDraft`. Recommended because focus management is orthogonal to the
> draft machine and keeps the shell genuinely thin. Acceptable alternative:
> leave focus-trap inline in the shell. **Approved during brainstorming.**

### The shell after refactor

```
EditReplyDrawer(props)
  → const { state, actions, tryClose, isClosePending } = useEditReplyDraft({ row, initialFailureRecovery, onClose })
  → const { panelRef } = useFocusTrap(open, tryClose)
  → if (!open) return null            // AFTER the hooks (rules of hooks preserved)
  → render dialog/backdrop/header + review-snapshot + current-reply
    + switch on state.kind → inline blocks or extracted panels
```

## Behavior-preservation contract

These are the invariants the refactor must not break. The hook test suite
encodes them.

1. **Public surface unchanged** — export, props, file path, callers untouched.
2. **Polling effect** keeps its `[state]` dependency and the
   `if (state.kind !== 'regenerating') return;` guard **verbatim**:
   `creating_draft` never polls; the 60s timeout, non-OK status, and thrown
   network error all transition to `regenerate_poll_error` (preserving
   `outboxId`, close stays blocked); `status === 'failed'` and unknown shapes
   drop to closable `error`.
3. **`tryClose`** refusal for `creating_draft`/`regenerating`/
   `regenerate_poll_error`; `editing`-with-draft and `preview` route through
   `cancelDraft` (idempotent DELETE) then `onClose`; all other states call
   `onClose` directly.
4. **`snapshotRef`** and the recovery-vs-initial first state keep
   `useRef`/`useState`-initializer semantics (captured once per mount).
5. **Esc listener** attaches once per open via an internal `onEscape` ref;
   focus capture, Tab-trap wrap-around, and focus restoration on unmount are
   identical.
6. **`router.refresh()`** still fires after successful publish, retry, and
   restore.
7. The three new declarative transitions are behavior-equivalent to the
   current inline `setState` closures (verified by tests).

### Move convention (anti-transcription-drift)

When relocating a panel or the action/effect bodies, move the code
**verbatim** — copy the existing body unchanged and adjust only imports,
exports, and (for the declarative transitions) the documented functional-update
rewrite. No opportunistic edits, renames, or "while I'm here" cleanups inside a
move. Any behavioral change must be a separate, called-out step. (Same
convention used by the `edit-publish.ts` modularization.)

## Testing strategy — hook tests first

Infra confirmed present: `renderHook` (`@testing-library/react` v16, already
used in `src/hooks/__tests__/`), `vi.mock('next/navigation')`, `vi.fn()` fetch
mock, `vi.useFakeTimers()` (vitest 4 + jsdom).

`edit-reply/__tests__/useEditReplyDraft.test.tsx` covers, at minimum:

- `startManualEdit` → `editing` with `currentReplyText`.
- `startRegenerate` happy path: `creating_draft` → `regenerating` →
  (poll `generating` → `response_id`) → `preview`.
- `startRegenerate` 409 `review_changed` → `review_changed`.
- `startRegenerate` 409 `draft_already_exists` → `draft_conflict`.
- `submitManual` empty text → `error`; new-draft path → publish → `success`
  + `router.refresh`; existing-draft path → PATCH → publish → `success`.
- `publishExisting` → publish → `success`.
- Polling: timeout → `regenerate_poll_error`; `status: failed` → `error`;
  non-OK → `regenerate_poll_error`; `resumePolling` → `regenerating`.
- `retryPosting` → `success`; `restoreOriginal` → `success`.
- `tryClose`: refusal in the three outstanding-worker states; DELETE+close in
  `editing`/`preview`; direct close otherwise.
- `discardExistingDraft` → DELETE → `initial`; `cancelDraft` with/without id.

Backstop: the existing `PastRepliesClient.test.tsx` (22 tests) must stay green
— it exercises the drawer end-to-end through the public surface.

## Verification gates (before "done")

`pnpm lint && pnpm typecheck && pnpm test` — all green, run in the isolated
worktree (outside the repo, own `node_modules`, to avoid the nested-worktree
lint/test poisoning noted in CLAUDE.md). No DB or schema is touched, so
`ci:tenant-scope` / `ci:rls-audit` are not required.

## Non-goals / out of scope

- No change to the API routes under `src/app/api/dashboard/past-replies/*`.
- No change to `PastReplyRow`, `PastReplyCard`, or `PastRepliesClient`.
- No UI/visual/styling changes; no copy changes.
- No "fix the latent single-snapshot-per-mount behavior" — it is preserved
  exactly as-is. Any such fix would be a separate, explicitly-scoped change.
- No new shared `Spinner` in `components/ui` (deferred; not needed for this
  refactor).
