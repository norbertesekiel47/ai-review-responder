# Plan review round 4 — codex adversarial (read-only, narrow) — APPROVED

**Ticket:** #680 · **Reviewer:** `codex exec --sandbox read-only` (codex-cli 0.145.0)
**Brief:** `<b2dde277>/codex-plan-brief-680-r4.md` · **Raw transcript:** `<b2dde277>/codex-plan-review-680-r4.jsonl`
**Audited at:** clean `HEAD a27fa363`
**Verdict:** `APPROVED` — **zero findings.**

## Why a fourth round existed

Deliberately past the normal 3-round cap, authorised by the owner for one reason: the F18/F19 fixes
were applied but reviewed by no one, and rounds 2 and 3 had each found their blocker-class defects
in the *fixes* rather than the plan. F18 was the sharpest case — a statement that read exactly like
its remedy and did nothing. Scope was therefore **F18 and F19 only**; everything else was settled.

## Trajectory

| round | verdict | findings | blockers |
|---|---|---|---|
| 1 | REVISE | 10 | 1 |
| 2 | REVISE | 7 | 2 |
| 3 | REVISE | 2 | 0 |
| 4 | **APPROVED** | **0** | 0 |

19 findings raised across four rounds; **all 19 accepted after independent verification, none ever
rejected.**

## What round 4 confirmed

**F18 — the remedy is correct.** Bare `SET` governs the later `DO` and `ALTER` under **both**
autocommit `psql` and transaction-wrapped execution, which is exactly why `SET LOCAL` was the wrong
form: it works only inside a transaction. Specifics:

- Explicitly listing `pg_temp` **after** `public` gives `public` precedence for relation resolution
  — this is what closes the F13 hijack, since Postgres searches the temp schema first only when
  `pg_temp` is absent from `search_path`.
- Dropping `"$user"` from the default is intentional and safe for a public-schema migration.
- The stated leak boundary is **complete**: local/CI use a fresh psql process per migration, while
  any later SQL sharing the session inherits the setting — which is what the header now says.

**Correction to a claim made during this session:** the remote apply path is the **manual SQL
Editor**, *not* the Supabase CLI or MCP as previously assumed. The F18 conclusion is unaffected —
either transaction mode preserves the setting through the batch — but the premise was wrong and is
corrected here so the next reader inherits the right one.

**F19 — accurate.** `to_regclass`, the guard's unqualified `FROM`, and the `ALTER` all resolve
`public` during a real apply. T1 tests 3–4 remain valid: they execute only the extracted `DO` inside
a transaction under their own `SET LOCAL search_path = pg_temp, public`. The retitled test correctly
describes the four-statement body and its exact normalized-text assertion. `cmp` confirms both
intake copies byte-identical, hashing to `149fb035d119fb551fcf0624898315eaeef021df46cba953c3925da4273a80f1`
— matching `.feature/state.json:8` exactly.

## Outcome

**Plan APPROVED.** Phase advances to `plan_approved`; T1 → T2 → T3 execute in-session per the owner
decision (no per-task subagent dispatch — the tasks are serial and mechanical). Step 7 review agents
are still wanted, and will see the actual migration SQL and tests rather than a plan describing them.
