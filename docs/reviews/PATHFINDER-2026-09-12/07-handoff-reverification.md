# Handoff re-verification — Pathfinder 2026-09-12

Every verdict below was **measured at HEAD `6edacd0b0`** with `rg`, a file read,
or `gh`. None is inferred from a commit title, a PR body, or a doc claim. Where
a search returned nothing, the search itself is shown — a "not found" is a
result, not an absence of work.

## Summary

| # | Obligation | Source | Verdict |
|---|---|---|---|
| A | **PR 1 / H3** — name the autonomy control surface (docs-only) | 08-24 H3, re-issued as 08-26 H1 **and** `08-next-session-prompt.md` PR 1 | **DID NOT LAND** — third consecutive pass |
| B | **PR 2** — every enumerated guard gets a completeness rule | 08-26 H2 / PR 2 | **PARTIALLY LANDED** — step 1 exists in exactly one guard, locally; step 2 did not land |
| C | **PR 3** — `owner_leads` gets a disposition | 08-26 H3 / PR 3 | **DID NOT LAND** |
| D | **H1** — bounced-owner email skip | 08-24 H1, re-issued as 08-26 H4 | **DID NOT LAND** — and the copy count grew |
| E | **H2** — one claim contract for the notice family | 08-24 H2, re-issued as 08-26 H4 | **DID NOT LAND — and it REGRESSED: 2 members → 5** |
| F | The issue-number rule the 08-26 pass recommended | `08-next-session-prompt.md:183-195` | **NOT ADOPTED** — and the pass filed no issues for its own H1–H10 |
| G | The #1270 entry's three "for the next pass" items | `arch-review-log.md` newest entry | **All three accurate at HEAD** |

**Score: 0 of 6 landed. 1 of 6 partially landed.**

The 2026-08-26 pass observed that *"3 of 3 ISSUE-NUMBERED items from 08-18
landed, while 0 of 3 prose handoffs from 08-24 did"* and recommended making
every handoff issue-numbered. **That recommendation was itself a prose handoff,
and it did not land either.** §F is the whole mechanism in one paragraph.

---

## A · PR 1 / H3 — the autonomy control surface → **DID NOT LAND (third pass)**

### (a) No composite table exists

`.claude/reference/env-vars.md:648-685` is a general per-flag table with
narrative prose per row. It is **not** the requested "one table, one owner" of
*what flipping each flag off stops and what it does NOT stop*. Its structure
predates the ask; the file's last touch is `d8e3f334f` #1270 (today, unrelated
Owner Operator work). The 08-26 prompt explicitly said *"env-vars.md:661 is
already correct and thorough. DO NOT REWRITE IT. The gap is the composite
view"* — and the composite view is still absent.

### (b) The three named runbooks are untouched, and the false claim is verbatim

- `docs/runbooks/launch-flag-readiness.md:104-108` — **unchanged.** Still
  lists only `ZERNIO_PUBLISHING_ENABLED` / `AUTO_APPROVAL_ENABLED` /
  `EDIT_REPLIES_ENABLED` / `TRIAL_ENABLED`; no solicitation flags. Last touched
  `37a3b49b7` (2026-08-31, #1045 — unrelated WS8 Phase G work).
  > A *separate* later section in the same file (`### 2026-08-31 — full
  > four-surface flag read`, `:115-165`) does list both solicitation flags
  > beside the six autonomy flags. It is a **point-in-time value snapshot**,
  > not off-semantics, and it predates the ask. Credited here so the next pass
  > does not "discover" it as the fix.
- `docs/runbooks/agentic-staging-copilot-autopilot-e2e.md` —
  `rg -n 'SOLICITATION' <file>` returns **zero hits.** `:77-82` still reads
  *"1.3 All six autonomy flags OFF at baseline"* and the copy-pasteable grep
  still checks exactly
  `TRIAGE_ENABLED|ESCALATION_ENABLED|JUDGE_ENABLED|GOVERNOR_ENABLED|AUTO_APPROVAL_ENABLED|AUTOPILOT_PURCHASABLE`.
  **This is the false "six flags" claim, verbatim, three passes after it was
  first named.** `:251` and `:256-258` also say nothing about solicitation.
  File last touched `f23888c58` (2026-07-22, #521) — before the 08-24 pass even
  ran.
- `docs/runbooks/beta-production-standup.md` — `rg -n 'SOLICITATION'` returns
  **zero hits**; the Phase B env-var block near `:143` omits both solicitation
  flags. Last touched `5670f63a7` (2026-09-06, #1142, unrelated dead-var
  cleanup). **This is the production go-live checklist.**

### (c) The two asymmetries are recorded nowhere operational

Neither *"the Governor cannot suspend Solicitation alone"* nor *"owner never
got the notice downgrades in Reply but ages out the batch in Solicitation"*
appears anywhere outside the Pathfinder review artifacts themselves. Searched
`docs/`, `.claude/`, `src/`.

### (d) The underlying claim is still exactly true

```
$ rg -P '(?<!SOLICITATION_)\bAUTO_APPROVAL_ENABLED\b' src/lib/solicitation/
(no output, exit 1)
```

**The documented "instant kill switch" `AUTO_APPROVAL_ENABLED=false` still has
ZERO reads in the solicitation lane.** The fact that motivated the whole
handoff is unchanged, and remains undocumented in every operational surface.

### Is it wrong? / Is it reachable?

**Is it wrong?** Yes — an operator running the documented check sees six flags
false and concludes "Copilot baseline". **Is it reachable?** As an operational
hazard, yes, and it is confined to staging. **Production risk is zero** and
**invariant #3 is not implicated** — this lane does not post to Google. This is
the same framing the 08-26 pass insisted on, and it still holds. Do not write
it up as an incident.

---

## B · PR 2 — enumerated-guard completeness → **PARTIALLY LANDED**

**Step 1 — `scannedCount === 0` fatal inside the harness: did NOT land as
specified.** `scripts/ci/lib/ratchet-harness.ts` has **zero** occurrences of
`scannedCount`. Its own docblock at `:5-9` still says *"Each audit still OWNS
its SCAN_DIRS"*. The file's last touch is `72d94c062` (2026-07-16) — untouched
since before any Pathfinder pass.

**The fatal does exist — in exactly one guard, locally.**
`scripts/ci/pool-fanout-audit.ts:530-539` (`preflightBlocker`) checks
`scannedCount === 0`. One guard got it. The ask was *"one place, covers every
harness user"*, precisely because only 6 of 46 guards notice an empty scan. 45
still do not.

**Step 2 — export every `SCAN_DIRS` + one `ci-audit-wiring` completeness case:
did NOT land.** `rg -n 'SCAN_DIRS' src/__tests__/ci-audit-wiring.test.ts` →
**zero hits.** Of the ~13 audits with a local `SCAN_DIRS`, exactly one exports
it — `pool-fanout-audit.ts:142`. Still un-exported locals:
`directory-map-audit.ts:66` · `process-env-audit.ts:19` ·
`dropped-columns-audit.ts:51` · `reviews-status-audit.ts:60` ·
`outbox-seam-audit.ts:80` · `db-imports-audit.ts:20` ·
`response-status-audit.ts:39` · `static-policy-audit.ts:50-51` ·
`outbox-topics-audit.ts:50`. No union check, no coverage test.

**The two named live consequences are both still present:**
- `ci:pool-fanout`'s `SCAN_DIRS` did **not** widen —
  `pool-fanout-audit.ts:142` is still
  `['src/lib/admin', 'src/lib/dashboard', 'src/lib/locations']`, unchanged
  since `efd2145d9` (2026-08-23, before the 08-24 pass).
- `src/lib/solicitation/contacts-repo.ts:103` — the two-way `Promise.all` on
  the singleton is **still there**. File last touched `ec1150892` (2026-08-04),
  untouched since discovery.

**`table-disposition.test.ts` gained no completeness assertion.** Its universe
is still built from `TENANT_TABLES` (imported `:6`) plus an explicit
account-linked list (`:102`). `owner_leads` is in neither — it is a documented
tenant-scope exemption with no account link — so **the test's universe still
structurally cannot see it.** This is exemption transit, exactly as the 08-26
pass named it, unrepaired.

---

## C · PR 3 — `owner_leads` disposition → **DID NOT LAND**

```
$ rg -n 'owner_leads' scripts/ci/ src/ worker/ supabase/
scripts/ci/tenant-tables.ts:244        (the pre-existing tenant-scope exemption)
supabase/migrations/033_owner_leads.sql
src/app/api/lead-intake/route.ts:256,261
(+ test fixtures)
```

**No row in `TABLE_DISPOSITIONS`** (`src/lib/account-offboarding/table-disposition.ts`
has no `owner_leads` match at all), no purge sweep, no verification branch.

> **The sharpest detail in this section.** `table-disposition.ts` **was edited
> today**, by `d8e3f334f` #1270 — to add the four new Owner Operator tables. A
> PR touching the exact file this handoff asks for a one-line addition to, on
> the same day the pass ran, and `owner_leads` was not added. Nobody erred: the
> Owner Operator author had no reason to know. That is the mechanism §F
> describes — a requirement recorded only in a review document is invisible at
> the moment of editing.

**Reachability, restated so it is not overstated:** owner PII (name, email,
`business_name`, `maps_url`) survives an account purge **iff** the owner used
the public lead form (`src/app/api/lead-intake/route.ts:261`) before signing
up. Conditionally reachable. **LIVE**, conditionally.

---

## D · H1 — bounced-owner email skip → **DID NOT LAND, and the copies grew**

Neither named consolidation point has the check.
`rg -n 'owner_email_bounced' src/lib/notifications/resolve-channels.ts` → 0
hits. Same for `worker/jobs/auto-post-notice/context.ts` → 0 hits.

**Eleven independent private gating sites at HEAD** (the `if`/skip conditionals,
not variable declarations), across **29 files** that mention the column:

1. `worker/jobs/notification/dispatch.ts:197`
2. `worker/jobs/escalation-notice/dispatch.ts:91-94`
3. `worker/jobs/pending-post-notice/dispatch.ts:101-104`
4. `worker/jobs/autonomy-suspended-notice/dispatch.ts:49-51`
5. `worker/jobs/solicitation-veto-notice/dispatch.ts:85-88`
6. `worker/jobs/OnboardingDripWorker.ts:156`
7. `worker/jobs/summary-report-helpers.ts:177`
8. `worker/jobs/OwnerEmailWorker.ts:97`
9. `worker/jobs/EngagementAlertWorker.ts:102`
10. `worker/background/pollers/EngagementMonitorPoller.ts:152`
11. `src/lib/solicitation/postal-address.ts:278` (a distinct solicitation gate)

**The BUG-1 defect is confirmed present and confirmed to be an inconsistency,
not merely a duplication.** `worker/jobs/auto-post-notice/` — the
highest-volume notice in the family — contains **no bounce handling of any
kind**:

```
$ rg -n 'bounce' worker/jobs/auto-post-notice/
(no output)
$ ls worker/jobs/auto-post-notice/
AutoPostNoticeWorker.ts  context.ts  dispatch.ts  errors.ts  __tests__
```

Meanwhile its own email template carries the comment
*"so a hard bounce flags `businesses.owner_email_bounced`"*
(`src/lib/notifications/email/templates/auto-post-notice.ts:13`) — the template
knows about the flag; the dispatcher that sends it does not read it. Four
sibling dispatchers do, one of them with the comment *"same rule as the
approval dispatcher"* (`escalation-notice/dispatch.ts:89-90`).

**Is it wrong?** Yes. **Is it reachable?** `auto_post_notice` fires only on an
auto-approved post, which requires `AUTO_APPROVAL_ENABLED` — off in every
environment. **LATENT, code-reachable, deployment-dormant** — the same
classification the 08-26 pass corrected the 08-24 pass into making, and it
still holds. It becomes LIVE on the first `AUTO_APPROVAL_ENABLED` flip.

---

## E · H2 — one claim contract → **DID NOT LAND, and it REGRESSED**

The 08-26 pass measured **two** claim functions at `delivery.ts:84` and `:113`.
At HEAD there are **five**, in a 440-line file, with **no shared helper** —
`grep -n '^export async function claim'` returns exactly these five, each
independently bodied:

| Function | Line | Δ since 08-26 |
|---|---:|---|
| `claimAutoPostNoticeDelivery` | `:84` | unchanged line number |
| `claimEscalationNoticeDelivery` | `:113` | unchanged line number |
| `claimPendingPostNoticeDelivery` | `:143` | **new to this measurement** |
| `claimAutonomySuspendedNoticeDelivery` | `:194` | **new to this measurement** |
| `claimSolicitationVetoNoticeDelivery` | `:278` | **new to this measurement** |

The 08-26 SCOPE brief set a trigger for exactly this: *"a seventh member inside
this window would change the recommendation from 'extract' to 'extract now'."*
The trigger was about the **notice family**, and this is the **claim
contract** — but the signal is the same and stronger: the duplicated surface
**grew by 150%** while the handoff to consolidate it sat unactioned.

`fallow dupes` at HEAD corroborates independently, without being told where to
look — three separate clone groups inside this family:

```
36 lines  3 instances   escalation-notice/context.ts:102-137
                      ≡ pending-post-notice/context.ts:142-177
                      ≡ solicitation-veto-notice/context.ts:101-136
20 lines  4 instances   email/templates/{auto-post,escalation,pending-post,solicitation-veto}-notice.ts
34 lines  2 groups      auto-post-notice/dispatch.ts ≡ pending-post-notice/dispatch.ts
52 lines  2 instances   OwnerEmailWorker.ts:204-255 ≡ :313-360   (self-duplication)
```

**Escalated to H2 in `04-handoff-prompts.md` and ranked HIGH.**

---

## F · The issue-number rule → **NOT ADOPTED**, and the pass did not apply it to itself

The 08-26 pass's closing recommendation: *"a follow-up named in a spec gets an
issue number in the same PR, or it does not get named… Consider extending it: a
Pathfinder handoff gets an issue number when the pass ships, or it is not a
handoff."*

Searched `.claude/CLAUDE.md`, `.claude/rules/*.md`, `.claude/commands/feature.md`,
`.claude/skills/**`, `docs/agents/*.md`, `AGENTS.md`, `lefthook.yml`,
`scripts/ci/`:

```
$ grep -rn -i "gets an issue\|named in a spec\|handoff gets" <those paths>
```

Hits **only** in the Pathfinder artifacts themselves and at
`.claude/reference/arch-review-log.md:861-862`, where it sits as a *"Process
note / Suggested rule"* from the 08-24 entry. **Never promoted into
governance.** Zero hits in `.claude/CLAUDE.md` or any `.claude/rules/*.md`.

**And the pass filed no issues for its own output.**
`gh issue list --state all --search "pathfinder"` and a 60-issue listing show
**no issue for any 08-24 or 08-26 handoff subject** — not the autonomy control
surface, not the notice-claim consolidation, not the `owner_leads` disposition,
not the `scannedCount`/`SCAN_DIRS` completeness, not the bounced-email
consolidation.

**The contrast is now a controlled experiment, and it is the pass's cleanest
finding.** The 08-18-era pass's H1–H7 **did** get issue numbers — **#890–#896,
all closed**. Three of three landed. The 08-24 and 08-26 passes' handoffs got
prose, and **zero of six landed across two consecutive windows**, one of them
177 merges long.

| Pass | Handoff form | Filed as issues? | Landed |
|---|---|---|---|
| 08-18 | H1–H7 | **Yes — #890–#896** | **3 of 3 tracked** |
| 08-24 | H1–H3 prose | No | 0 of 3 |
| 08-26 | H1–H10 prose | No | 0 of 3 top-ranked |

This pass therefore does something different: **`04-handoff-prompts.md` ends
with a ready-to-run `gh issue create` block for every handoff**, and the arch
log entry records that filing them is part of shipping the pass, not a
follow-up to it. A recommendation that must itself be remembered is the same
failure class it describes.

---

## G · The #1270 entry's three "for the next pass" items → **all three accurate**

Located at the **top** of `.claude/reference/arch-review-log.md` (newest-first),
not at the line range the brief guessed.

**1. "the `agent_turn` lane's six domain terminals emit logs only."**
Located; all six in `worker/jobs/agent-turn/AgentTurnWorker.ts`, against
`TURN_FAILURE_REASON`'s seven members (`src/lib/agents/operator/schema.ts:52-60`).
`PREDECESSOR_STALLED` `:119`/warn `:122` · `ACCOUNT_OFFBOARDING` and
`UNAUTHORIZED` (reauth) share the ternary `:166-168`/warn `:171` ·
`UNAUTHORIZED` (vanished voice) `:226`/warn `:229` · `MODEL_OUTPUT_INVALID`
`:201`/warn `:204` · `BUDGET_EXCEEDED` `:289`/warn `:292` ·
`OPERATOR_DISABLED` `:331`/log `:324`. The seventh, `EXHAUSTED`, is written by
`failed-hook.ts`, not the worker. No `Sentry`/`capture` string in the file.
**Accurate as to alerting — but see F1's correction: the phrase "emit logs
only" is misleading, because all six also write the turn row and complete the
outbox row. The true "writes nothing" exit is the lease-lost branch at `:370`,
which is not a terminal at all.**

**2. "five private `boundedErrorClass` copies collapsed to four." Accurate, and
here are the four:**

| Copy | `file:line` |
|---|---|
| **shared, exported, hardened** | `worker/jobs/solicitation-batch/failed-hook-shared.ts:36` |
| private | `worker/jobs/judge/failed-hook.ts:39` |
| private | `worker/job-failure-sink.ts:59` |
| private | `worker/jobs/csv-ingest/failed-hook.ts:94` |

The collapse is real: `worker/jobs/agent-turn/failed-hook.ts:8` **imports** the
shared one instead of defining a fifth.

**How they differ — and it is not cosmetic.** The three private copies are
**byte-identical to each other**:

```ts
function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}
```

The shared one differs in **two** ways at once: it reads
`err.constructor.name` (not `err.name`) and validates it against
`/^[A-Za-z][A-Za-z0-9_$]{0,99}$/`, falling back to `'UnknownError'` for
anything not identifier-shaped. So a 3-way tie plus one hardened outlier — and
the outlier is the one that got exported. **The three unhardened copies are
what a future author will find by grep and copy.** Carried as **H4**.

**3. "`worker/index.ts` and `job-outbox-helpers.ts` both crossed 1,000 lines."
Accurate.** `worker/index.ts` = **1,006**;
`src/lib/shared/job-outbox-helpers.ts` = **1,027**. Only **16** production
files under `src/lib/` + `worker/` exceed 800 lines — full table in
`00-health-baseline.md` §2.

---

## Confidence and gaps

- Every verdict above rests on a command whose output is quoted or whose
  emptiness is stated. The four load-bearing ones — the five `claim*Delivery`
  functions, the four `boundedErrorClass` copies, the absent bounce handling in
  `auto-post-notice/`, and the empty
  `rg -P '(?<!SOLICITATION_)\bAUTO_APPROVAL_ENABLED\b' src/lib/solicitation/` —
  were re-run by the orchestrator independently of the subagent that first
  reported them, per the "a citation is not a verification" rule.
- **Not measured:** live flag values on Railway and Vercel. The 08-26 pass read
  them; this pass did not, and every reachability verdict above that depends on
  a deployed value says so explicitly rather than assuming. Code defaults were
  read instead (`src/lib/config/flags.ts:21-23`, `readFlag` is
  `=== 'true'`; `readFlagEnabledByDefault` at `:28` is `!== 'false'`).
- **Not measured:** whether any of the six obligations was *deliberately*
  declined by the owner. Nothing in the tree records such a decision, but its
  absence is not proof it was not made.
