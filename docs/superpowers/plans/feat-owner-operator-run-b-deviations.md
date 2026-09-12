# Deviations — feat/owner-operator-run-b

Every entry is something the locked intake or the plan did not anticipate. The step-6 read-back gives each a **Verdict:** line (ACCEPT or RE-PLAN) before the review wave dispatches.

## Surface amendment #1 — 2026-09-12, plan review (root)

- **What:** the Operator page moves from `src/app/(authenticated)/operator/` to `src/app/(authenticated)/dashboard/operator/` (URL `/dashboard/operator`), and `src/components/dashboard/shell/__tests__/*.ts` joins the surface.
- **Why:** proxy branch 7 (`src/proxy.ts:366-385`) hardcodes `/dashboard`, `/settings`, `/account` as the owner-page prefixes that get the login redirect, the role check and the AAL2 gate, and `src/proxy.ts` is outside the surface. A top-level `/operator` would render for an AAL1 owner under MFA enforcement while every `/api/operator` call answered 403 (plan V3). Under `/dashboard/` the page rides branch 7 with no proxy change and matches every other owner feature. The `shell/__tests__` entry lets the `'operator'` `NavSection` case land in the existing `active-nav.test.ts` instead of a duplicate sibling test file (plan V4).
- **Owner decision:** "Move the page to /dashboard/operator" (AskUserQuestion, 2026-09-12). Spec §3.1's route line is corrected in T6 with the Island→Console correction.
- **Counted:** `feature-state.sh incr-amendment` (#1, auto-approved as the first).
- **Verdict:** ACCEPT

## Baseline gate on the untouched tree — 2026-09-12 (root, before T0)

- **What:** `verify-gate.sh --baseline` at `6edacd0b0` + docs is RED on two rows only: `feature-surface` (every new-file entry matches nothing yet — expected before T0 lands, per `ci:feature-surface`'s own message) and `pnpm test:e2e` (16 failures, all `e2e/admin-14b-runtime.spec.ts` / `admin-14c-runtime.spec.ts`).
- **Why the e2e row is red:** environmental, not a Run B defect. The admin login page throws `ADMIN_APP_URL must be a configured HTTP(S) origin…` (`src/lib/config/admin-app-url.ts:8`) because the local environment has no `ADMIN_APP_URL`; CI's e2e job sets `ADMIN_APP_URL: https://admin.example.invalid` (`.github/workflows/e2e.yml:44`, `:87`). The other 28 e2e cases pass; 116 self-skip (auth harness).
- **Correction (verification command, not a surface change):** every gate run in this worktree exports `ADMIN_APP_URL=https://admin.example.invalid` in the gate's environment so the Playwright web server inherits it, exactly as CI does. No repo file changes.
- **Verdict:** ACCEPT

## Codex plan round 1 — 2026-09-12 (root)

- **What:** Codex returned REVISE with 11 findings (RB-01…RB-11), all verified against source and ACCEPTED; the planner is revising the plan. Ten new `tests_to_add` titles were added to BOTH intake copies (an intake correction, not a surface change; the surface is unchanged). The findings are archived at `~/.claude/grill-codex/run-b-2026-09-12/round-1-findings.json`.
- **Runner note:** the runner marked the round `failed` because the worktree's Codex Stop hook blocked Codex's turn on the red baseline gate (feature-surface entries cannot match before T0), after which Codex emitted a final JSON with an empty findings list; the complete review was recovered from the event log (`stdout.txt`). No session id was recorded, so a verification round cannot resume — it starts fresh with the findings-and-fixes delta in its brief, and its review is recovered the same way if the hook blocks again. The hooks stay as they are.
- **Verdict:** ACCEPT

## T3 — 2026-09-12

Seven departures from the plan's literal T3 code. None changes a behaviour the plan
locked; each is either impossible-as-written before T2 lands, or a line the plan's own
T3 test contradicts.

1. **The client declares the wire shapes locally instead of importing them.** The plan's
   `OperatorClient.tsx` imports `OwnerConversationTurn` / `OwnerConversationView` from
   `src/lib/agents/operator/reads.ts`, but the three fields it reads — a turn's
   `locationId`, a turn's `unsupported`, and a NULLABLE `conversation` — are exactly what
   T2 Step 19 / RB-09 add, and T2 runs in PARALLEL with T3. Against HEAD the plan's code
   does not typecheck (`turn.unsupported` does not exist; `loaded === null` is TS2367 on a
   non-nullable type). `TranscriptTurn` / `ConversationViewBody` are therefore declared in
   the client, which is an HTTP consumer of that JSON either way;
   `OwnerConversationSummary` is still imported, because it is passed straight through to
   `SummaryPanel` unread.
2. **`RequestedCapabilityCard`'s placeholder also renders `CANNOT_DO_YET`.** The plan's
   Step 2 placeholder renders only the request line, and its own Step 4 case R7 asserts
   `getByText(/cannot do this yet/i)`. One sentence added; T4 still owns the body.
3. **`ALL_LOCATIONS_HINT` appears once, not twice.** The plan renders it BOTH in the
   `All locations` chooser card and, via the `hint` prop, in `SummaryPanel` — and its own
   case 34 asserts `getByText(/pick one location/i)` (singular), which throws on two
   matches. The panel keeps the sentence (`hint` is unchanged, so T5's contract is
   untouched); the chooser card carries a `Choose a location` heading above its buttons
   instead.
4. **No `setState` in an effect body.** `react-hooks/set-state-in-effect` is `error`
   repo-wide. The plan's `setView(null)` in the conversation effect's `fresh` branch is
   dropped — `startNewConversation` already empties the view, so the effect only declines
   to refill it — and the plan's `setTimedOut(false)` before `void poll()` moves into the
   successful-POST branch, which is the one path that starts a new wait without going
   through `keepWaiting`.
5. **`onChooseLocation` routes through `asLocationId`.** `setLocationScope` takes
   `LocationScope` (`'all' | LocationId`), so passing it directly as
   `(id: string) => void` fails `strictFunctionTypes`. A stored `scope_check` id off the
   wire is a plain string; the roster's own ids stay `LocationId` and are passed
   unchanged.
6. **The plan's `eslint-disable react-hooks/exhaustive-deps` is omitted.** Its rationale
   says "`turnId` is READ above", but the effect reads `activeTurnIdRef.current`, never
   the state, so the dependency array is already exhaustive and the directive would be
   unused. The explanatory comment is kept.
7. **Two `!` in the R7 case.** `TURN_FAILURE_WORDING` is `Record<string, string>` and
   `noUncheckedIndexedAccess` widens `.exhausted` to `string | undefined`, which
   `findByText` rejects.

- **Verdict:** ACCEPT

## T4 — 2026-09-12

Four departures from the plan's literal T4 code. Three are assertions or markup the
plan's own snippets make ambiguous against each other; one is a lease narrowing the
root handed down after the plan was written.

1. **Title 35's value assertion is the EXACT string, not `/warm and brief/`.** The
   fixture's `describe` is `Set the reply tone to "warm and brief"`, so the regex matches
   the card's `h2` as well as the diff's after-tone span — two elements, and `getByText`
   throws on two. Worse, the regex would have PASSED against the T3 placeholder, which
   renders the headline and no diff at all: the one thing the line exists to prove is the
   one thing it could not have caught. `getByText('warm and brief')` matches only the
   diff value, because Testing Library matches a node's own direct text children.
2. **The Receipt's date row is labelled `Applied at`, not `Applied`.** `PROPOSAL_APPLIED`
   is exactly `'Applied'` and the card prints it as the applied state line, so the plan's
   `<dt>Applied</dt>` put a second node with that exact text inside the same card and
   title 36's `getByText(PROPOSAL_APPLIED)` threw on two matches. The actor row is
   `Applied by` for the same reason.
3. **The Receipt also renders `operation` and `actorUserId`.** The plan's `ReceiptView`
   snippet omits both, and the T4 brief enumerates them as fields the applied card must
   show (`operation, scope, before, after actual, effective now, affects, applied at,
   actor, verbatim owner text, turn id, differsFromPreview`). Added as the `Change` and
   `Applied by` rows, both passthroughs of the stored JSONB. The record rows are a `dl`,
   which needs a two-line reset in `operator.css` (`.op-facts`) because a UA `dd` carries
   a 40px inline-start indent that `.op-kv`'s flex column does not clear — the same reset
   the timeline fact lists carry (`console.css:903-905`). No token, colour or literal.
4. **The plan's second `OperatorClient` case is folded INTO R3 rather than added beside
   it.** The plan's Step 6 appends two cases (`R3` plus a sibling `Refresh plan works
   under All locations`); the root's T4 lease permits ONLY the R3 todo in that file. Both
   assertions survive — R3 now drives the Cafe-scope case, unmounts, and re-drives the
   same stale card under scope `all`, asserting the button is enabled and still posts the
   Salon. RB-03's disposition ("R3 plus a sibling `all`-scope case") is satisfied by one
   case instead of two.

Also, R4 is declared non-`async`: the plan marks it `async` and it contains no `await`.

## Surface amendment #2 — 2026-09-12, after T6 (root)

- **What:** `.claude/reference/arch-review-log.md` joins the surface; the root adds ONE ledger bullet for this branch under "Merges since the 2026-08-26 pass".
- **Why:** `pnpm ci:merge-ledger` (the lint job and the lefthook pre-push gate) fails any PR that changes production files without a line in that file — this branch changes 26. Run A carried the same file for the same reason. The counter number is not touched (the audit says so itself; the 2026-09-12 pass on PR #1272 owns it). If #1272 merges first, the bullet is re-homed under "Merges since the 2026-09-12 pass" at rebase time.
- **Counted:** `feature-state.sh incr-amendment --reason …` (#2 — the reason is recorded in `.feature/state.json`).
- **Verdict:** ACCEPT
