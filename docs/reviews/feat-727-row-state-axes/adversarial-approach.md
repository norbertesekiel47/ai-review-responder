# Adversarial approach review (codex) — feat-727-row-state-axes

Thread: 019fe644-2ef5-75b0-8396-10bae71fe851 · base ae110dfd · Verdict: needs-attention

## Codex output (verbatim finding)

- [high] orphan×held projects a recovery action that cannot execute
  (src/lib/past-replies/replies-view.ts deriveRowAction). `deriveRowAction`
  returns `recover` for every orphan draft state, formalizing the claim that
  recovery is independent of a held draft. In reality, a held draft is a
  non-terminal response, and both `/retry` and `/restore-original` reject any
  non-terminal sibling with `409 newer_draft_exists` (retry/route.ts ~:100-113;
  restore-original/route.ts ~:119-130). The rendered Retry and Restore choices
  therefore both dead-end for orphan×held. Because the orphan has no live
  Google reply and the held draft is admin-controlled, the owner cannot recover
  the missing public reply until an administrator resolves the unrelated hold.
  The same omitted recovery axis also permits a posted×held row with a
  delete-failed sidecar to render an unusable recovery control. The branch does
  not create the endpoint restriction, but it ossifies the incompatible
  projection in the ADR and matrix tests.
  Recommendation: model recovery availability as an explicit server-side
  axis/capability; project only actions whose mutation preconditions pass; add
  integration tests executing both recovery endpoints for orphan×held and
  posted×held+sidecar.

## Orchestrator verification (2026-08-09)

CONFIRMED at the endpoint level: `retry/route.ts` step 1a rejects on ANY
non-terminal sibling (`newer_draft_exists`, 409); `'pending_approval'` (a held
draft's status) is in `NON_TERMINAL_STATUSES`. Same check in
`restore-original`. HOWEVER, three facts bound the blast radius:

1. **Pre-existing, unchanged behavior.** Before this branch, orphan×held and
   orphan×ready rendered the same `recover` control (is_orphan-first
   fallthrough) and the same 409s applied. The branch defines the cell; it does
   not change what the owner experiences.
2. **orphan×ready was locked WITH these facts in view.** #723's owner-signed
   call: "recovery dominates; pending draft stays reachable via Needs Action,
   so nothing is lost" — the owner clears the pending draft (approve/discard in
   Needs Action), after which the non-terminal check passes and recovery
   executes. The 409 is the migration-029 index protection working as designed,
   and `on-demand-generate.ts` documents exactly this interplay ("the draft it
   creates would then make retry 409 `newer_draft_exists` … so refuse it
   here").
3. **orphan×held's only charted reachability path is closed.** #723 listed the
   cell as reachable via "Generate API on an orphan (route has no orphan
   exclusion — leak)". That leak was fixed (post-#723): `on-demand-generate.ts`
   now refuses orphan reviews precisely to protect the recovery path. No known
   remaining producer creates a held draft on an orphaned review; migration
   029's unique index also forbids a held draft coexisting with the in-flight
   `approved` response an edit-publish failure would orphan.

## Triage

- **ACCEPT (docs-scope): the "recovery unaffected" wording is too strong.**
  ADR 0018's orphan×held rationale and the matching code comment must say the
  recovery *affordance* dominates (renders), while *executing* recovery with
  any non-terminal sibling — held included — 409s `newer_draft_exists` by
  design; for a held sibling that wait is admin-controlled. Fix applied on this
  branch (docs/comments only; no behavior change).
- **REJECT (map-level scope): remodel recovery availability as a projected
  capability axis + endpoint-execution integration tests.** That re-opens the
  #723 locked cross-product and touches recovery-endpoint semantics owned by
  other tickets. Per the ticket-seeded rule ("do not re-litigate decisions the
  map already made — surface as a map-level question"), filed as a follow-up
  question on map #710 instead.

VERDICTS: finding 1 → ACCEPT-AS-DOCS-FIX + MAP-QUESTION (no code behavior
change on this branch).
