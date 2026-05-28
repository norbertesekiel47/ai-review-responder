# `.claude/` Folder Re-architecture — Design

**Date:** 2026-05-27
**Status:** Approved (brainstorming) → pending implementation plan
**Scope:** The `.claude/` configuration tree only. No application code changes.

## Problem

The `.claude/` folder (14 files, ~3,355 lines) has drifted from the codebase and
from internal consistency. Because `CLAUDE.md` and `rules/*.md` are auto-loaded
into every Claude Code session, this directly degrades output quality: stale facts
become confident wrong guidance, contradictions force guesswork, and oversized
"skill" files waste context budget without proportional value.

Concrete defects found in the audit:

- **Leaked credential.** `skills/firecrawl.md` contains a live API key
  (`FIRECRAWL_API_KEY=fc-88325f91…`) in a tracked file.
- **Stack contradiction.** `CLAUDE.md` says Next.js 14; `rules/repworth.md` says
  Next.js 16. They disagree on the "source of truth."
- **Pricing contradiction.** `skills/cost-guard.md` lists tiers "founding $99 /
  standard $149 / premium $199"; `skills/feature-flags.md` lists "basic $29 /
  standard $79 / premium $199 / founders $19" — different names *and* numbers.
- **Mis-classified reference dumps.** `lab-notes.md` (1,109 ln), `migrations.md`
  (517 ln), `feature-flags.md` (391 ln), and `review-dedup.md` (356 ln) are
  declared skills but are recall-when-needed information, not procedures. Their
  "read before touching X" descriptions trigger frequently and dump large bodies.
- **Duplication that drives drift.** `CLAUDE.md` and `rules/repworth.md` restate
  the same architecture invariants, stack contract, and do/don't rules in
  different words — the mechanism by which the Next 14-vs-16 split happened.
- **Provenance bloat.** `CLAUDE.md` invariants are wrapped in PR-# / Wave-# /
  migration-# narrative that ages out and obscures the actual rule.
- **Stale platform artifacts.** `CLAUDE.md` "Codex Review Bridge — always run in
  WSL2" and `settings.local.json` `rtk`/PowerShell/`C:\…` entries are leftovers
  from a Windows machine; this is now macOS.
- **Missing metadata.** `approval-security.md`, `cost-guard.md`,
  `outbox-pattern.md`, `onboarding-demo-cost-guard.md` lack YAML frontmatter.
- **Duplicated disclaimer.** The "Worker file paths (as of 2026-05-05)" block is
  copy-pasted into four files.
- **Stale lock.** `scheduled_tasks.lock` (May 11) is tracked.

## Goals

1. Each fact stated **once**, in exactly one file.
2. Always-loaded context (`CLAUDE.md` + `rules/`) carries only what's needed
   inline; everything else loads on demand.
3. A clear, durable taxonomy so future additions have an obvious home.
4. Every retained factual claim verified against the live codebase.

Non-goals: changing application code, changing the 3 generic OBEY rule files,
re-litigating architecture decisions.

## Taxonomy (the organizing principle)

Four layers, each with one job and one loading behavior:

| Layer | Location | Loads | Holds |
|---|---|---|---|
| **Orientation + facts** | `CLAUDE.md` | always (auto) | what the project is, dev commands, stack facts, the canonical invariant list, gotchas, tool selection, MCP, and a "where things live" reference index |
| **Law** | `rules/*.md` | always (auto) | behavioral rules; references invariants, never restates them |
| **Procedures** | `skills/*.md` | on invoke | thin, single-purpose "when you do X, follow this" patterns |
| **Inventories** | `reference/*.md` | on explicit read | recall-when-needed detail; not auto-loaded |

Decision rule for placement:
- A **rule** (must always hold) → `CLAUDE.md` invariants or `rules/repworth.md`.
- A **pattern you follow while performing a task** → `skills/`.
- **Facts you look up** → `reference/`.

## Target structure

```
.claude/
├── CLAUDE.md              # ~130 ln: facts + invariants + "Where things live" index
├── rules/
│   ├── repworth.md        # deduped: law only, references invariants
│   ├── engineering.md  ┐
│   ├── production.md   ├── UNTOUCHED
│   └── design.md       ┘
├── skills/               # ONLY patterns-you-follow; all have frontmatter
│   ├── outbox-pattern.md
│   ├── approval-security.md
│   ├── cost-guard.md            # + strip stale pricing
│   └── onboarding-demo-cost-guard.md
├── reference/            # NEW — recall-when-needed, load-on-demand, tracked
│   ├── migrations-log.md        # ← skills/migrations.md (full content)
│   ├── env-vars.md              # ← skills/feature-flags.md (full content)
│   ├── lab-notes.md             # ← skills/lab-notes.md, re-indexed by topic
│   └── review-ingestion.md      # ← skills/review-dedup.md (full content)
└── settings.local.json   # pruned of dead Windows/rtk commands
```

## Per-file disposition

| File | Action | Notes |
|---|---|---|
| `CLAUDE.md` | Rewrite | ~267 → ~130 ln. Facts + invariants only; drop PR/Wave narrative; add reference index; fix Next 14→16; verify all claims. |
| `rules/repworth.md` | Dedupe | Remove restated invariants/stack; keep behavioral law (do/don't, modification posture, reliability rules); reference CLAUDE.md invariants. |
| `rules/engineering.md` | Keep | Untouched. |
| `rules/production.md` | Keep | Untouched. |
| `rules/design.md` | Keep | Untouched. |
| `skills/outbox-pattern.md` | Keep | 32 ln, exemplary. Verify claims. |
| `skills/approval-security.md` | Edit | Add frontmatter. Verify claims (TTL, rate limits, page flow). |
| `skills/cost-guard.md` | Edit | Add frontmatter. **Strip stale tier pricing**; point pricing to `tier-config.ts`. Keep reserve/finalize/Redis mechanism. |
| `skills/onboarding-demo-cost-guard.md` | Edit | Add frontmatter. Verify helper names/paths. |
| `skills/migrations.md` | **Move → `reference/migrations-log.md`** | Full content; re-verify head + per-migration claims. |
| `skills/feature-flags.md` | **Move → `reference/env-vars.md`** | Full content; verify var names vs `startup-assert.ts`; correct tier table vs `tier-config.ts`. |
| `skills/lab-notes.md` | **Move → `reference/lab-notes.md`** | Re-index by topic (currently date-only). Fix the stale `/docs/*` gitignore note. |
| `skills/review-dedup.md` | **Move → `reference/review-ingestion.md`** | Full content; verify paths/symbols. |
| `skills/firecrawl.md` | **Delete** | Not RepWorth-specific + leaked key. |
| `scheduled_tasks.lock` | **Delete + gitignore** | Stale tracked lock. |
| `settings.local.json` | Prune | Remove `rtk *`, PowerShell, `C:\…` entries; keep macOS-valid permissions. |

## CLAUDE.md section plan

Retained, rewritten to state rules once and drop provenance:

1. **What this project is** — Next.js **16** (verified vs `package.json`).
2. **Dev commands** — verified vs `package.json` scripts.
3. **Architecture invariants** — the canonical NEVER-violate list; its only home.
   Each invariant distilled to its rule (e.g. the 12-line billing-snapshot block
   → one line). Add the lifted "feature flags are server-authoritative, no
   `NEXT_PUBLIC` companion" rule here.
4. **Tech stack (non-obvious choices)** — dual Postgres clients, dual Redis,
   pinned LLM IDs, JSONB helper, pnpm. Strip Wave-2/3 analytics+logging narrative
   to the rule.
5. **Worker layout** — short; point to `docs/directory.md`.
6. **Database** — facts only (UUIDv7, verified current head, dual-client); point
   to `reference/migrations-log.md`.
7. **Non-obvious gotchas** — keep; verify each.
8. **Codebase intelligence** (tool selection) + **MCP servers** — keep.
9. **Where things live** (NEW) — reference index with trigger conditions:
   - before writing a migration → `reference/migrations-log.md`
   - before adding an env var / flipping a flag → `reference/env-vars.md`
   - before touching review ingestion / adding a ReviewSource → `reference/review-ingestion.md`
   - before touching named libraries/subsystems → `reference/lab-notes.md`
   - file-by-file map → `docs/directory.md`; layout reasoning → `docs/currents.md`

**PR/Wave provenance is dropped** to git history (and existing ADRs), not
preserved in `reference/`.

## Verification sweep (full)

Before finalizing each file, verify its claims against the codebase and fix drift:

- Framework/dependency versions → `package.json`.
- Tier names + pricing → `src/lib/accounts/tier-config.ts`.
- Migration head + per-migration claims → `supabase/migrations/`.
- Env-var + flag names → `worker/config/startup-assert.ts` and usage sites.
- Referenced file paths exist; function/symbol names → codebase-memory graph
  (`search_graph` / `get_code_snippet`) and targeted reads.
- Skill cross-references resolve to real files post-move.

Every correction is logged in the implementation plan / PR description so the
drift that was fixed is visible. (Example already found: the lab-note claiming
`/docs/*` is gitignored is stale — `docs/` is tracked by default now.)

## Consolidation

The "Worker file paths (as of 2026-05-05)" disclaimer (duplicated in 4 files) is
stated once in `docs/directory.md`; the inline copies are removed and replaced
with a one-line pointer where still useful.

## Safety / rollout

- All changes land on a branch via PR (per the "never push to `main`" rule;
  `main` is protected by the ruleset). The 4 CI checks must pass.
- No file is deleted without its prior contents shown to the user first.
- **Out-of-band action required of the user:** rotate the leaked Firecrawl key at
  firecrawl.dev. Deleting the file does not purge it from git history, so the key
  must be treated as compromised regardless of this refactor.
- Moves preserve content verbatim except for verification corrections and the
  lab-notes topic re-index; corrections are called out explicitly.

## Out of scope

- Application/source code, migrations, tests.
- The 3 generic OBEY rule files (`engineering.md`, `production.md`, `design.md`).
- Re-deriving architecture decisions (only their documentation is touched).
- Purging the leaked key from git history (flagged to user; separate operation).
