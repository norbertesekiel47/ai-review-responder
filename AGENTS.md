# RepWorth — Codex Context

**The authoritative project context is [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — read it first.**
Everything there applies to Codex verbatim: what the project is, dev commands,
CI & repo rules, environments/branches, the architecture invariants, working
rules, the "Where things live" reference map, tech stack, worker layout,
database notes, and the non-obvious gotchas. Do NOT rely on a summary of it
here — this file previously carried a hand-maintained copy and it drifted
badly (its gotcha allowlist was 17 sites stale when retired on 2026-08-03).

Detailed inventories load on demand via that file's "Where things live" table:
`.claude/reference/` (migrations-log, env-vars, lab-notes, review-ingestion)
is the single authoritative project-reference tree for both Codex and Claude
Code.

## Codex operating rules

- This project is developed on macOS. Use bash/zsh-compatible Unix commands.
- Run project commands from `/Users/norbertesekiel/Developer/startups/RepWorth`
  unless a more specific repo instruction says otherwise.
- Use `pnpm`.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Preserve existing user changes. Do not run destructive git commands unless
  explicitly requested.
- Before claiming behavior-affecting work is complete, run the narrowest
  relevant test plus `pnpm build`.

## Codex-specific wiring

- RepWorth-owned workflows are versioned under `.agents/skills/`;
  `.claude/skills/` is the source when a skill is updated. Third-party media
  skills are intentionally not loaded from this coding repository.
- Codex feature guards are active under `.codex/hooks/` and registered in
  `.codex/hooks.json`. Their compatibility notes and trust procedure live in
  `.codex/HOOKS.md`. `pnpm ci:agent-config` validates the hooks, skill
  metadata, reference paths, and repository discoverability in local gates
  and CI.
