# Run C plan review

Base: `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`. Native Codex reviewer: `/root/run_c_plan_skeptic`. Opus plan writer: session `2704fddf-3df4-40bf-93a9-901a1fa0c5de`, dispatched with `--model opus` (resolved `claude-opus-5`). Root reviewed and integrated the draft before the independent review. No implementation or gate claim at this stage.

## Round 1 — REVISE

| ID | Severity | Evidence and failure scenario | Root verdict and correction |
|---|---|---|---|
| PC1 | Medium | `proposals.ts:469` stales all same-location proposals; voice Apply calls it at `apply.ts:268`. New policy tokens do not depend on the voice row, so applying tone would incorrectly stale autonomy proposals. Spec §8.3 requires invalidation according to token freshness. | ACCEPT. T3 now changes the helper by token domain: voice location, policy location, or account-default dependency. Keep cross-conversation coverage and avoid cross-domain proposal locks. T7 adds mixed-domain and parent-dependent invalidation fixtures. |
| PC2 | Medium | T1/T3 completion-only lock barriers pass even if freshness is read, or proposal locked, before blocking on the account lock. Current unit evidence at `settings.test.ts:494` checks presence of FOR UPDATE, not ordering. | ACCEPT. Require explicit query-order assertions alongside live blocking tests; moving the relevant read/lock ahead of account must fail. |
| PC3 | Medium | Closeout first named staging exercise after main merge, while `.claude/CLAUDE.md` requires worker changes on staging before promotion. Provider changes also affect triage/judge/solicitation, outside the disabled production Operator flag. | ACCEPT. Deploy and verify reviewed candidate on staging before promotion, including fallback schema coverage. Preserve user-requested post-merge scope-card/count check. Regenerate final gate after evidence/report commits. |

Root also verified `context.ts:98` collapses an explicit null/manual location threshold into the account threshold. T2 now preserves whole-row inheritance and pins the manual location case. This fixes the projection used by autonomy previews; it changes no locked product decision.

The root's retained-veto source audit (`/root/run_c_veto_lock_audit`) confirmed a single statement-time count over current approved auto-policy responses and latest immutable grant audit rows, with `FOR SHARE OF aal` only. Account scope includes active inheritors. Record `asOf`; do not claim to freeze subsequent publisher/veto transitions through commit. No runtime writer changes are needed.

Revision 2 changed promised tests; the mechanical contract check required a verification-only round.

## Round 2 — APPROVED

Resumed the same native reviewer, verification-only. PC1 is addressed by the explicit `proposals.ts` lease, token-domain invalidation and mixed-domain/parent-dependent fixtures. PC2 is addressed by explicit query-order tests alongside live blocking evidence. PC3 is addressed by staging verification before main with candidate SHA and fallback-provider evidence, while preserving the post-merge scope-card check. The reviewer returned `VERDICT: APPROVED`; implementation and test execution remain unverified at this point.

The ticket and the four explicit owner delta answers authorize this contract. No unresolved product decision or additional edit surface remains. Root proceeds with T1 alone.
