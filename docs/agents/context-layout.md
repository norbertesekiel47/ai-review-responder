# Agent context layout

How the files an agent reads are arranged, who owns which fact, how large each page may be, and which tools are part of the picture. The constraint behind all of it: every page a pointer lands on must fit in one read. Before the 2026-09-05 split, the reference files were 40k–140k tokens each, and an agent told to "read the matching file" read a slice and missed the entry it needed.

## The four layers

1. **Entry.** `.claude/CLAUDE.md` is loaded on every turn of every Claude Code session; `AGENTS.md` is the Codex entry and defers to it. It holds the invariants, dev commands, CI and environment rules, working rules, tech stack, the "Where things live" routing table, and only the gotchas that apply everywhere. Nothing area-specific lives here.
2. **Path-scoped rules.** `.claude/rules/<area>.md`, one file per area. The frontmatter `paths:` list names the globs the rule governs; the body is `## Read first` (pointers), `## Traps`, `## Rules`. Claude Code loads a rule automatically when it reads a file matching one of its globs. Codex does not load nested rule files from a root launch: run `pnpm agent:rules <path> [<path>…]` before editing — it prints the matching rule files one per line (`none` when nothing matches) — and read every file it lists.
3. **References.** Loaded on demand from the routing table or a rule's Read first:
   - Glossary: `CONTEXT-MAP.md` lists every context and the bold terms it owns; each context is one file under `docs/context/`.
   - Code map: `docs/directory.md` (the Pages table, then the architecture overview) and one page per folder group under `docs/directory/`.
   - Lab notes: `.claude/reference/lab-notes/README.md` (topic index and how-to-add) plus one topic page per subsystem, each with Summary, Canonical entries, and History pointers.
   - Single-subject inventories: `.claude/reference/migrations-log.md`, `.claude/reference/env-vars.md`, `.claude/reference/review-ingestion.md`.
   - State map: `docs/currents.md` — what is true now, newest at the top.
4. **History.** Read when reconstructing why, never as the current rule: `.claude/reference/lab-notes/history/` (dated entries, verbatim, by date range), `docs/progresstracking.md` (build log, newest at the bottom), `docs/progress-archive/` (older sections of both logs), `docs/reviews/` (per-branch review records), `docs/superpowers/` (specs and plans). Historical files are not rewritten when a fact moves; their citations resolve through the stubs below.

## Ownership

One owner per fact. When a fact moves, the old location gets a pointer, not a copy; the only sanctioned duplication is a heading line repeated in a stub. A rule quotes nothing from a reference page — it points. Two live copies drift, and the reader cannot tell which one is current.

Two stubs stay at the old paths for historical citations: `.claude/reference/lab-notes.md` (a citation `lab-notes "<heading>"` is resolved by searching `.claude/reference/lab-notes/` for the heading) and `CONTEXT.md` (a citation `CONTEXT.md → **Term**` is resolved by finding the term in `CONTEXT-MAP.md`). Nothing new is added to a stub.

## Size caps

Counted with `wc -w`.

| Set | Cap (words) |
|---|---|
| `.claude/reference/lab-notes/*.md` (topic pages + README) | 3,000 |
| `.claude/reference/lab-notes/history/*.md` | 15,000 |
| `docs/directory.md`, `docs/directory/*.md` | 3,000 |
| `CONTEXT-MAP.md` | 1,500 |
| `docs/context/*.md` | 3,000 |
| `docs/currents.md` | 12,000 |
| `docs/progresstracking.md` | 12,000 |
| `.claude/rules/*.md` | 800 |
| `docs/agents/context-layout.md` | 1,200 |

`src/__tests__/reference-shape.test.ts` enforces every row, and also the structure: each rule starts with `paths:` frontmatter, no term is defined in two context files, the map links every context file, the Pages table links every directory page, and the lab-notes README links every topic page and history file. `src/__tests__/claude-md-shape.test.ts` enforces CLAUDE.md (a routing row's Read cell ≤ 80 words, a gotcha ≤ 60, total ≤ 6,000). When a page goes over, the fix is one of three: split the page, archive the oldest sections, or move the WHY to the page the pointer already names.

## How to add

- **A trap** for one area → that area's `.claude/rules/<area>.md`, under `## Traps`. If no rule's `paths:` covers the file, add a rule with frontmatter naming the globs and keep it under 800 words; `ci:agent-config` checks that every glob matches a tracked file. A gotcha that applies everywhere goes in CLAUDE.md, symptom → rule → pointer, in ≤ 60 words.
- **A new term** → a `- **Term**: …` line in the `docs/context/<context>.md` that owns it, and the term's name added to that context's row in `CONTEXT-MAP.md`. A new context is a new file plus a map row. A term defined in two files fails the test.
- **A new production file** under `worker/` or `src/lib/` → a row on the `docs/directory/<page>.md` that inventories its folder (`ci:directory-map` fails without one). A new folder gets its row in the Pages table of `docs/directory.md`; a folder moved to a sibling page to stay under the cap is recorded there too.
- **A root cause** → a dated entry in the newest `.claude/reference/lab-notes/history/` file, format `[DATE] WHAT FAILED → WHY → CORRECT APPROACH`. If it changes a current rule, edit the topic page's Summary bullet or Canonical section — the history entry keeps the story, the topic page keeps the rule.
- **A shipped feature** → a Quick summary at the top of `docs/currents.md` and an entry at the bottom of `docs/progresstracking.md`, when the merge changed the state a reader relies on. A fix that only makes the code match what `currents.md` already says skips both; its row in `.claude/reference/arch-review-log.md` and its lab notes carry it (the `document-feature` skill owns the test). When either passes 12,000 words, move its oldest sections verbatim to a new `docs/progress-archive/` file and add that file to the header list.

## Tool policy

- claude-mem observations are episodic hints: what a past session concluded, not what the tree says now. Verify every recalled claim against the checkout before acting on it. If they conflict, the codebase wins — say so, and note the stale memory.
- No knowledge graph, vault, embedding index, or generated summary is part of this repo's context. The May 2026 `docs/graphify-out/` export (two converted business documents) was removed because nothing read it, and its `.gitignore` entries went with it.
- Add a tool only for a named, repeated failure to find something, and record the failure first: a dated lab-notes history entry stating what was looked for, where, and what was found instead. One failure is a missing pointer and is fixed by adding the pointer. The second occurrence of the same failure is the case for a tool, and that entry is where the evaluation goes.

## `docs/agents/domain.md`

`docs/agents/domain.md` is a skill-consumption guide: it tells the engineering skills how to read `CONTEXT.md` or `CONTEXT-MAP.md` and `docs/adr/` before exploring, and to use the glossary's vocabulary in their output. It defines no terms and is not a second glossary. It stays; this repo takes its `CONTEXT-MAP.md` branch.
