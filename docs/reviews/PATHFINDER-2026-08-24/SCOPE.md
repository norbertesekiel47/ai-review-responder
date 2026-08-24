# Pathfinder 2026-08-24 — scope brief

Read this before any subagent work. Artifacts live in
`docs/reviews/PATHFINDER-2026-08-24/` (repo convention — CLAUDE.md forbids new
top-level directories, so the skill's `PATHFINDER-<date>/` at repo root does
NOT apply here).

## Pass type

**Windowed, not repo-wide.** This follows the convention set by the four prior
passes: `PATHFINDER-2026-08-10/`, `-08-15/`, `-08-18/`, `-08-22/`.

The entropy counter stands at **11** against a threshold of 5. This pass is
overdue and resets it.

## The entropy window

Every merge to `main` after `42a247b1` (the 2026-08-22 pass's own artifacts
commit, PR #936), through `0278366c` (HEAD, 2026-08-24 10:40 PDT).

**13 first-parent merges; 11 count** by the arch log's rule (changes production
code under `src/`, `worker/`, `supabase/`). **75 production files changed**
(103 including tests).

Excluded and why: `b6f41dcf` (#948, `/feature` skill — governance-only, zero
files under the three production roots) and `6b7afa92` (#942, seedContactCsvUpload
— test-only). Both leave rows in the arch log under `ci:merge-ledger`, which is
correct: that audit exists so a surface-rewriting merge leaves a trace even when
it does not increment.

### Theme A — Auto-approval lane for solicitation (48 files, ONE merge)

`0278366c` #950 / #631 — Autopilot solicitation batches approved by policy
behind flags, veto-windowed, release-rechecked. **Migration 113.**

**This is the dominant theme by a wide margin** — 48 of the window's 75
production files, 64%. It landed at 10:40 today, roughly two hours before this
pass. It is the newest and least-reviewed code in the repo.

It also adds the **fourth** member of the notice-family worker clone
(`worker/jobs/solicitation-veto-notice/`), joining escalation-notice,
pending-post-notice and auto-post-notice.

### Theme B — Admin surface consolidation wave (19 files, FOUR merges)

Four refactors of the same admin surfaces, all landed 2026-08-23 within 15
minutes of one another:

- `757bf639` #947 / #880 — `useAdminActionForm`, one owner for the five admin
  surfaces' submit reducer (7 files)
- `2a9ede74` #946 / #886 — extract `ApprovalPanel`'s lane-write seam into
  `lane-writes.ts` (3 files)
- `1e407fee` #945 / #909 — extract the admin gate→parse→400 preamble, widen
  `ci:admin-aal2` to see it (5 files)
- `efd2145d` #944 / #893 — bound the admin read fan-out, replace the four
  enumerated pins with the `ci:pool-fanout` rule (4 files)

Four consolidations of one surface in one sitting is itself a signal. This pass
must ask whether they converged on one shape or four different shapes.

### Theme C — Send-lane vocabulary and predicates (30 files, FOUR merges)

- `3d45dfab` #937 / #891 — `batchDidClose`, a positive predicate for "the close
  settled the batch" (9 files)
- `e2ee6895` #938 / #890 — three named owners for the send-lane delivery-status
  subsets (6 files)
- `626ff0ec` #939 / #913 — relocate the provider-agnostic error vocabulary to
  `shared` (9 files)
- `22fe659b` #940 / #914 — the Send handoff withholds a location with no
  canonical place id (6 files)

### Theme D — Small

- `7d174812` #941 / #908 — **migration 112**, the Breaker window read model is
  index-servable (2 files)
- `a7dd67ee` #943 / #910 — pull forward B3.1, B3.7, B3.10 from the #898
  follow-up backlog (6 files)

## Standing obligation this pass inherits

The 2026-08-22 pass left three next-session PRs. **All three appear to have
landed inside this window** — `1014aaa6` (#932, the three send-lane integrity
tests), `9929c3c7` (#933, canonicalBatchId), `e53302d6` + `2f386c52` (#934/#935,
the mutation sentinel and `ci:merge-ledger`).

The 2026-08-18 pass left seven handoffs (#890–#896). Four appear landed
(#890, #891, #893, #896). **Three have no merge in the window: #892 (H3 purge
sentinels), #894 (H5 tenant-scope blind spot), #895 (H6 truth-and-tripwire
bundle).**

**Obligation: verify each against current source, not against the merge title.**
A merge whose title claims a fix is not evidence the fix is present. Report any
issue closed without its fix, or fixed without its issue closing.

## Seeds — hypotheses to confirm or refute with `file:line` evidence

Do NOT trust these. Each is a claim from the arch log, prior passes, session
memory, or the orchestrator's own measurement. Verify against source; refuting a
seed is a result.

1. **The notice-family clone has reached four members and a decision is due.**
   `worker/jobs/{escalation-notice,pending-post-notice,auto-post-notice,solicitation-veto-notice}/`.
   Session memory records this as "extract-or-bless decision threshold". Either
   extract the shared shape or write down why four near-identical workers are
   legitimate specialization. Refusing to decide a fifth time is the failure
   mode.

2. **`src/lib/solicitation/` keeps growing.** It was 14,426 lines across 24
   files at the 08-22 pass. Theme A added to it. Re-measure. The 08-22 pass
   asked "is this one subsystem or several sharing a prefix?" and the answer
   may have changed.

3. **Four admin consolidations in one sitting may not agree with each other.**
   `useAdminActionForm`, `lane-writes.ts`, the gate→parse→400 preamble, and the
   fan-out rule all touch the admin surfaces. Do they compose, or does an admin
   route now cross four different seams to do one thing?

4. **`src/lib/auto-approval/` (5 files) and `src/lib/solicitation/` (13 files)
   both changed in #950.** The auto-approval lane already existed for the Reply
   persona. Theme A extended it to Solicitation. Is there now one auto-approval
   runtime or two? Invariant #3 names a single "server-only auto-approval
   runtime" — verify that is still true.

5. **`settings-guards.ts` was created during #950 to break a module cycle**
   between the Reply and Solicitation lanes (session memory). A cycle that
   needed breaking under deadline pressure often means the boundary is wrong,
   not just the imports. Check whether the cycle is genuinely gone or merely
   indirected.

6. **Migration 112 and 113 both landed in this window.** Confirm both are
   applied to staging AND production in lockstep. CLAUDE.md carries a standing
   exception for 078 only. A second undocumented drift would be a serious
   finding.

## Method notes for subagents

- Every diagram node and duplication claim cites `file:line`. A claim without
  one is rejected and the agent is redeployed.
- **Specialization is not duplication.** Two components serving different trust
  models or data sources are legitimate even when their code rhymes. The
  02-duplication-report from 08-22 carries a DO-NOT-UNIFY register — read it
  before proposing any unification, and do not re-propose anything on it.
- Live-DB test conventions apply to any test you propose: name it
  `*.integration.test.ts`, execute no run-time DDL.
