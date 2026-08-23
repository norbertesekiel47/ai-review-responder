# Pathfinder 2026-08-22 — scope brief

Read this before any subagent work. Artifacts live in
`docs/reviews/PATHFINDER-2026-08-22/` (repo convention — CLAUDE.md forbids new
top-level directories, so the skill's `PATHFINDER-<date>/` at repo root does
NOT apply here).

## Pass type

**Windowed, not repo-wide** (owner's call, 2026-08-22). Prior passes:
`docs/reviews/PATHFINDER-2026-08-10/`, `PATHFINDER-2026-08-15/`,
`PATHFINDER-2026-08-18/`.

## The entropy window

Every merge to `main` after `54e4d374` (the 2026-08-18 pass's own landing
commit), through `74aee92a`. **17 first-parent merges; 7 count** by the arch
log's own rule (changes production code under `src/`, `worker/`, `supabase/`).
**77 production files changed.**

### Theme A — Solicitation send lane (the dominant theme, ~26 files)

The lane became end-to-end in this window: batch → approval → dispatch →
provider send → release sweep → terminal.

- `f6a83bc3` #901 — gate the Attested postal-address surface on watch-mode
- `b873a9a5` #904 / #898 — send governors: caps, reputation breaker, bounce
  discrimination. **Migration 110.** New table `solicitation_send_breaker`
  (first platform-scoped table with no `account_id`).
- `2204e6a6` #912 / #899 — send worker: Dispatch gate, token mint, provider
  send, terminal transaction. `applyDispatchGate`, `classifySendFailure`,
  `lintInputFromSnapshot`. First production caller of `getMessagingAdapter()`.
- `a321634a` #920 / #900 — `SolicitationReleasePoller`: three sweeps, governor
  order, backstop join. `runReleaseCycle`, `latchSystemHalt`, `sweepSystemHalt`,
  `capacityStop`. New env var `SOLICITATION_RELEASE_POLL_INTERVAL_MS`.
- `2c7bb615` #926 / #917 — `platform_halt`, the third **Halt latch** reason.
  **Migration 111.** `resolveWindowHaltReason`. Introduces the FIRST sanctioned
  `try/catch` around `readSendBreaker`, whose docstring forbids exactly that.
- `1a8443ce` #925 / #923 — §7.1 refusal recorded as **ADR 0022** + a docstring.

### Theme B — Daylight Gallery II marketing rebrand (~50 files, ONE merge)

- `9e60617c` #905 — `/how-it-works`, `/features`, `/pricing` + chrome.
  43 production files, **+3,246 / −3,295**. The largest single merge in the
  window, and **it left no row in the arch log at all**. The 2026-08-18 pass's
  headline finding was that the counter is structurally blind to exactly this
  class of merge; #905 is that finding recurring, not a new one.

### Theme C — Small

- `scripts/ci/tenant-scope-allowlist.ts` — 4 platform-wide predicates added
  under a standing sign-off (#920).
- `src/app/api/settings/postal-address/route.ts` — watch-mode gate (#901).

## Standing obligation this pass inherits

**All seven handoffs from the 2026-08-18 pass are OPEN and unexecuted:**
#890 (H1 cancellable set), #891 (H2 close-settled predicate), #892 (H3 purge
sentinels), #893 (H4 admin read fan-out), #894 (H5 tenant-scope blind spot),
#895 (H6 truth-and-tripwire bundle), #896 (H7 `ci:merge-ledger`).

**Owner's instruction (2026-08-22): re-verify each against current source and
merge the survivors into ONE ranked backlog with this pass's findings.** Some
may have drifted, worsened, or been overtaken by #904/#912/#920. A finding that
the window made WORSE ranks above a new finding of equal size — say so.

Do not restate the old handoff text. Re-derive from source.

## Seeds — hypotheses to confirm or refute with `file:line` evidence

Do NOT trust these. Each is a claim from the arch log, the prior pass, or the
orchestrator's own measurement. Verify against source; refuting a seed is a
result.

### Size and shape

1. `src/lib/solicitation/` is now **14,426 lines across 24 files**. Four files
   are over 1,000 lines: `dispatch.ts` (2,001), `release.ts` (1,885),
   `ask-generation.ts` (1,699), `approval.ts` (1,352), plus `batch-view.ts`
   (1,030). Is this one subsystem or several that share a prefix?
2. `release.ts` shipped at 1,739 lines with **a single export** and the
   standards reviewer explicitly declined to flag it. It is now **1,885** —
   it grew 146 lines AFTER that sign-off. Re-test with a second reader.
3. `approval.ts` was 1,178 at the last pass (five verbs + private `latchHalt`).
   It is now **1,352**. The last pass asked whether the halt lane wants its own
   module; `latchSystemHalt` and `sweepSystemHalt` have since landed in
   `release.ts`, so the halt logic is now split across TWO files. Does that
   settle the question or worsen it?
4. `dispatch.ts` (2,001 lines) appears in **none** of fallow's large-function,
   high-complexity or refactoring-target lists. Either it is genuinely well
   decomposed, or the churn window (6 months) cannot see a 1-commit-old file.
   Determine which. `runDispatchTx` / `commitSendTerminal` were named at merge
   as the two functions that grew fastest under review pressure.

### Named single owners added this window — check each has exactly one

5. `applyDispatchGate` (B6 order + withheld-reason mapping), `classifySendFailure`
   (D12c), `lintInputFromSnapshot`, `runReleaseCycle`, `latchSystemHalt`,
   `sweepSystemHalt`, `capacityStop`, `resolveWindowHaltReason`. For each: one
   definition, one contract, no second spelling.
6. `closeBatchIfSettled` (`outreach.ts:317`) gained a SECOND caller in #920 and
   deliberately no second implementation. It is 133 lines at cyclomatic 9. It is
   now called by every approval verb AND the release sweep. Does the second
   caller change its contract?
7. `completeOutboxNoop` is **deliberately duplicated** between the generation and
   dispatch lanes, with `src/lib/shared/outbox.ts` named as its real owner.
   #912 said "a third copy is the signal to hoist". Count the copies now.

### The carve-outs and exceptions

8. **The `readSendBreaker` try/catch carve-out (#926).** The docstring forbids
   catching; the carve-out holds because "the operative half of that contract is
   'and proceeds to send', and this read only picks a label". Three prose
   statements guard it (`CONTEXT.md` Halt latch, the amendments doc, the arch
   log). **Is there a second label-only read yet?** If yes, the distinction needs
   a mechanical guard.
9. **`tenant-scope-allowlist.ts` gained 4 platform-wide predicates** under a
   standing sign-off. That is the same "scope is an ENUMERATION" meta-class the
   2026-08-18 pass logged as X10 (then at four instances; the arch log says #900
   made it five and six). Count the current instances. Is X10 now a rule, not a
   pattern?
10. `solicitation_send_breaker` is the first platform-scoped table with no
    `account_id` — not a `TENANT_TABLES` member, not in `TABLE_DISPOSITIONS`,
    deny-all RLS, and **it IS its own audit record**. Is that documented at the
    call site or only in the arch log? Does a second such table exist now?

### Known open follow-ups — confirm still true, then rank

11. #908 — `readBreakerWindow` seq-scans; migration 110's bitmap-scan comment is
    wrong and 110 is immutable at head.
12. #909 — the admin-route gate→parse→400 preamble extraction is blocked on the
    `ci:admin-aal2` gate-shape change; the two MUST ship together.
13. #910 — eight remaining #898 follow-ups (B3.1–B3.7, B3.10).
14. #919 — release-phase counter object, `seedUpload` consolidation,
    release-lane glossary term.
15. #886 — extract `ApprovalPanel.tsx`'s lane-write seam into `lane-writes.ts`.
    The panel is **1,116 lines**, down from 1,109 at the last pass — it did not
    grow, which is itself worth noting.
16. #880 — `useAdminActionForm`: the `useReducer` shape across five admin
    surfaces. `SendBreakerClient.tsx` (356 lines) is new this window. Is it a
    sixth instance?
17. #914 — send handoff should withhold a location with no canonical Google
    place id. Still open with the send lane now live.

### Theme B seeds — the rebrand

18. `useReveal.ts` is **33 LOC with 12 dependents** and is fallow's #2
    refactoring target by ROI ("high impact · split high-impact file"). A 33-line
    hook is not a split candidate; interrogate what the signal actually means
    before proposing anything.
19. `Reveal.tsx` exists in `sections/how-it-works/` (34 lines) AND a second
    `Reveal` implementation exists elsewhere — a name collision was observed but
    not confirmed. Find both, decide whether it is duplication or two different
    things wearing one name.
20. `HowItWorksContent.tsx` is 441 lines with a **270-line function**;
    `FeaturesContent.tsx` is 326 lines at cognitive 24 with **18 hooks**
    (1 state, 1 effect, 1 memo, 15 custom). Both are single-page composition
    roots. Is the hook count a smell or the intended shape of a section page?
21. **Five CSS files carry the surface**: `island.css` (1,591), `features.css`
    (515), `how-it-works.css` (390), `pricing.css` (332), `globals.css` (189).
    The `repworth-brand-design` skill says one token owner per surface. Verify
    that holds; a token defined in two files is a finding.
22. Twelve `Feat*.tsx` + eight `*Artifact.tsx` components. Do they share a
    contract, or is each a one-off? Six of them are marked **accelerating** in
    churn despite being new.

### Process

23. The **`fallow` PR gate has no local counterpart** in the feature workflow —
    `verify-gate.sh` runs 28 checks and not that one. #900's decomposition
    happened AFTER three review rounds against signed-off code. Still true?
24. The **false-rationale class** was promoted to lab-notes with EIGHT
    instances, all of them claims about a module's own internals. Look for a
    ninth in this window's code.
25. **#896 (H7) is the counter's own fix and it is unexecuted.** This pass is
    the FOURTH consecutive one to find the counter wrong by its own rule.

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
- The transactional outbox is one Postgres transaction; a topic with a helper
  must use it.
- Pre-launch codebase: no backwards-compatibility shims without a named
  external consumer.
- No new top-level directories; `docs/directory.md` needs a row per production
  file under `worker/` and `src/lib/`.
