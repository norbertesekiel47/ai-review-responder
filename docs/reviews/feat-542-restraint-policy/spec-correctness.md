# Spec & correctness review — feat/542 restraint-policy

- **Branch diff reviewed:** `git diff main...HEAD` (commits `ad9b8c07`, `57753095`)
- **Files:** `src/lib/solicitation/restraint-policy.ts` (317 LOC), `src/lib/solicitation/__tests__/restraint-policy.test.ts` (383 LOC), spec footnote, plan + deviations + intake copy under `docs/superpowers/plans/`
- **Authorities:** `.feature/intake.json` · spec `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md` · ADR `docs/adr/0012-sentiment-blind-withhold-enum.md` · plan `docs/superpowers/plans/2026-07-23-restraint-policy-module.md` + `feat-542-restraint-policy-deviations.md`
- **Verification run by reviewer:** `pnpm vitest run src/lib/solicitation` → **32/32 pass**; `pnpm typecheck` → clean; behavioral probes via `tsx` (offset-ISO date arithmetic, mapper cross-hits, over_contacted-in-over-cap-batch) — outputs cited inline below.

## Verdict

Conformant with the locked spec, ADR 0012, and the intake contract on every
enum, precedence, window, cap, tie-break, and evidence-field check. Three
Minor findings survived the ≥80% confidence filter — one latent
date-semantics contract mismatch in the module, two test-coverage gaps vs
the intake's `tests_to_add`. No Major or Critical findings.

## Findings table (≥80% confidence only)

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | Minor | `src/lib/solicitation/restraint-policy.ts:99` (and `:191–197`) | Documented contract says "'Today' for gate arithmetic is its **UTC date**", but `utcDayNumber` uses the *written* date part of the ISO string. For a legal non-Z-offset input the two diverge: probe showed `decidedAt: '2026-07-23T20:00:00-07:00'` (UTC day 07-24) → `send`, while the same instant as `'2026-07-24T03:00:00Z'` → `withhold(stale_visit)`. Off-by-one-day on `stale_visit`/`over_contacted` whenever a caller passes an offset timestamp (e.g. Postgres `timestamptz::text` under a non-UTC session TZ). The slice-parse itself is plan-sanctioned (plan Task 1 Step 3 + deviations doc), so this is a *contract-doc vs behavior* mismatch, not a plan deviation. Fix is cheap while #543 (the only future caller) is unbuilt: either narrow the `BatchContext.decidedAt` / `priorBatch.decidedAt` precondition to UTC-normalized (`Z`) timestamps, or normalize via `Date` UTC getters. |
| 2 | Minor | `src/lib/solicitation/__tests__/restraint-policy.test.ts:360–373` | Intake `tests_to_add[7]` requires the fast-check property "**banked+sent partition the surviving pool** with \|sent\| ≤ cap". The delivered property asserts only the weaker `sends ≤ cap` and `banked > 0 ⇒ sends == cap`; it never computes the surviving pool (per-candidate `evaluateAsk == send`) and asserts banked ∪ sent equals it. The concrete overflow test (lines 265–285) covers one partition instance, but the property as contracted is not implemented. (Code itself partitions correctly — verified by probe.) |
| 3 | Minor | `src/lib/solicitation/__tests__/restraint-policy.test.ts:227–239` | Intake precedence item asks for "pairwise earlier-gate-wins cases". Four of the five adjacent pairs are covered by the sequential-stripping test; the fifth — `over_contacted` beats `velocity_banked` (a per-candidate withhold inside an over-cap batch must NOT be converted to `velocity_banked`) — has no deterministic test. Probe confirmed the code is correct (27-candidate batch, candidate with recent `priorBatch` → `over_contacted`; sends 25, banked 1), so this is coverage-only. |

## Conformance evidence — field by field

### Intake contract (`.feature/intake.json`)

| Item | Verdict | Evidence |
|---|---|---|
| Goal: pure `evaluateAsk`/`evaluateBatch`, closed enum, precedence, windows, banking, typed evidence | PASS | `restraint-policy.ts:209` / `:286`; zero import statements — the module cannot touch DB, clock, or LLM |
| Non-goal: no worker/poller/UI | PASS | diff touches only `src/lib/solicitation/**` + docs |
| Non-goal: no DB access / no `sql` param | PASS | no imports at all; context fully caller-loaded (`BatchContext`, `:98–103`) |
| Non-goal: no decision storage / no suppression ledger / no LLM / no `recent_negative` / no schema change | PASS | grep of diff: no `recent_negative`, no migration, no LLM/task-seam import |
| Invariant: sentiment-blind by construction | PASS | `AskCandidate` (`:83–96`) and `WithholdEvidence` (`:111–129`) contain no sentiment/rating/star/review-content field; `already_reviewed` evidence = `review_id` + `review_date` only (`:230–237`); runtime assertions at test `:159`, `:375–382` |
| Invariant: closed enums — six reasons, eight verticals | PASS | `:26–47`; contract-tested exactly (`test:35–58`) |
| Invariant: first-match precedence, one reason per withhold | PASS | gate order in `evaluateAsk` `:216–266` matches `no_consent → suppressed → already_reviewed → stale_visit → over_contacted`; `velocity_banked` last and batch-only (`:286–317`); tested `:227–239` |
| Invariant: pure/deterministic, `decided_at`/today from context | PASS | no `Date.now`/`new Date()` in module; `decided_at = context.decidedAt` (`:213`); fast-check determinism property `:338–344` |
| Invariant: evidence by candidate ID only, PII never duplicated; envelope on every snapshot | PASS | envelope `:134–138` = `contact_id` + `policy_version` + `decided_at`; no name/email/phone fields exist on any type; property `:375–382` |
| Invariant: `stale_visit` strictly greater than window | PASS | `daysSinceVisit > windowDays` (`:244`); boundary tests `:162–189` (window day → send; window+1 → withhold) for `food_and_drink` and `other` |
| Invariant: banking most-recent-first, cap 25 tunable, UUIDv7 row-ID ascending tie-break, total order | PASS | `byBankingPriority` `:272–277` — lexicographic on `YYYY-MM-DD` (== chronological), descending recency, `contactId` ascending tie-break, returns 0 only on full equality → total; `BATCH_CAP = 25` in the tunable-constants block (`:68`); tests `:265–297` |
| Invariant: vertical mapper pure/deterministic, fallback `other`, resolved vertical + matched keyword in evidence | PASS | `resolveVertical` `:171–183`; `stale_visit` evidence carries `vertical` + `matched_keyword` (`:250–252`); determinism property `:102–108` |
| Edge cases (all 8) | PASS | empty batch `:254–256`; boundary-fresh `:164–165`; unmapped→`other`/null keyword `:179–189`; multi-fail→first reason `:227–239`; cap-exact + under-cap no-op `:258–263`; overflow full evidence `:265–285`; same-date tie `:287–297`; bare-envelope send `:112–119` |
| `tests_to_add` | PARTIAL | items 1–7 delivered (six per-reason contract tests incl. the two can't-fire codes; precedence; two-vertical boundary + window table; ≥1 keyword per mapped vertical + fallback; banking order/tie/cap; typed+runtime sentiment-blindness; determinism/envelope/PII properties). Item 8's partition property weaker than contracted → **Finding 2**; pairwise `over_contacted`→`velocity_banked` untested → **Finding 3** |
| `allowed_edit_surface` | PASS | diff = `src/lib/solicitation/**` (2), the spec doc (footnote only), `docs/superpowers/plans/**` (3). Nothing else touched |
| `user_visible_behavior[1]` — spec footnote | PASS | footnote added verbatim under §1 (`spec:42–48`), matches intake description (blocking attestation, upload-FK provenance, enum-stability rationale, #531 §6.1 reference) |

### Spec §4 evidence shapes — snake_case verbatim

| Reason | Spec fields | Module (`restraint-policy.ts:111–129`) | Verdict |
|---|---|---|---|
| `stale_visit` | `last_visit_date`, `days_since_visit`, `vertical`, `matched_keyword`, `freshness_window_days` | identical | PASS |
| `already_reviewed` | `review_id`, `review_date`, never star rating | identical; no rating anywhere | PASS |
| `over_contacted` | `prior_batch_id`, `prior_decision_at`, `min_gap_days` | identical | PASS |
| `no_consent` | `upload_id`, coverage semantics "finalized in #535" | `upload_id` only — coverage field deferred; sanctioned (plan `:393`, footnote: cannot fire in v-watch) | PASS |
| `suppressed` | `suppression_source`, `suppressed_at` | identical | PASS |
| `velocity_banked` | `batch_cap`, `eligible_count`, deterministic ordering basis | identical + `ordering_basis: { last_visit_date, contact_id }` | PASS |

### Spec §3.2 windows / §5.3 cap

`FRESHNESS_WINDOW_DAYS` (`:56–65`) matches the spec table value-for-value
(14/14/21/21/30/30/45/30); asserted verbatim at test `:60–71`. `BATCH_CAP = 25`
(`:68`), tested `:73–76`.

### ADR 0012

PASS. No sentiment/rating/star field on any input or evidence type; no
`recent_negative` string anywhere in the diff; `already_reviewed` fires on
review existence only. Structural (type-level) + runtime (JSON regex)
assertions both present.

### Sanctioned deviations (plan + deviations doc)

- `MIN_GAP_DAYS = 30` — spec gap, plan-decided (`plan:16`, flagged for PR
  description), boundary "exact gap allowed" plan-locked (`plan:17`); module
  matches (`:76`, `< MIN_GAP_DAYS` at `:257`).
- `utcDayNumber` fixed-position `Number(date.slice(...))` — deviations doc
  entry 1 (strict-TS rewrite of plan's destructuring; same date-part
  semantics).
- Batch test `as string` on `sort()[0]` — deviations doc entry 2.

No unsanctioned deviations found.

## Correctness hunt — checks performed, no defect found

- **Comparator totality:** `byBankingPriority` is a total order (string
  compare on equal-length `YYYY-MM-DD` + full-inequality tie-break returning
  0 only for identical keys); no NaN/undefined paths.
- **Cap off-by-ones:** `eligible.length <= BATCH_CAP` → nothing banked
  (cap-exact and under-cap both no-op, per intake); `.slice(0, BATCH_CAP)`
  keeps exactly 25.
- **Regex mapper:** all 90 keywords are lowercase letters/spaces — no regex
  metacharacters, so the unescaped `new RegExp('\\b' + keyword)` is safe and
  deterministic today (see appendix for the robustness note). Ordering
  (specific-first, retail last) prevents the tested `barber`-vs-`bar` trap;
  `\b` left boundary prevents `car`→`carpet`-class hits; probe confirmed
  `electric` does NOT match "Electronics Store" (→ retail via `store`).
- **Date arithmetic:** `Date.UTC(...)/86_400_000` is exact integer day
  arithmetic (UTC has no DST); day-boundary tests pass on both sides of two
  different windows. The only issue found is the offset-input contract
  mismatch (Finding 1).
- **Input-order preservation and non-conversion of per-candidate withholds
  in over-cap batches:** probe-verified (Finding 3 is test-coverage only).
- **Purity:** module has zero imports; no `Date.now`, no randomness, no
  mutation of caller inputs (`eligible.map(...)` copies before `.sort`).

## Low-confidence appendix (NOT findings — below the 80% bar)

- **Unescaped keyword interpolation into `RegExp`** (`:176`): safe with
  today's constant list, but a future keyword containing a metacharacter
  (e.g. `"7-eleven"` is fine, `"a+ auto"` is not) would silently change
  match semantics or throw. A `RegExp.escape`-style guard or a lint-time
  assertion on the keyword table would make the table safely tunable.
- **Property-test contactId collisions** (`test:314`): `hex12` draws from a
  24-bit space; ~60-candidate batches over 100 runs give a ~1% chance of a
  duplicate `contactId`, for which `evaluateBatch`'s `kept` Set could mark
  two rows send and (in an over-cap batch) exceed the cap — a rare flake in
  the "sends never exceed the cap" property, and duplicate-row-ID input is
  precondition-violating anyway. Widening to 48 bits or `fc.uuid()` removes
  the possibility.
- **`BATCH_CAP` "in the same table as the freshness windows"** (spec §5.3,
  intake): implemented as a sibling constant in the same tunable-constants
  block rather than literally inside one record — reasonable reading of
  "table"; noted only for literalism.
- **Mapper cross-vertical hits** by design remain visible-not-silent per
  spec §3.1 (probe: "Barre Studio" → `food_and_drink` via `bar`, "Pet Food
  Store" → `food_and_drink` via `food`). Both misclassifications land on the
  same 14-day window as their plausible correct vertical today, so no
  behavioral delta; evidence records the matched keyword either way.
- **`resolveVertical` recomputed per candidate** inside `evaluateAsk`
  (`:242`) though the category is batch-constant — pure and correct, just
  O(candidates × keywords) regex constructions; a batch-level memo in #543's
  caller (or hoisting into `evaluateBatch`) is a trivial perf cleanup if
  batches grow.
