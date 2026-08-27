# Process findings — Pathfinder 2026-08-26

About how the work is tracked and reviewed, not about the code.

---

## 1. HEADLINE — the entropy counter is unfixable as specified, and this pass says why

Six passes have now reported this counter wrong. The 08-24 pass reported it
**right** and credited `ci:merge-ledger`. **That conclusion did not survive one
window.**

### The measurement

| Candidate counter | Value for this window |
|---|---|
| The number written in the log | **8** |
| Bullet entries under *"Merges since the 2026-08-24 pass:"* | **8** |
| Merges meeting the log's own stated rule | **12** |
| Lines added to the log by window merges | **235**, across 15 merges |

The log's number and its bullet list agree. **Both are wrong by four.**

The four counted merges with no bullet:

| PR | Production files | Where it IS recorded |
|---|---|---|
| #976 marketing spacing/motion/copy | 26 | bottom table row 17 — **no number at all**, keyed as prose |
| #964 ask-lint + List-Unsubscribe | 5 | bottom table rows 13–14, keyed by **issue** #963/#966 |
| #962 tenant-scope blind spot | 11 | bottom table row 15, keyed by **issue** #894 |
| #954 review_attributed shadow attribution | 13 | not by PR; `#632` (the issue) appears twice |

`rg -c '#962'` and `rg -c '#954'` both return **0**.

### Why "count the lines" cannot work — the log's own prescribed fix is unsound

The log tells the next reader:

> *"Resolve it by COUNTING THE LINES BELOW, never by trusting either side's
> number — the lines are the only source that cannot drift."*

**The lines drift.** `ci:merge-ledger` fires on **two** triggers
(`scripts/ci/merge-ledger-audit.ts:22-32`): a production file **or** a
governance file — the skills, hooks, workflows, `scripts/ci/`, `lefthook.yml`,
`package.json`. The arch log's counting rule is **production only**.

The audit's trigger set is therefore **strictly wider** than the counting rule.
Three merges in this window prove it:

| PR | Production files | Governance files | Log lines added | Must increment? |
|---|---|---|---|---|
| #957 blast-radius AST | 0 | 2 | 1 | **No** |
| #960 test-DB provisioning lock | 0 | 4 | 1 | **No** |
| #961 `ci:env-registry` | 0 | 5 | 1 | **No** |

Each of the three was **required by CI** to add a line, and each **must not**
count. They are bottom-table rows 10, 11 and 12. So the table holds counting
merges and non-counting merges side by side, **with no marker distinguishing
them**. Counting the table over-counts. Counting the lines over-counts.

### The real defect is four inconsistencies, not one lapse

1. **Two accepted locations** — bullet list or bottom table. The log named this
   on 2026-08-26.
2. **No stable key** — entries are keyed by PR number, by issue number, by
   branch name, or by bare prose with no identifier at all.
3. **A wider audit trigger than the counting rule** — governance merges must
   leave a trace and must not increment. Nothing marks which is which.
4. **A unit that is not a unit** — "lines added" ranges from 1 to 36 per merge.

Reconciling four inconsistencies by hand, every pass, is the actual process.
Six passes have produced six different answers. **That is the expected output
of this design, not a discipline failure.**

### What `ci:merge-ledger` actually guarantees

It is worth stating plainly, because the 08-24 pass overstated it.
`merge-ledger-audit.ts:39-43` says so itself:

> *"WHAT IT DOES NOT DO. It never reads or writes the counter number. The
> counter is a judgement about which merges 'count' … Leaving the number to the
> pass and enforcing only the TRACE keeps this check mechanical."*

The audit guarantees **a trace exists**. It was designed to guarantee nothing
about the number, and it delivers exactly what it promised. **The 08-24 pass
credited it with a guarantee it explicitly declines.** Correct the record: the
audit is working; the counter was never in its scope.

### Recommendation

Do not write a sixth "the humans forgot" entry. Pick one owner and make it
mechanical:

- **One location.** The bottom table is the better candidate — it already has
  columns, and the bullet list is prose of one to forty lines.
- **One key column, always the merge SHA.** A SHA cannot be a PR number one
  time and an issue number the next.
- **One `counts` column**, boolean, set by the same classifier the audit already
  exports (`isProductionFile`, `merge-ledger-audit.ts:87`). The audit computes
  this today and throws it away.
- Then the counter is `SELECT count(*) WHERE counts AND date > last_pass` — a
  derivation, not a judgement. Extend `ci:merge-ledger` to check the row shape
  it already has the data for.

This is the one change that ends a six-pass recurrence. Everything else has been
tried.

---

## 2. Migration lockstep — CONFIRMED CLEAN, and the 078 exception is accurate

Seed 5 asked whether migration 114 reached both databases. Verified by direct
introspection of both Supabase projects, not by reading commit messages.

| Object | Prod `udeyaqnvpojbwgoaxwdg` | Staging `kubdiqdhqbhwmqfditeg` |
|---|---|---|
| 114 columns on `solicitation_outreach` | **4 of 4** | **4 of 4** |
| 114 indexes | **3 of 3** | **3 of 3** |
| 113 indexes | **2 of 2** | **2 of 2** |

`6aba0c12` (#956) claims 114 is promoted to staging and production. **The claim
is true.**

The standing 078 exception was checked at the same time, because CLAUDE.md warns
that a stale version of that sentence is what made past sessions contradict each
other:

| Marker | Prod | Staging |
|---|---|---|
| `businesses.subscription_tier` still nullable | **yes** | no |
| `accounts/businesses_subscription_tier_check` | **0 of 2** | 2 of 2 |

This is the exact signature CLAUDE.md documents for "078 absent in prod".
**The exception is accurate and unchanged.** No drift.

---

## 3. Seeds — three confirmed, three wrong, one refuted

The SCOPE brief said *"Do NOT trust these … refuting a seed is a result."*
A pass that confirmed every seed would be evidence the seeds were written from
the answers.

| Seed | Outcome |
|---|---|
| 1 — the counter has a two-owner defect | **CONFIRMED AND WORSE.** Not two owners — four inconsistencies. And the log's own prescribed fix is unsound. |
| 2 — the marketing surface grew a subsystem unreviewed | **CONFIRMED.** 100 files / 17,141 lines, 46% CSS, and the arrival grammar has six spellings. |
| 3 — the notice family is still six members | **CONFIRMED, and the escalation trigger did NOT fire.** No seventh member landed. Recommendation stays "extract", not "extract now". |
| 4 — `ci:merge-ledger`'s success was declared one window early | **CONFIRMED.** See §1. |
| 5 — migration 114 lockstep | **CONFIRMED CLEAN.** Both databases, verified by introspection. |
| 6 — the new suppression writers may break locked precedence | **REFUTED.** All four locked terms pass, twice — F9 by ledger trace, F10 independently via `applyDispatchGate:243`. |
| 7 — the `/feature` gates misfired twice | **CONFIRMED.** See §4. |

**My own scope brief carried an error the pass had to correct.** It named
`src/components/landing/` three times. That path does not exist — the surface is
`src/components/sections/landing/`. A grep keyed to the wrong path returns
nothing **silently**. The health-baseline agent caught it and I corrected the
brief mid-pass. Recorded because the next brief will be written the same way.

## 4. The `/feature` workflow's own gates misfired twice in one window

Both are recorded in the arch log by the sessions that hit them.

1. **`reclassify` fired at 211 versus 90 estimated production lines on a change
   that had not sprawled** — 6 of 6 declared files, one seam, ~64 executable
   lines, and 55% of the additions were comment in a file already 55% comment.
   **The trigger measures a proxy this repo's comment density defeats.** The
   suggested remedy in the log — split the estimate into executable versus
   comment — is right.
2. **A one-line CSS import pulled `LandingExperience.tsx` into the fallow gate's
   scope** and surfaced an inherited 0%-coverage file (CRAP 56) as a PR blocker.
   It was fixed with a real test rather than a suppression, which is the right
   call — but a one-line import edit becoming a blocker is worth knowing.

Two false blocks in one window, from two different gates, on two changes that
were both correctly scoped. Neither gate is wrong to exist. Both measure a proxy.

## 5. The handoff-landing pattern inverted, and nobody planned it

| Source pass | Handoffs | Landed |
|---|---|---|
| 2026-08-18 | #892, #894, #895 | **3 of 3** |
| 2026-08-24 | H1, H2, H3 | **0 of 3** |

The 08-18 items had survived **two** windows untouched. The 08-24 pass proposed
closing them as won't-fix if they survived a third. **They were actioned
instead** — and the fresh three, including one marked *"MUST LAND BEFORE #633
FLIPS ANYTHING"*, were not.

Worth stating plainly: the three that landed were all **issue-numbered**
(#892, #894, #895). The three that did not are **prose handoffs in a review
document** (H1, H2, H3). That is the same mechanism as §6 and as the `#3a`
finding — work that leaves no trace outside the document that mentions it does
not get done.

**This is now the third consecutive pass to find that class**, in three
different forms: uncounted merges (fixed by `ci:merge-ledger`), a spec
parenthetical (`#3a`, still live), and now a pass's own handoff list.

## 6. The "a citation is not a verification" rule held — including against me

The 08-24 pass added this rule after publishing a wrong headline from a
well-cited subagent report. This pass applied it and it earned its place twice.

**Once in the agents' favour.** Every finding ranked as a bug in this pass
carries an explicit, separate answer to *"is it reachable?"*. Two of the most
alarming-sounding findings — the 08-24 pass's H1 and H2 — came back **LATENT**,
because `auto-policy-publish.ts:555-562` and the live flag state close both entry
points. The code diagnoses are correct; the present-tense urgency was not. A pass
that relayed those prompts unchanged would have shipped two wrong PR bodies.

**Once against the orchestrator.** I ran a `rg` for `isFoundingWindowOpen`
callers, piped it through `head -12`, and concluded F7's commercial finding was
unsupported. **The truncation hid the hit.** `pricing/page.tsx:17` calls it
directly. I re-checked before writing anything down, and F7 was right.

The lesson is not "be careful with `head`". It is that **the orchestrator's own
verification is a subagent report too**, and deserves the same suspicion. The
08-24 pass caught its error because the orchestrator re-derived a claim before
publishing. This pass caught its error the same way.

## 7. What this pass did NOT measure

Stated so no reader mistakes silence for a clean result.

- **`pnpm test` was not run.** Test health at HEAD is unmeasured. `typecheck`,
  `lint` and all 21 `ci:*` audits pass. The 08-24 pass also skipped the suite.
- **`ci:fallow:coverage` was not run** — it needs the `test` job's coverage
  artifact, and CLAUDE.md is explicit that a bare `fallow audit` does not
  predict it in either direction.
- **Vercel environment variables were not read.** All three autonomy flags are
  server-only with no `NEXT_PUBLIC_*` companion, so a Vercel value would not
  change the H3 finding — but it was not confirmed.
- **No guard-integrity mutation axis this pass.** The 08-15, 08-18 and 08-22
  passes each ran one. This pass spent its budget on the marketing surface,
  which had never been charted. **The one guard-integrity finding that did
  surface came free** — `design-token-single-source.test.ts:35` uses a
  line-anchored matcher, so a compact one-liner hides both tokens from it.
  Proven by execution, not argued. That suggests the mutation axis would still
  pay, and skipping it is a real gap rather than a settled question.
