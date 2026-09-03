# Deviations — feat/1092-nav-sidebar-children

## D1 — no self-child under Requests (T2)

**Planned.** Three sidebar children under Requests: `Requests`, `Contacts`,
`Review QR`. The intake's `tests_to_add` said so.

**What happened.** Adding a child labelled `Requests` under a parent row also
labelled `Requests` broke two PRE-EXISTING Sidebar tests. They were not brittle:
`getByRole('link', { name: /requests/i })` became ambiguous because there really
were two links with the same accessible name pointing at the same href. A screen
reader would read the same thing twice.

**Why the plan was wrong.** Reviews and Analytics each carry a self-child
because their first screen has its own name — `Needs Action`, `Metrics`. The
Requests screen is titled `Requests` (`RequestsClient.tsx:209`), so there is no
second name to give it. The parent row already IS that route.

**Adaptation.** The rule is now statable: a section gets a self-child only when
its first screen has a name distinct from the section. Requests gets `Contacts`
and `Review QR` only. Reachability is unchanged — the parent row is a link.

**Cost.** One `tests_to_add` retitle, applied to BOTH intake copies because the
gate's `promised-tests` row matches titles verbatim. Not a surface amendment:
`allowed_edit_surface` did not move, so the amendment counter is untouched
(feature.md step 5 — retitles are deviations entries).

**Verdict:** ACCEPT.

## D2 — implemented in-session rather than by subagent (T1–T5)

**Planned.** feature.md step 4 dispatches fresh per-task subagents.

**What happened.** Implemented in this session.

**Why.** The five tracers are one coherent navigation change across three
components and one CSS block, and this session already holds the #1089 decision,
the thirteen call sites and the breakpoint reasoning. A subagent would re-derive
all of it per task. The first-task enforcement spot check still ran: the T1
commit's paths were diffed against `allowed_edit_surface`.

**Verdict:** ACCEPT.

## D3 — the edit-surface guard does not bind in this session

**Planned.** `feature-setup.sh` arms a PreToolUse guard that refuses an edit
outside `allowed_edit_surface`. Step 4's first-task spot check exists to prove
it binds.

**What happened.** The spot check FAILED to find enforcement. Three new test
files landed outside the declared surface and nothing stopped them.

**Root cause — not a misconfiguration.** `.claude/hooks/edit-surface-guard.sh`
is a PreToolUse hook on `Edit`/`Write`/`MultiEdit`, and its own header names the
gap:

> Known gap (inherent to PreToolUse): file changes made through Bash … routing
> repo edits through Bash during a feature run.

This session runs in an output mode that instructs file changes through Bash, so
every edit bypasses the guard by construction. `arm-check.sh` reports ARMED and
is correct — the hook IS registered. It simply cannot see Bash writes.

**Adaptation.** The surface is enforced by HAND for the rest of this run: every
commit's `--name-only` output is diffed against `allowed_edit_surface` before
the commit is made. That is weaker than the hook (it is my discipline, not a
refusal) and is stated here so a reviewer does not mistake ARMED for enforced.

**Amendment.** Three test paths added to `allowed_edit_surface` in both intake
copies. Amendment #1; two are inside trees the surface already covered, the
third (`_styles/__tests__/`) is a new tree, so it is recorded rather than
auto-approved.

**Verdict:** ACCEPT the adaptation. **The underlying gap is worth raising with
the owner** — an armed run in this mode has no mechanical surface enforcement.
