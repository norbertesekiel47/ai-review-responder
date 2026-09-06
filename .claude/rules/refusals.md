---
paths:
  - "src/lib/refusals/**"
  - "src/app/api/dashboard/refusals/**"
---

# Refusal ledger rules

## Read first

- `docs/context/refusal-ledger.md` — **Refusal**, **Refusal category**, **Refusal source**, **Restraint tab** (LOCKED).
- ADR `docs/adr/0023-refusal-log-owner-safe-projection.md`.
- Rules + why: `docs/directory/lib-refusals.md` § `refusals/`.

## Traps

- (a) `src/lib/refusals/write.ts` is the table's ONLY writer — single-row and set-based; (b) a Refusal is RECORDED, never re-derived, so reads render the STORED category; (c) `held_draft` is the one lane with no category map; (d) `policy_gate_held` writes NOTHING while `AUTO_APPROVAL_ENABLED` is off.

## Rules

- Nothing beyond the traps was moved from `.claude/CLAUDE.md`; invariant #3 (no unapproved posting) and #4 (held drafts) bound the lanes that write here.
