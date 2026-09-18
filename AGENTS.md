# RepWorth — Codex Context

**The authoritative project context is [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — read it first, then [`docs/agents/context-layout.md`](docs/agents/context-layout.md), the map of where context lives.**
Everything there applies to Codex verbatim: what the project is, dev commands,
CI & repo rules, environments/branches, the architecture invariants, working
rules, the path-scoped rules, the "Where things live" reference map, tech
stack, database notes, and the non-obvious gotchas. Do NOT rely on a summary
of it here — this file previously carried a hand-maintained copy and it drifted
badly (its gotcha allowlist was 17 sites stale when retired on 2026-08-03).

## Context layers

Context is layered so no page a pointer lands on is too large to read whole.
Read down the layers only as far as the task needs; the full layout, size caps,
ownership rule and "how to add" procedure are in
[`docs/agents/context-layout.md`](docs/agents/context-layout.md).

1. **Entry** — `.claude/CLAUDE.md` + this file. Always loaded.
2. **Path-scoped rules** — `.claude/rules/*.md`, one file per area; each
   file's `paths:` frontmatter names the globs it governs. Claude Code loads
   a rule automatically when it reads a matching file; Codex must ask for
   them (see the operating rule below).
3. **References** — read the one page the rule or the "Where things live" row
   points at: `CONTEXT-MAP.md` → `docs/context/` (domain glossary, one page
   per area); `docs/directory.md` → `docs/directory/` (code map, one page per
   folder group); `.claude/reference/` (migrations-log, env-vars,
   review-ingestion, and `lab-notes/README.md` → one topic page per
   subsystem). `.claude/reference/` is the single authoritative
   project-reference tree for both Codex and Claude Code.
4. **History** — `.claude/reference/lab-notes/history/`,
   `docs/progress-archive/`, `docs/progresstracking.md`, `docs/reviews/`,
   `docs/superpowers/`. Never load these for a live rule; they record how a
   rule came to be.

## Codex operating rules

- This project is developed on macOS. Use bash/zsh-compatible Unix commands.
- Run project commands from `/Users/norbertesekiel/Developer/startups/RepWorth`
  unless a more specific repo instruction says otherwise.
- Use `pnpm`.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Load relevant glossary entries on demand — look the term up in
  `CONTEXT-MAP.md`, read the one `docs/context/<page>.md` that owns it, and
  follow its linked domain references. Do not read the entire glossary for
  every feature.
- Codex does not auto-load `.claude/rules/`: nested instruction files load
  only along the root→cwd path, and a launch from the repo root loads none of
  them. Before editing, run `pnpm agent:rules <every path you will edit>` and
  read every file it lists (`none` means no rule applies). Path-scoped rules
  carry the area's traps that used to live in `.claude/CLAUDE.md`; skipping
  this step is how those traps get re-tripped. Layout:
  `docs/agents/context-layout.md`.
- Preserve existing user changes. Do not run destructive git commands unless
  explicitly requested.
- Before claiming behavior-affecting work is complete, run the narrowest
  relevant test plus `pnpm build`.
- For every feature or bug fix with browser-observable behavior, use Computer
  Use to exercise the affected user journey end to end before claiming it
  verified, including relevant error paths and desktop/mobile layouts. This
  applies to every `$feature` lane and supplements automated checks.
- Use a local app or staging with designated test accounts/data; confirm the
  running app contains the change. For worker/webhook flows, also verify the
  backend outcome. Follow `docs/runbooks/e2e-local-setup.md` for test setup.
- Report the browser target, steps, expected/observed results, and sanitized
  screenshot evidence. If Computer Use, login, or the required environment is
  unavailable, state the blocker; do not claim browser verification or silently
  substitute another tool. For changes with no browser journey, explain why
  browser testing does not apply and run the relevant integration checks.

## Codex-specific wiring

- RepWorth-owned workflows are versioned under `.agents/skills/`;
  `.claude/skills/` is the source when a skill is updated. Third-party media
  skills are intentionally not loaded from this coding repository. Three
  engineering skills are adapted from a third-party pack
  (`security-and-hardening`, `constraint-driven-development`,
  `doubt-driven-development`); provenance and licence are in
  `docs/agents/third-party-skills.md`.
- Codex feature guards are active under `.codex/hooks/` and registered in
  `.codex/hooks.json`. Their compatibility notes and trust procedure live in
  `.codex/HOOKS.md`. `pnpm ci:agent-config` validates the hooks, skill
  metadata, source/mirror parity, reference paths, and repository
  discoverability in local gates and CI.
- This file is hand-owned end to end. Next.js would otherwise upsert a managed
  `nextjs-agent-rules` block here on every `next dev` that detects a coding
  agent (its `<!-- BEGIN:… -->` marker is deliberately never written out
  anywhere in this file — Next matches it with a substring test, and a start
  marker without its end marker makes it append a second block rather than
  replace the first); that is off via `agentRules: false` in
  `next.config.mjs` (decided in #798). Its one useful instruction — read the
  version-matched Next docs bundled at `node_modules/next/dist/docs/` before
  writing Next code — now lives in `.claude/CLAUDE.md` → Working rules, which
  this file already tells you to read first. Do not re-add the block; if it
  reappears, the flag was dropped.
