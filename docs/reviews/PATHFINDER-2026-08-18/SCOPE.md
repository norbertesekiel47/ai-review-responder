# Pathfinder 2026-08-18 — scope brief

Read this before any subagent work. Artifacts live in
`docs/reviews/PATHFINDER-2026-08-18/` (repo convention — CLAUDE.md forbids new
top-level directories, so the skill's `PATHFINDER-<date>/` at repo root does
NOT apply here).

## Pass type

**Windowed, not repo-wide** (owner's call, 2026-08-18). Prior passes:
`docs/reviews/PATHFINDER-2026-08-10/`, `docs/reviews/PATHFINDER-2026-08-15/`.

## The entropy window

Every merge to `main` after `03db8633` (the 2026-08-15 pass's own landing
commit). The arch log counts 8 product merges; the real change surface is
wider because the counter is structurally blind to design-system and
CI/tooling merges.

**Solicitation send lane (the dominant theme):**
- `ad185edb` #853 / issue #657 — Messaging adapter seam + EmailAdapter +
  solicitation Sending identity + tag-discriminated Resend lane
- `fd0b48f3` #857 / #651 — dedicated `sqlUnsubscribe` admission-gated pool
- `71b1bd88` #863 / #629 — owner approval lane (approveBatch, per-ask
  exclusion, haltBatch, migration 108)
- `0101522a` #866 / #652 — `redeemUnsubscribeToken` owns its plain transaction
- `649c43b5` #870 / #859 — `ci:tenant-scope` reads query blocks
- `d9ea8801` #868 / #858 — `closeBatchIfSettled` canonicalises its batch id
- `0f81b9e7` #873 / #860 — per-ask Ask regeneration (ADR 0020)
- `9136d778` #876 / #865 — admin Halt latch surface (`latchHalt`)
- `fe21d02d` #882 / #665+#662 — purge-verifier columns; suppressions receipt
- `094d71b9` #883 / #872 — Ask withdrawal (migration 109, `withdrawAsk`)

**Design system (4 PRs, uncounted by the product counter):**
- `c56ccfef` #843, `6741543d` #844, `7386e389` #846, `d75ceb1b` #845 —
  three-tier design system, one token owner per surface

**CI / tooling / doc surface (uncounted):**
- `b76de4b1` #847 + `41ac511c` #848 — directory-map backfill + `ci:directory-map`
- `53f480a6` #849 + `caef011b` #854 — runner routing
- `a6e38fe9` #850 — CLAUDE.md trim + shape guard
- `5b99e7cd` #875 / #867 — dynamic-segment spelling in `allowed_edit_surface`

## Seeds — items the arch log itself flagged for THIS pass

Treat each as a hypothesis to confirm or refute with `file:line` evidence.
Do NOT restate the log; verify against source.

1. `src/lib/solicitation/approval.ts` (1,178 lines) now holds FIVE public verbs
   plus the private `latchHalt`. Does the halt lane want its own module?
2. `delivery_status IN ('rendered','queued')` is spelled in TWO places
   (`withdrawAsk` vs `latchHalt`). A third caller makes it a seam question.
3. `ApprovalPanel.tsx` crossed 1,000 lines (1,109). Its `── The write ──`
   section (~415 lines, four lane writes) is the named extraction candidate.
   The log says this is "now unblocked and is the first follow-up to file".
4. The `useReducer` admin-form shape is duplicated across FIVE admin surfaces
   (tracked as #880).
5. `RequestsClient.tsx` sits at cognitive complexity 15 — exactly on fallow's
   threshold. The next hook or JSX conditional there fails CI.
6. `LaneRefresh`'s naming altitude — `replace`/`in_place` name the parent's
   render mechanism; the tell is that `Exclude<LaneRefresh,'none'>` must exist.
7. `scripts/ci/tenant-scope-audit.ts` is 2,076 lines: a SQL lexer + query-block
   analyzer + JS template lexer in ONE file. Does it want `scripts/ci/lib/`?
8. 66 tenant-scope allowlist entries are now statically provable but retained.
9. **Treat as a class, not an incident:** `ci:tenant-scope` forms no opinion on
   any table outside `TENANT_TABLES`, and nothing at a call site distinguishes
   "reviewed and exempt" from "never in scope". A green audit is not a review
   of a cross-tenant join.
10. `purge-verification.ts`'s 27-column `OR` chain now carries two predicates
    that are NOT residue checks (`tone`, `archived_at`). A third exception kind
    is the signal it wants a declarative column→expectation table.
11. `batch-view.ts` (1,021 lines) carries TWO read models over one table with
    deliberately divergent ordering (`readLatestBatch` vs `readAdminBatchSummary`).
    Two defects already came from that divergence being implicit.
12. Workflow-infrastructure defects found by shipping, not by tooling:
    #877 (`verify-gate.sh` racing db-provision, self-concealing on retry) and
    #878 (staging deploy target drift).

## Reporting contract (MANDATORY — reports without this are rejected)

1. **Sources consulted** — exact file paths and line ranges actually read.
2. **Concrete findings** — exact function names, call sites, data flow.
3. **Mermaid diagram(s)** with every node labeled `Name<br/>file:line`.
4. **Confidence note + known gaps.**

Evidence over intuition. Draw from source, never from memory or from these
docs. `docs/directory.md` is a complete code map for `worker/` and `src/lib/` —
use it as an INDEX to find files fast, then read the files.

## Standing rules from CLAUDE.md that constrain any proposal

- Specialization is not duplication. Two components serving different trust
  models or data sources are legitimate even when the code looks alike.
- No abstraction before the second use; prefer deletion over abstraction.
- Vercel = UI only; all LLM/external/long-running work is on the Railway worker.
- Domain modules take `sql`/`supabaseServer` as an explicit parameter; only
  composition roots import the singleton.
- Pre-launch codebase: no backwards-compatibility shims without a named
  external consumer.
