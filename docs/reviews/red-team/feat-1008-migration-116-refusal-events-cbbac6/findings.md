# Red team — `feat/1008-migration-116-refusal-events`

**Round 2 of 2 (the hard cap).** Mode `feature`. Risk `high`.

| | |
|---|---|
| Run id | `feature-feat-1008-migration-116-refusal-events-cbbac6` |
| Fork | `5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64` |
| Merge base | `5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64` |
| HEAD | `6a7fc65010c301644b796fd49cda9d3294ccab3a` |
| Intake SHA-256 | `3a53e31f4da91a9ccdbe2f805c761214e386e59ba73664f4f6815fe77d1a561f` |
| Gate at HEAD | GREEN, 30/30 (`.feature/gate-status.json`, `"passed": true`) |
| Round-2 scope | `git diff 25a64303..6a7fc650` — the fix hunks and their directly affected callers |

Round 1 ran at `25a6430311a59120e01e85cbd8753c2eda1e8028` and raised twelve
findings. This round re-resolves every one against HEAD and adds four new ones
found **inside the fix hunks**. Nothing here opens a front against unchanged
code; anything noticed outside scope is in the appendix as P2 and does not move
`status`.

---

## Severity table

| ID | Sev | Duty | Finding | At | Disposition |
|---|---|---|---|---|---|
| RT-01 | **P0** | 3 | ADR 0023's withheld writer/anchor table was false for 2 of 8 reasons | `docs/adr/0023-refusal-log-owner-safe-projection.md:180` | **fixed** |
| RT-02 | **P1** | 2 | `toMatch(/cascade/i)` passed on the exact negation of the claim it guarded | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:190` | **fixed** |
| RT-03 | **P1** | 2 | C5's outer `IS TRUE` wrapper was asserted by nothing | `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:815` | **fixed** |
| RT-04 | **P1** | 3 | Plan citations staled by this change's own hunk — **the intake's three were never converted, and two are stale at HEAD** | `docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:46` | **open** |
| RT-05 | **P1** | 5 | Terminal purge failure emits a Sentry signal no runbook rule routes — all six facets MISSING | `docs/runbooks/beta-launch-alerting.md` | accepted-risk (`AUTH-1008-01`) |
| RT-06 | P2 | 3 | "nine probe rows" — **only the deviations copy was corrected; the arch-review-log copy still says nine** | `.claude/reference/arch-review-log.md:1420` | **open** |
| RT-07 | P2 | 3 | CONTEXT.md asserted two `/dashboard/analytics` tabs in the present tense | `CONTEXT.md:165` | **fixed** |
| RT-08 | P2 | 5 | Retry and terminal captures share one message and no fingerprint | `worker/jobs/account-offboarding/PurgeWorker.ts:114` | accepted-risk (`AUTH-1008-01`) |
| RT-09 | P2 | 2 | In-test comment misattributed the `['different', NULL]` rejection to the wrapper | `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:929` | **fixed** |
| RT-10 | P2 | 3 | ADR mapped `admin_halt` on a lane whose rows cannot carry it | `docs/adr/0023-refusal-log-owner-safe-projection.md:87` | **fixed** |
| RT-11 | P2 | 2 | Two C5 clauses are provably redundant, so no row can pin them | `supabase/migrations/116_refusal_events.sql:160` | **rejected** |
| RT-12 | P2 | 3 | Three doc inaccuracies — **the typo is fixed; the arch-review-log §II.5 attribution and the intake's "eleven write sites" are untouched** | `docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:8` | **open** |
| RT-13 | P2 | 3 | **NEW.** The rewritten anchor table drops `unsubscribed`, the eighth member of migration 111's withheld arm | `docs/adr/0023-refusal-log-owner-safe-projection.md:180` | open |
| RT-14 | P2 | 3 | **NEW.** The 23rd `tests_to_add` title staled two count claims the same commit did not update | `.claude/reference/arch-review-log.md:1420` | open |
| RT-15 | P2 | 3 | **NEW.** The §II.5 correction over-attributes: §II.5 states staging-DDL-before-**prod**-DDL, not before the staging deploy | `.claude/reference/migrations-log.md:2584` | open |
| RT-16 | P2 | 3 | **NEW.** The round-1 sidecar committed at HEAD fails the checker: 4 shape errors, 6 count mismatches, wrong status; `findings.md` and `findings.json` contradict each other | `docs/reviews/red-team/feat-1008-migration-116-refusal-events-cbbac6/findings.json` | open |

**Counts:** inventory 23 (4 killed, 19 excluded, 0 inconclusive, 0
skipped-budget); findings 16 — 0 P0 open, **1 P1 open**, 6 P2 open, 2
accepted-risk, 6 fixed, 1 rejected.

**Status: `OPEN_P1`.** The single open P1 is RT-04. On a high-risk run the
checker blocks an open P1 unless an authorization resolves, so RT-04 needs
either a three-line intake edit or a user authorization.

### The through-line

Five of the six open findings are **one defect class**: a fact stated in two
artifacts, corrected in one. RT-04 (plan fixed, intake not), RT-06 (deviations
fixed, arch-review-log not), RT-12 (migrations-log fixed, arch-review-log and
intake not), RT-14 (intake gained a title, the two count claims did not),
RT-16 (`findings.json` gained dispositions, `findings.md` did not). D14 —
written in this very commit — names that exact class and says the lesson is
"the form is wrong rather than the value". The fix commit then reproduced it
five times.

---

## Preconditions

1. **Clean tree at a committed SHA** — `git status --porcelain` empty at
   `6a7fc650`. ✅
2. **`watchers` FAILED and was overridden on independently re-verified
   evidence.** The runner names four Node processes. `lsof -p <pid> -d cwd`
   resolves them:

   | PID | cwd |
   |---|---|
   | 68547 | `/Users/norbertesekiel/Developer/startups/RepWorth` (parent checkout) |
   | 69387 | `/Users/norbertesekiel/Developer/startups/RepWorth` |
   | 69738 | `/Users/norbertesekiel/Developer/startups/RepWorth` |
   | 76253 | `.../RepWorth-worktrees/refactor-globals-css-extraction` |

   None has this worktree as its cwd, so no hot-reload process can execute a
   mutation under an unscrubbed environment. Deviation carried forward from
   round 1 and re-derived here rather than inherited.
3. **Round 2 already open, journal clean, budget reset** — `status` reported
   `{"round": 2, "runs": 0, "mutations": [], "dotenv": {"open": false}}`.
   `round-start` was **not** called (the invoking agent opened the round).

---

## Environment

`mutation-runner.mjs env --tmp-home <mktemp -d> --test-db <localhost:5499>`
resolved the allowlist only — `PATH`, temporary `HOME`, `TMPDIR`,
`NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, and
`TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL` after localhost validation.
`dotenv-swap` then replaced `.env.local` with a scrubbed copy for the mutation
phase. The allowlist was never widened.

One run was spent learning that `run` needs its own `--test-db`: without it the
live-DB suite prints `TEST_DATABASE_POOL_URL unset — DB-gated integration
suites SKIPPED` and `assert-one-test` reports 0 executed. That run is recorded
as spent budget, not as an inventory row.

**Budget: 4 of 30 runs used.**

---

## Duty 1 — hand-mutation

### Direction B is genuinely empty, and that is a fact about the diff

`git diff --name-only 25a64303..6a7fc650` lists ten files: two test files and
eight documents (`findings.json` and `findings.md` among them). **The fix
commit touches no production `.ts`, `.sql`, or config file.** There is
therefore no behaviour-affecting production hunk in round-2 scope, and Direction
B contributes nothing. This is reported as the measurement it is rather than
padded with reverse-import searches against hunks that do not exist.

### INV-20 re-executed at HEAD — killed

The only fix hunk that changes an assertion over live production code is
RT-02's. Round 1 killed this title against a different mutation; the assertion
body changed in `6a7fc650`, so it was re-measured.

- **Green baseline at HEAD** — `assert-one-test: exactly one test executed —
  account offboarding table disposition inventory classifies refusal_events as
  hard_delete by direct_account_id, verified must_be_absent`.
- **Mutation** — `src/lib/account-offboarding/table-disposition.ts`, blob
  `060c260bd434 → 02247dadfe97`. The `refusal_events` `reason` was rewritten
  from `NO CASCADE REACHES IT: … nothing removes these rows unless
  runContentPurgeStage deletes them explicitly` to `A CASCADE REACHES IT: …
  the accounts FK carries ON DELETE CASCADE, so deleting the account removes
  these rows without any explicit statement`. **Semantically the exact
  negation**, and deliberately still containing the word "cascade".
- **Result — killed.** The title reports `"status": "failed"` under the mutant.
- **Arbiter note.** The mutation is not equivalent and is on the branch this
  test executes: `entry?.reason` is read directly by the two assertions under
  measurement, and the reason string has no other consumer that could mask it.
  The mutant also keeps `reason.length > 20`, so the neighbouring inventory
  tests stay green and the kill is attributable to this title alone.

### The discriminator, which is the whole point of RT-02

Applying the three regexes to the original and the mutant:

| Reason text | `/NO CASCADE REACHES IT/` | `/deletes them explicitly/i` | old `/cascade/i` |
|---|---|---|---|
| shipped (HEAD) | **true** | **true** | true |
| negated (mutant) | **false** | **false** | **true** |

The retired assertion accepts a reason claiming the opposite of what it
guards. Both replacements reject it. RT-02 is fixed, and proven so rather than
asserted.

### The migration is out of mutation scope, and the C5 case with it

`supabase/migrations/116_refusal_events.sql` is excluded by the skill: the test
database is provisioned before the run, so editing the migration file changes
nothing the suite reads. The new C5 structural title reads
`pg_get_constraintdef` from the live catalogue, so it inherits that exclusion —
it is verified below by TEMP-table rendering instead, which is the same
technique round 1 used and is a stronger measurement than a file edit would
have been.

### Restoration

The one mutated path was restored to its HEAD blob (`060c260bd434`) before a
byte of this report was written; `git status --porcelain` is empty on every
path except this run's two artifacts. **`finalize` was NOT run** — see
"Finalizer state" at the end.

---

## Duty 2 — fragile assertions, and verification of the three polarised fixes

### RT-03 — the C5 structural case is real, and specific enough

The new title asserts two regexes against `constraintDefinition(C5_ALL_CODES_PAIRING)`.
That helper (`:424-431`) filters `pg_constraint` to
`conname = 'refusal_events_all_codes_pairing'`, so C1's identical wrapper is in
a different string and cannot mask C5's.

C5 as rendered by the provisioned database:

```
CHECK (((((refusal_source = 'policy_gate_held'::text) AND (all_refusal_codes IS NOT NULL)
  AND (cardinality(all_refusal_codes) > 0)
  AND (array_position(all_refusal_codes, NULL::text) IS NULL)
  AND (refusal_code = ANY (all_refusal_codes)))
  OR ((refusal_source <> 'policy_gate_held'::text) AND (all_refusal_codes IS NULL))) IS TRUE))
```

`) IS TRUE` occurs **exactly once**. The wrapper-free variant was rendered by
Postgres itself — a `TEMP` table carrying C5 minus the wrapper, inside a
rolled-back transaction — and the two regexes were applied to four texts:

| Definition | `/array_position\(.*NULL.*\) IS NULL/` | `/\)\s*IS TRUE/` |
|---|---|---|
| shipped | true | **true** |
| wrapper removed | true | **false** |
| `array_position` clause deleted | **false** | true |
| `array_position` clause negated to `IS NOT NULL` | **false** | true |

Both assertions fail on their own negation and neither masks the other. The
parent's specific worry — that some other `) IS TRUE` inside C5 could survive
the wrapper's removal — is answered: there is no other one, and the unwrapped
rendering contains zero. **RT-03 fixed.**

### RT-09 — the corrected comment is now true, proven not reasoned

The comment now claims the `['different', NULL]` row is rejected by
`array_position(all_refusal_codes, NULL) IS NULL` **alone**, with the wrapper
contributing nothing. Inserting
`('policy_gate_held', 'winner', ARRAY['different', NULL])` into the
wrapper-free `TEMP` table raises
`violates check constraint "c5_nowrap_pairing"`. The row is rejected without
the wrapper, so the comment is accurate and the older attribution was not.
**RT-09 fixed.**

### Sibling sweep for the RT-02 shape

Scope: the four test files this branch adds or edits. Patterns:
`toMatch(`, `toContain(`, `not.toContain(`, `not.toMatch(`. **Zero new
siblings.** The nearest candidate is
`expect(occurredAt).toMatch(/\bONE retention clock\b/)` (`:764`), which would
match a negated comment on its own — but it is paired in the same case with
`/deletes on occurred_at and on nothing else/i`, which would not, and round 1
already hand-verified that pair against a negated comment. It is not raised
again.

`expect(refusalQuery?.text).not.toContain('business_id')`
(`purge-verification.test.ts:249`) is an absence assertion, but it is not a
proxy: "never joined through businesses" is the literal contract the branch
states, not a stand-in for a different property.

---

## Duty 3 — docs vs reality (the heavy duty this round)

`prevalidate-plan.py` is absent from this machine
(`~/.claude/skills/grill-me-codex/scripts/` has no such file), so **every
citation below was hand-resolved against HEAD** and each is named with the line
it was read at.

### RT-01 — every cell of the rewritten table checked. It is true.

The correction replaces a reason→writer partition with a writers-not-reasons
rule. Verified against the code, not against the claim:

| Type | Members | Source |
|---|---|---|
| `RenderWithholdReason` | `moderation_high`, `render_failed`, `lint_failed` | `src/lib/solicitation/outreach.ts:525` |
| `OutreachWithheldReason` | `suppressed`, `no_consent`, `no_postal_address`, `postal_address_mismatch`, `lint_failed`, `moderation_high` | `src/lib/solicitation/dispatch.ts:149-155` |

The intersection is exactly `{lint_failed, moderation_high}` — precisely the
row the correction marks **BOTH**. Row by row:

- **`render_failed` → `ask-generation.ts` only.** Written at
  `src/lib/solicitation/ask-generation.ts:425` and `:1699`; absent from
  `OutreachWithheldReason`. Anchor `rendered_at` is `TIMESTAMPTZ NOT NULL`
  (`supabase/migrations/091_send_mode_spine_lifecycle.sql:210`) and a
  repository-wide search for `rendered_at =` in `src/` and `worker/` returns
  **no assignment**, so "never updated" holds.
- **`lint_failed`, `moderation_high` → BOTH.** Render-time writes at
  `ask-generation.ts:558`, `:579` (lint) and `:600` (moderation); dispatch-time
  emission at `dispatch.ts:254-255`. The ADR's two citations —
  `dispatch.ts:149-155` and `:254-255` — resolve exactly at HEAD, and
  `dispatch.ts` is not a file this change edits, so the line form is legitimate
  here.
- **`suppressed`, `no_consent`, `no_postal_address`, `postal_address_mismatch`
  → `commitWithhold`.** `dispatch.ts:1365-1380` sets
  `agent_run_id = ${child.runId}` in the same `UPDATE` that writes
  `disposition_reason`, so "sets `agent_run_id` atomically" holds.

The `#1009` claim also resolves. Issue #1009's body carries the signature
verbatim: `occurredAt: Date | 'transaction_time'`, with "An **optional** field
would let a lane drift into the transaction stamp silently." The ADR's "This
is why" is a post-hoc framing — #1009 records its own rationale (drift into the
transaction stamp, sourced from #1006) rather than the two-writer fact — but
the operative claim, that the parameter is required with no default, is true,
and the two rationales are compatible. Not raised.

**RT-01 fixed.** The correction is not a wrong correction. Its one residual gap
is RT-13 below.

### RT-04 — NOT fixed. The intake was never converted, and says it was.

`plan.md` was converted correctly: `:278` now cites "the
`solicitation_batches` entry (cited by key: this change shifts its line)",
`:305` "the `solicitation_batches` ENTRY (cited by key, not line)", `:318`
"the `solicitation_batches` BRANCH (cited by case label, not line)".

`.feature/intake.json` (byte-identical to
`docs/superpowers/plans/…-intake.json`, both SHA-256 `3a53e31f…`) still carries
all three line citations, and the same commit that added the 23rd title left
them untouched:

| Intake | Cited | At merge base | At HEAD | Verdict |
|---|---|---|---|---|
| `:46` | `scripts/ci/tenant-tables.ts:154` | `solicitation_batches` ✅ | line 154 is `zernio_connections: ['business_id']`; `solicitation_batches` is **line 160** | **stale, and lands on a ONE-column entry while claiming to show the two-column shape** |
| `:47` | `table-disposition.ts:361-366` | the `solicitation_batches` entry ✅ | that entry is **367-373** (`table:` at 368); 361-366 is the tail of `solicitation_visits` | **stale** |
| `:48` | `purge-verification.ts:620-633` | over-wide already (620-625 is the batches branch) | `case 'solicitation_batches':` still at 620; 626-635 is now the new `refusal_events` branch | start unmoved, range now spans the new arm |

And the deviations assert the opposite, twice:

- `…-deviations.md:23` — "Corrected — and then RE-staled by this very change
  (see D14). **Now cited by symbol, not by line.**"
- `…-deviations.md:327-329` — "the intake still cited `tenant-tables.ts:158`.
  Round 1 corrected only the plan's copy. **Both now cite the
  `solicitation_batches` KEY rather than a line number**."

Neither is true of the intake at HEAD. The fix for a stale-citation finding
therefore ships a false claim that the stale citations were removed — which is
worse than leaving them, because a reader who checks the deviations stops
looking.

**Disposition `open`, P1.** Remediation is three edits to
`docs/superpowers/plans/…-intake.json` lines 46-48 (and the mirror at
`.feature/intake.json`), converting each to the symbol form the plan already
uses. Note that changing the intake changes `intake_sha256`, so the sidecar
must be regenerated with it.

### RT-06 — half fixed

`…-deviations.md:151` now reads "then **eight** probe rows", matching the
eight-row table beneath it. The second copy, which round 1 named explicitly
("repeated verbatim in the arch-review-log entry"), is untouched:
`.claude/reference/arch-review-log.md:1420` still reads "**nine probe rows, all
nine now correct**". **Open, P2.**

### RT-07 — fixed

CONTEXT.md now says the Restraint tab is "the second of the two tabs
`/dashboard/analytics` **WILL** carry" and "**Not built yet**: #1014 ships it,
and the route today has no tab UI". Both halves resolve:
`src/app/(authenticated)/dashboard/analytics/page.tsx` is five lines and
renders `<AnalyticsContent />` with no tab markup, and a search for
`role="tab"`/`tablist`/`Tabs` under that route returns nothing. `gh issue view
1014` returns OPEN, "Restraint tab: report, archived-location footnote,
archived-period line". **Fixed.**

### RT-10 — fixed

The ADR's replacement text makes three checkable claims, all true:

- "Migration 111's `solicitation_outreach_status_reason_consistency` admits
  `admin_halt` and `platform_halt` on the **cancelled** arm only" —
  `supabase/migrations/111_platform_halt_reason.sql:97-100` lists them under
  `delivery_status = 'cancelled'`; the withheld arm (`:92-96`) does not.
- "`latchHalt` copies a batch's halt reason through to every affected Outreach
  row as its `disposition_reason`" — `src/lib/solicitation/approval.ts:543-552`
  sets `delivery_status = 'cancelled', disposition_reason = ${input.reason}`
  for rows `IN ('rendered', 'queued')`.
- "the same code string appears on two different tables" — the same function
  writes `solicitation_batches.halt_reason` (`:529-531`) and the outreach
  `disposition_reason`.

**Fixed.**

### RT-12 — one of three fixed

- **`108'S` typo** — `.claude/reference/migrations-log.md:2605` now reads
  `108's`. ✅
- **The §II.5 attribution** — round 1 located this in "the arch-review-log
  entry". `migrations-log.md:2584-2587` gained a correcting sentence; the
  arch-review-log's copy — "production DDL ahead of the PR, i.e. unreviewed
  CI-ungated SQL, which `deployment-guide.md` §II.5 exists to prevent"
  (`:1420`) — is unchanged. And the new sentence introduces its own
  over-attribution (RT-15).
- **"eleven Refusal write sites"** — `…-intake.json:8` still reads "Any of the
  eleven Refusal write sites (**#1010, #1011, #1012, #1013**)", while
  `supabase/migrations/116_refusal_events.sql:14` reads "first caller land in
  **#1009**; the **other ten** write sites in #1010-#1013". One of the eleven
  is in #1009; the intake puts all eleven in #1010-#1013. Unchanged by the fix
  commit.

**Open, P2.**

### RT-13 (NEW, P2) — the rewritten table drops the eighth withheld reason

Migration 111's withheld arm has **eight** members
(`111_platform_halt_reason.sql:92-96`): `moderation_high`, `render_failed`,
`lint_failed`, `no_consent`, `suppressed`, **`unsubscribed`**,
`no_postal_address`, `postal_address_mismatch`.

The superseded table covered all eight — three named, "the other five" implied,
`unsubscribed` among them. The replacement enumerates **seven** and omits
`unsubscribed` silently.

Why it is P2 and not higher: `unsubscribed` has **no writer** in the codebase.
`src/lib/solicitation/outreach.ts:520-522` reserves it as a dispatch-time fact,
`dispatch.ts:146` says it is "written by other lanes", and a repository-wide
search finds no site writing `disposition_reason = 'unsubscribed'`. So there is
no anchor to state and no writer to mislead — the old row's attribution of it
to `commitWithhold` was in fact false, and dropping it is a net improvement.
But the table reads as exhaustive over the withheld arm and is not, and the
lane the whole section exists for is `outreach_withheld`. One sentence
("`unsubscribed` has no writer today, so it has no row") closes it.

### RT-14 (NEW, P2) — the 23rd title staled two count claims in the same commit

`6a7fc650` added `"C5 carries both NULL defences structurally, including the
one no row can reach"` to `tests_to_add`, taking it from 22 to 23
(`jq '.tests_to_add | length'` returns 23). Two artifacts still state 22:

- `.claude/reference/arch-review-log.md:1420` — "**22 promised tests**, all
  present verbatim"
- `docs/superpowers/plans/…-plan.md:54` — "Author all **twenty-two**
  `tests_to_add` titles as runnable failing tests."

The second is an instruction, so a reader executing the plan writes 22 of 23.
This is D14's own lesson applied to a count instead of a line number, in the
commit that wrote D14.

### RT-15 (NEW, P2) — the §II.5 correction over-attributes

The new sentence (`.claude/reference/migrations-log.md:2584-2587`) reads:

> `deployment-guide.md` §II.5 establishes the PR-first, staging-DDL-before-staging-deploy shape; the production-DDL-before-merge step is this branch's own inference from it plus the `42P01` hazard, not a sentence that section states.

The operative half is **correct**: §II.5 (`docs/runbooks/deployment-guide.md:1142-1180`)
nowhere states production DDL before merge. But the half it *does* attribute is
also not what §II.5 says. §II.5 step 1 gives PR-first ✅. Its migration bullet
gives "Apply it to the **staging Supabase** first and verify there **before it
ever runs against prod**", and its closing paragraph gives "every migration runs
against **both** Supabase projects … **staging first**". Both are
staging-DDL-before-**production**-DDL, not staging-DDL-before-the-staging-**deploy**.
Nor does §2a (`:369-403`) state it. A correction that trades one
misattribution for a smaller one is still a misattribution, which is exactly
the failure this round was told to hunt for.

### RT-16 (NEW, P2) — the round-1 sidecar committed at HEAD would have failed the checker

Running the checker's own pure validators over the `findings.json` committed in
`6a7fc650`:

```
shape errors:
  findings[10]: unknown field 'rejected_reason'
  findings[10]: a rejected finding must carry its one-line verdict
  authorizations[0]: unknown field 'approval_text'
  authorizations[0].text must carry the verbatim approval
recomputed status: CLEAR   declared: OPEN_P0
count mismatch p0_open declared 1 actual 0   p1_open declared 4 actual 0
count mismatch p2_open declared 7 actual 0   accepted_risk declared 0 actual 2
count mismatch fixed  declared 0 actual 9    rejected declared 0 actual 1
```

The schema names the fields `reason` and `text`; the sidecar used
`rejected_reason` and `approval_text`. Separately, `findings.md` at HEAD was
never updated alongside it — its severity table marks all twelve findings
`open`, its counts line says "all `open`, none accepted-risk", and its
Authorizations section says "**None.** No finding in this report is
`accepted-risk`", while the JSON records nine fixed, two accepted-risk under
`AUTH-1008-01`, and one rejected. The skill requires the md's Authorizations
section to be *rendered from* the array and a rejection verdict to be
*appended to* the md; neither happened.

This round's write replaces both files with a consistent, schema-valid pair, so
the defect exists only in the `6a7fc650` tree state. Recorded because it is a
real inconsistency inside the fix hunk and because it is the fifth instance of
this commit's one-copy-of-two defect class.

---

## Duty 4 — missed sibling cases

Three patterns searched. Scope and exclusions recorded so the searches can be
re-run.

**Pattern 1 — an assertion that passes on its own negation.** Patterns
`toMatch(`, `toContain(`, `not.toContain(`, `not.toMatch(`. Scope: the four
test files this branch adds or edits
(`table-disposition.test.ts`, `purge-verification.test.ts`,
`migration-116-refusal-events.integration.test.ts`,
`offboarding-lifecycle.integration.test.ts`). Excluded: every test file the
branch does not touch. **Zero new siblings** — see Duty 2 for the one
near-match and why it stands.

**Pattern 2 — a `path:line` citation into a file this change edits.** Regex
`[A-Za-z0-9_./{}-]+\.(ts|tsx|sql|sh)`?:[0-9]+(-[0-9]+)?` over
`arch-review-log.md`, `migrations-log.md`, `CONTEXT.md`, ADR 0023, the plan,
the deviations, the intake and the migration, intersected with
`git diff --name-only <merge-base>..HEAD`. **Three hits, all in the intake** —
RT-04. Everything else resolves:
`scripts/ci/__tests__/rls-audit.test.ts:42-49` is exactly the
`REQUIRED_RLS_TABLES === TENANT_TABLES` case at HEAD;
`worker/jobs/account-offboarding/PurgeWorker.ts:96-105` is the
retry/terminal branch; `dispatch.ts:149-155` and `:254-255` are exact. The two
`tenant-tables.ts:158` hits in the deviations are historical narrative about
the old value, not live citations. **The new arch-review-log entry contains no
line citation at all**, which is the right form.

**Pattern 3 — a count or a claim duplicated across artifacts, corrected in
one.** Searched `nine probe|eight probe`, `22 promised|twenty-two`, `eleven`,
plus a diff of dispositions between the two report artifacts. **Four hits:**
RT-06, RT-12(b), RT-12(c), RT-14, RT-16. This pattern is the one that pays,
and it is the reason the through-line above leads the report.

---

## Duty 5 — operational completeness

The fix commit adds **no terminal or swallowed failure path** — it contains no
production code. Duty 5 therefore reduces to re-resolving the two carried
findings.

Both re-resolve unchanged at HEAD:

- `worker/jobs/account-offboarding/PurgeWorker.ts:114` still emits
  `Sentry.captureMessage('account_offboarding_purge_failed', { level: terminal
  ? 'error' : 'warning', tags: {…} })` — one constant message for both arms, no
  fingerprint.
- `grep -n "account_offboarding" docs/runbooks/beta-launch-alerting.md` returns
  **nothing**. All six facets (signal identity, filter, level, grouping title,
  threshold/cadence, destination action) remain missing.

The authorization resolves: `AUTH-1008-01`, dated 2026-08-29, names RT-05 and
RT-08, and its follow-up is real —
`gh issue view 1016` returns OPEN, "account_offboarding_purge_failed is emitted
but routed by no alerting rule", with a body that reproduces the six-facet gap,
the `attachJobFailureSink` non-firing analysis and RT-08's fingerprint
constraint. **Both stay `accepted-risk`.**

---

## Inventory

Rows INV-01 … INV-22 are round 1's, carried forward with their outcomes;
INV-20 was **re-executed at HEAD in round 2** against a new mutation and killed
again. INV-23 is this round's only new candidate.

| ID | Test | Outcome |
|---|---|---|
| INV-01 | migration 116 runs as one transaction and bounds its lock acquisition with SET LOCAL lock_timeout | excluded |
| INV-02 | TENANT_TABLES scopes refusal_events by account_id and business_id | killed |
| INV-03 | migration 116 enables row level security on refusal_events and defines zero policies | excluded |
| INV-04 | migration 116 creates the twelve locked columns … | excluded |
| INV-05 | migration 116 creates foreign keys only to accounts and businesses … | excluded |
| INV-06 | migration 116 creates the archival, account-window and partial-unique indexes … | excluded |
| INV-07 | migration 116 comments the table and all twelve columns … | excluded |
| INV-08 | C1 wraps its total source-to-subject CASE in IS TRUE … | excluded |
| INV-09 | C1 rejects every lane paired with a subject_type the locked mapping does not give it | excluded |
| INV-10 | C2 rejects a typed subject with no id, and an id with no subject_type | excluded |
| INV-11 | C3 rejects an account-wide row that is not autonomy_suspended … | excluded |
| INV-12 | C4 rejects a held_draft row carrying a refusal_code … | excluded |
| INV-13 | C5 rejects policy_gate_held rows whose all_refusal_codes is null, empty … | excluded |
| INV-14 | C5 admits a policy_gate_held row whose all_refusal_codes carries codes the database does not know … | excluded |
| INV-15 | a canonical valid row for every one of the seven lanes satisfies all five CHECK constraints | excluded |
| INV-16 | the refusal_source, refusal_category and subject_type CHECKs admit exactly … | excluded |
| INV-17 | an ON CONFLICT clause re-spelling the partial predicate byte-for-byte … | excluded |
| INV-18 | the same (refusal_source, subject_id) inserted twice yields one row … | excluded |
| INV-19 | two autonomy_suspended rows for one account both persist … | excluded |
| INV-20 | classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent | **killed (re-executed at HEAD)** |
| INV-21 | purge verification counts refusal_events rows for the target account … | killed |
| INV-22 | the content purge stage deletes refusal_events rows for the purged account … | killed |
| INV-23 | C5 carries both NULL defences structurally, including the one no row can reach | excluded |

No row is `inconclusive` and none is `skipped-budget`, so no INCOMPLETE_* status
fires.

---

## Authorizations

*Rendered from `findings.json`'s `authorizations` array. Not parsed back out of
this Markdown.*

**`AUTH-1008-01`** — 2026-08-29 — covers **RT-05**, **RT-08**.

> Accept the risk, file a follow-up. Rationale: the gap predates this branch,
> the failure path is only reachable in a window the ship order already closes
> (production DDL lands before the code), and a runbook rule is a distinct
> piece of ops work that deserves its own review rather than being appended to
> a schema PR. Follow-up filed as RepWorth/ai-review-responder#1016.

Re-resolved this round: #1016 exists and is OPEN.

---

## Rejections

**RT-11 (P2) — rejected.** Verdict, mirrored in `findings.json`:

> Deliberate defence in depth, not dead weight. `all_refusal_codes IS NOT NULL`
> and `cardinality(...) > 0` at
> `supabase/migrations/116_refusal_events.sql:160-161` are redundant only GIVEN
> the sibling clauses that currently stand; each states one fact the reader
> needs, and removing them would let a later edit to `array_position` or to C4
> silently widen the constraint. The same reasoning applies to C5's outer
> `IS TRUE`, which RT-03 showed is equally unreachable by any row and which is
> now pinned STRUCTURALLY rather than deleted.

**Outstanding protocol obligation:** the skill also requires a rejected finding
to be listed in a "Red-team findings rejected" section of the PR description.
`gh pr list --head feat/1008-migration-116-refusal-events` returns empty — no
PR exists yet — so this is a pending obligation for whoever opens it, not a
defect at HEAD.

---

## Appendix — out of scope, P2, does not move `status`

- **`updated_at` as the `commitWithhold` fallback.** ADR 0023's closing
  paragraph survives the rewrite unchanged: `updated_at` "survives only as the
  fallback for a dispatch-time withhold whose best-effort lazy-child attach
  left `agent_run_id` NULL". `commitWithhold` (`dispatch.ts:1365-1380`) sets
  `agent_run_id = ${child.runId}::uuid` unconditionally from `startLazyChild`,
  so the NULL case is not visible at that call site. The sentence predates this
  change and its content is untouched by the fix hunk, so it is recorded rather
  than raised.

- **`red-team-status.mjs` mis-slices the first `git status --porcelain` line,
  and will report a false unrestored mutation.** `makeGit` ends with `.trim()`
  (`.agents/skills/feature/scripts/red-team-status.mjs:442-449`), which strips
  the leading space of the FIRST porcelain line. The restored-mutation check
  then does `line.slice(3)` (`:708`) and compares against
  `<reportDir>/findings.md` / `<reportDir>/findings.json`, so the first line
  slices to `ocs/reviews/…` and never matches. Observed at HEAD: with both
  report artifacts modified and **no** mutation applied, the checker emits

  > the worktree carries 1 tracked modification(s) outside this run's report —
  > a mutation may not have been restored: M docs/…/findings.json

  Whichever artifact git lists first is always falsely reported. The file is
  **not touched by this branch** (`git log 5ab6bfee..HEAD -- <path>` is empty),
  so it is strictly out of round-2 scope and is recorded here rather than
  raised. It matters operationally: the `reviewed` transition will show this
  message even after `finalize` restores everything correctly. One-line fix —
  drop the `.trim()` for this call site, or use `--porcelain=v1 -z` and split
  on NUL.

---

## Finalizer state — READ THIS

`node .agents/skills/red-team/scripts/mutation-runner.mjs finalize` was **NOT
run**, per the invoking agent's instruction.

**No mutation is left applied.** The one mutated path,
`src/lib/account-offboarding/table-disposition.ts`, was restored to its HEAD
blob with a named-path `git checkout --`, and `git hash-object` on it returns
`060c260bd434`, matching the journal's `originalOid`. `git status --porcelain`
is empty except for this run's two report artifacts. `finalize` will therefore
see the original OID on that path and record it done without touching the file
— the documented "original OID means done" path, not an abort.

**Two things still require `finalize`:**

1. The journal entry for that path is still `state: "applied"`, and the checker
   fails while any open journal entry exists.
2. The dotenv swap is **open** — `.env.local` currently holds the scrubbed
   replacement and `.env.local.red-team-backup` holds the original. The checker
   fails while any dotenv backup exists. `.env*` is gitignored, so this is
   invisible to `git status`.

Exactly one journal entry exists for one path, so `restoreMutations` has the
unambiguous case it needs.
