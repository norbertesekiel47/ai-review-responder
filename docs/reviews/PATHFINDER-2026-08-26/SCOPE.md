# Pathfinder 2026-08-26 — scope brief

Read this before any subagent work. Artifacts live in
`docs/reviews/PATHFINDER-2026-08-26/` (repo convention — CLAUDE.md forbids new
top-level directories, so the skill's `PATHFINDER-<date>/` at repo root does
NOT apply here).

## Pass type

**Windowed, not repo-wide.** This follows the convention set by the five prior
passes: `PATHFINDER-2026-08-10/`, `-08-15/`, `-08-18/`, `-08-22/`, `-08-24/`.

The entropy counter in `.claude/reference/arch-review-log.md` reads **8**
against a threshold of 5. This pass is overdue and resets it.

## The entropy window

Every merge to `main` after `72dc58ac` (the 2026-08-24 pass's own artifacts
commit, PR #952), through `1d9b251c` (HEAD, 2026-08-26).

**21 first-parent merges. 12 count** by the arch log's rule (changes
non-test production code under `src/`, `worker/`, `supabase/`).

### Counted merges (12)

| SHA | PR | src | worker | supa | Subject |
|---|---|---|---|---|---|
| `ade1e6cc` | #975 | 0 | 3 | 0 | fix(967) post-purge bounce writes the global opt-out |
| `145c3329` | #976 | 30 | 0 | 0 | feat(marketing) spacing, motion, copy — three Daylight pages |
| `b9e7f36b` | #964 | 9 | 1 | 0 | fix(963,966) ask-lint provenance + List-Unsubscribe one-click |
| `62cc98df` | #972 | 3 | 2 | 0 | refactor(892) one owner for the purge tombstone sentinels |
| `13a11e4d` | #970 | 5 | 4 | 0 | fix(895) five truth-and-tripwire fixes |
| `a5f7c009` | #969 | 3 | 0 | 0 | docs(887) cite #629 round-2 F10, not ADR 0012 |
| `a9d3309d` | #968 | 15 | 0 | 0 | feat(landing) phone card rails for sections 2–5 |
| `ef9e9ac5` | #959 | 21 | 0 | 0 | feat(landing) sections revamp — staged cinema, living fleet |
| `388d0297` | #962 | 8 | 3 | 0 | fix(894) close the `ci:tenant-scope` blind spot |
| `2019f01b` | #954 | 20 | 5 | 1 | feat(632) review_attributed shadow attribution — **migration 114** |
| `63be96a1` | #955 | 2 | 0 | 0 | fix(landing) gate flip-card hover by pointer capability |
| `5d680643` | #953 | 16 | 0 | 0 | feat(landing) elevation pass — problem + tiers, arrival choreography |

### Excluded (9) and why

Docs- or tooling-only; zero non-test files under the three production roots.
Each still leaves a row in the arch log under `ci:merge-ledger`, which is
correct — that audit exists so a surface-rewriting merge leaves a trace even
when it does not increment.

`1d9b251c` #979, `75e62e31` #978, `4f472b8e` #977, `4d4997ff` #974,
`ee9aeb5a` #973, `6aba0c12` #956 (docs/evidence) · `ceaea650` #961
(`ci:env-registry`), `85fd1ad8` #957 (blast-radius AST), `06a8d15f` #960
(test-DB provisioning lock) — all under `scripts/` or test infrastructure.

> **Borderline, called IN:** `a5f7c009` #969 is titled `docs(887)` but changes
> 3 files under `src/`. The rule is about the files, not the title. Counted.

---

## HEADLINE FINDING — the counter is wrong for the sixth consecutive pass

The log says **8**. The window measures **12**.

This is not the old defect. The log itself named the new mechanism on
2026-08-26: `ci:merge-ledger` accepts a line in **either** the bullet list
**or** the bottom table, so a merge that writes only a table row passes the
audit while the bullet count drifts. The log corrected 5 → 8 by counting
bullets. **Counting the window independently gives 12.**

**Six passes, six wrong counters.** 08-10 (3 missed), 08-15 (#803 invisible),
08-18 (read 8, measured 11), 08-22 (four missing), 08-24 (**correct** — the
only one), 08-26 (reads 8, measures 12).

The 08-24 pass recorded the counter as *"correct for the first time in five
passes"* and credited `ci:merge-ledger`. **That conclusion did not survive one
window.** The audit checks that *a* line exists; it never checks *which list*.
This pass must decide the single owner — bullet list or table — and say so.

---

## Themes

### Theme A — Landing and marketing surface wave (84 src files, FIVE merges)

`5d680643` #953 · `63be96a1` #955 · `ef9e9ac5` #959 · `a9d3309d` #968 ·
`145c3329` #976

**The dominant theme by a wide margin** — 84 of the window's src changes.
Five merges rewriting the same public surface in three days: staged cinema and
arrival choreography, pointer-capability gating on flip cards, a shared
carousel for sections 2–5, then a spacing/motion/copy pass over How It Works,
Features and Pricing.

This is the first pass where the **marketing surface**, not the pipeline, is
the largest changed area. Prior passes never covered it in depth. Treat it as
new territory, not a known subsystem.

> **PATH CORRECTION — this brief was wrong on first write.** There is no
> `src/components/landing/`. The surface is **`src/components/sections/landing/`**
> (38 files, 8,240 lines), alongside `sections/features/`, `sections/how-it-works/`
> and the stylesheets in `src/app/(public)/_styles/`. Any grep keyed to the old
> path returns nothing **silently**. Corrected by the health-baseline agent.

The arch log already records two **load-bearing CSS import-order dependencies**
here (`agent-flip-card.css`, `carousel.css` must stay last) and says plainly
that **neither is mechanically guarded**. Two unguarded order dependencies in
one subsystem is an architecture question, not a styling detail.

### Theme B — Prior-pass handoff closure (THREE merges)

`388d0297` #962 / #894 · `13a11e4d` #970 / #895 · `62cc98df` #972 / #892

All three of the 08-18 pass's long-lived carry-forwards landed in this window,
after surviving two prior windows untouched. The 08-24 pass proposed closing
them as won't-fix if they survived a third. **They were actioned instead.**
Verify each is genuinely fixed, not merely closed.

### Theme C — Solicitation attribution and suppression (THREE merges)

`2019f01b` #954 / #632 — `review_attributed` shadow attribution, **migration
114**, matcher, worker, owner surface (25 production files) ·
`b9e7f36b` #964 / #963,#966 — ask-lint provenance allowlist, prompt style rule,
List-Unsubscribe one-click endpoint · `ade1e6cc` #975 / #967 — post-purge
bounce writes the global opt-out.

### Theme D — Excluded but relevant: CI audit hardening

`ceaea650` #961 (`ci:env-registry`), `85fd1ad8` #957 (AST importers),
`06a8d15f` #960 (test-DB lock). These do not increment the counter but they
change what CI can see. A pass that ignores them will mis-state which findings
are mechanically guarded.

---

## Standing obligations this pass inherits

### The 2026-08-24 pass left THREE next-session PRs. **None appear landed.**

Measured at HEAD, not inferred from titles:

- **H1 — bounced-owner email skip.** `rg 'owner_email_bounced'` returns
  **nothing** in `src/lib/notifications/resolve-channels.ts` or
  `worker/jobs/auto-post-notice/context.ts`. The BUG 1 defect is live: hard
  bounces on the highest-volume notice in the family, with the five private
  copies still duplicated.
- **H2 — one claim contract for the notice family.**
  `claimAutoPostNoticeDelivery` and `claimEscalationNoticeDelivery` remain at
  `delivery.ts:84` and `:113` — unchanged line numbers. The immortal-pending-row
  path that silently loses a Guardian escalation notice is unverified as fixed.
- **H3 — name the autonomy control surface (docs-only).** Marked
  *"MUST LAND BEFORE #633 FLIPS ANYTHING."* **#633 flipped send-mode on staging
  inside this window** (`ee9aeb5a` #973, `4d4997ff` #974, and `1d9b251c` #979
  declares "DESTINATION REACHED — send-mode live on staging").

> **The H3 ordering constraint was violated.** A doc gate written to precede a
> flag flip was skipped, and the flip shipped. Confirm against source and the
> flag registry, then report it plainly. This is the same failure class as
> "known follow-up #3a" from the 08-24 pass — a requirement recorded only in
> prose, with nothing that can block on it.

### No sequencing hazard this pass

`gh pr list` shows two open PRs — #927 (dependabot) and #646 (suppression
glossary). **Neither touches `.claude/reference/arch-review-log.md`.** Unlike
the 08-24 pass, this pass's artifacts PR can reset the counter without waiting.

---

## Seeds — hypotheses to confirm or refute with `file:line` evidence

Do NOT trust these. Each is a claim from the arch log, prior passes, session
memory, or the orchestrator's own measurement. Verify against source; **refuting
a seed is a result.** The 08-24 pass got four of six wrong, and recorded that as
the system working.

1. **The entropy counter has a two-owner defect, not a discipline defect.**
   The bullet list and the bottom table are both accepted by `ci:merge-ledger`.
   Measure both independently against the window. Propose ONE owner. A sixth
   consecutive "the humans forgot" finding is not a finding.

2. **The landing/marketing surface has grown a subsystem without a review.**
   Five merges, 84 files, three days, two unguarded CSS import-order
   dependencies. **MEASURED — the size half is answered:** the marketing surface
   is 100 files / 17,141 lines, of which 46% is CSS; `src/components/sections/landing/`
   alone is 38 files / 8,240 lines in one flat tier of nine section folders plus
   nine shared top-level files. **The open half:** are the arrival choreography,
   the `Staged` gate, `reveal.tsx`, `ambient-motion.tsx`, the carousel and the
   flip card ONE motion system or six? Four of those six are shared top-level
   files that no section owns.

3. **The notice family is still six members with five private bounced-owner
   copies.** The 08-24 pass measured six members (not four — seed 1 that pass
   was wrong). H1 did not land. Re-measure the member count; a seventh member
   inside this window would change the recommendation from "extract" to
   "extract now".

4. **`ci:merge-ledger`'s success was declared one window early.** The 08-24
   process findings closed this as fixed. Determine what the audit actually
   guarantees versus what the 08-24 pass claimed it guarantees, and correct the
   record.

5. **Migration 114 lockstep.** #954 added it; `6aba0c12` #956 claims it is
   promoted to staging AND production. Verify against both databases, not
   against the commit message. CLAUDE.md carries a standing exception for 078
   only. A second undocumented drift is a serious finding.

6. **The solicitation attribution lane added a fourth writer to the suppression
   surface.** #954 (shadow attribution), #964 (List-Unsubscribe one-click) and
   #975 (post-purge global opt-out) all touch suppression or attribution within
   nine days. `CONTEXT.md` locks eight terms here. Check whether the new writers
   respect the locked precedence — attestation never overrides suppression,
   global wins a double match.

7. **The `/feature` workflow's own gates misfired twice in this window.** The
   arch log records the `reclassify` WARN firing at 211 vs 90 estimated lines on
   a change that had not sprawled (comment density defeats the proxy), and a
   one-line CSS import pulling an inherited 0%-coverage file into the fallow
   gate as a PR blocker. Two false blocks in one window is a process finding.

---

## Method notes for subagents

- Every diagram node and duplication claim cites `file:line`. A claim without
  one is rejected and the agent is redeployed.
- **A citation is not a verification.** The 08-24 pass published a wrong
  headline from a well-cited subagent report that asserted reachability without
  checking a guard 130 lines upstream. For any finding you will rank as a bug,
  answer **"is it reachable?"** explicitly and separately from **"is it
  wrong?"**. If you cannot show reachability, say the finding is latent.
- **Specialization is not duplication.** Two components serving different trust
  models or data sources are legitimate even when their code rhymes. The
  02-duplication-report files from 08-22 and 08-24 carry a **DO-NOT-UNIFY
  register** — read it before proposing any unification, and do not re-propose
  anything on it.
- Live-DB test conventions apply to any test you propose: name it
  `*.integration.test.ts`, execute no run-time DDL.
- Do not propose a new top-level directory, a `NEXT_PUBLIC_*` companion for a
  feature flag, or a third autonomy umbrella flag. All three are barred by
  CLAUDE.md or a prior pass.
