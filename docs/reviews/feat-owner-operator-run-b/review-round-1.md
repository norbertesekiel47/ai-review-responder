# Review round 1 — feat/owner-operator-run-b

Pinned: fork = merge-base `6edacd0b094e47a1f72008ce75b126a4eead87ed` (origin/main) · head `dba7af671f8dcba589dc482e0a3ba86d8324fb07` · review gate GREEN at head (full mode, fingerprint `065351da…`) · production diff **3,261 lines** outside tests/docs (measured with `git diff --numstat`; above the 300-line standards threshold, and risk is high, so the standards axis ran) · intake amendments 3 (page path; arch-log ledger file; one dead glob removed).

Wave (one dispatch, every member read the committed SHA via `git show`): spec & correctness (Opus), standards & maintainability (Opus, thermo-nuclear protocol), Codex adversarial review (`/codex:adversarial-review --background`, thread `01a0968b-6f4e-7443-8f54-532becd3ffe3`), red team (fresh Opus, feature mode, sidecar `docs/reviews/red-team/feat-owner-operator-run-b-fec8cf/`). Full reports: `spec-correctness.md`, `standards-maintainability.md`, `codex-adversarial.md` beside this file.

## Triage verdicts (root; every finding re-read against head)

Legend: **ACCEPT** = fixed in the round-1 fix commits · **REJECT** = not fixed, reason given · **DEFER** = accepted as real, outside this branch's surface, filed for step 8.

### Spec & correctness (7)

| # | Sev | Finding | Verdict |
|---|---|---|---|
| S1 | P1 | `labelKind` never rendered — no "Fact to remember" / "Remembered fact" label on any card (spec §1, §3.3) | **ACCEPT** — `wording.ts` gains the four §1 labels; `ProposalCard` renders the pending label above the heading and the applied label on the applied state line |
| S2 | P1 | Runbook rule 11 flipped to BUILT with placeholder ids; §14/§15 assert it was built | **ACCEPT** (= RT-01 P0) — the docs return to the honest state: NOT BUILT, blocked on an `alerts:write` token the owner is minting; the flip in T8 gates on it. When the token lands the rule is created and the row becomes BUILT with real ids |
| S3 | P2 | A second message in an existing conversation never appears while preparing (unchanged `conversationId` → no reload) | **ACCEPT** — a successful POST bumps `reloadEpoch` so the accepted turn's `ownerText` renders from the transcript |
| S4 | P2 | Receipt "Change" row prints the catalog id (`set_tone`) | **ACCEPT** — renders `proposal.describe` |
| S5 | P2 | "Applied by" renders a raw uuid | **ACCEPT** — the Apply transaction already reads the actor's `users` row; the Receipt gains `actorName` (server-written, immutable) and the card renders it; the uuid stays out of the owner's view |
| S6 | P2 | `ROUTE_ERROR_WORDING` lacks `unauthorized` and `account_offboarding` | **ACCEPT** — both keys added with non-retry wording |
| S7 | P2 | An unusable `?locationId=` answers 404 `conversation_not_found` with no conversation but 200 + `summary: null` with one; the client shows nothing | **ACCEPT** — `reads.ts` returns a distinct `location_not_found` outcome in both branches, the route answers 404 `location_not_found` for it, and the client shows a notice |

### Standards & maintainability (13)

| # | Sev | Finding | Verdict |
|---|---|---|---|
| F1 | P1 | `apply` and `writerFields` are the same fact written twice per proposable | **ACCEPT** — `apply` deleted; `preview` derives `after` from `writerFields` |
| F2 | P1 | `OperatorClient.tsx` carries three machines (14 states, 3 effects, 10 callbacks, a second component) | **ACCEPT** — `useOperatorConversation` and `useTurnPoll` hooks extracted beside the client, `TurnBody` moved to its own file; behaviour-preserving, the existing suite unchanged |
| F3 | P1 | Local wire types duplicate landed server types; `TurnStatusView` re-spells `TURN_STATUS` | **ACCEPT** — server types imported; `TurnView` becomes a `Pick<OwnerTurnView, …>` |
| F4 | P1 | `wording.ts` claims single ownership; five voice-field labels spelled twice and already diverged | **ACCEPT** — one `VOICE_FIELD_LABELS` owner consumed by both renderers; the header narrowed to what the module owns |
| F5 | P2 | The fetch decode written three times | **ACCEPT** — `postJson` beside `getJson` |
| F6 | P2 | `apply.ts:169-173` comment describes an unreachable route | **ACCEPT** — comment corrected (narrowing step kept) |
| F7 | P2 | `declineProposal` lives in the row module while `applyProposal` has its own file | **REJECT** — it is a 40-line status transition beside `markSiblingProposalsStale`, the transition it mirrors; a new `decide.ts` for one function is the "no new file" default the working rules name. Recorded for the next pass |
| F8 | P2 | The 15-column SELECT list transcribed five times | **ACCEPT** — one nested `proposalColumns` fragment |
| F9 | P2 | `computeVoiceVersionToken` is an identity wrapper and the producer it names still writes the literal | **ACCEPT** — `ProposalRow.preparedVersionToken` typed `VoiceVersionToken` and built through the helper |
| F10 | P2 | Receipt prints the actor uuid | **ACCEPT** (= S5) |
| F11 | P2 | Three composition roots repeat the four-gate preamble | **REJECT** — invariant #12 lets entry points orchestrate, each root is meant to read top to bottom, and a `requireOperatorWriter` helper for three four-line preambles is an abstraction the next pass can weigh with the turns route in scope. Recorded |
| F12 | P2 | `.op-kv-value` re-declares `font-family`; `operator.css` sits outside three hardcoded purity-test lists | **ACCEPT** the redundant declaration; **DEFER** the test-list widening — `src/__tests__/design-token-single-source.test.ts` is outside the surface; filed for step 8 |
| F13 | P2 | `UnsupportedRow` names two shapes | **ACCEPT** (resolved by F3) |

### Codex adversarial (3, VERDICT: REVISE)

| # | Sev | Finding | Verdict |
|---|---|---|---|
| C1 | medium | The empty-view read returns live counts to an account that `/api/dashboard` would refuse (`subscriptionAllowsDashboardRead`) | **ACCEPT** — the conversation route reads the account's subscription posture with the existing helper and omits the summary (`null`) when dashboard reads are not allowed; the transcript stays readable (Run A's read-gate decision holds) |
| C2 | medium | The POST and its body read have no deadline; a stalled first submission leaves `sending` true with no recovery | **ACCEPT** — a 30 s `AbortController` on the POST; a timeout is treated as a lost response with the same retained submission |
| C3 | medium | The summary is scoped to the latest turn but carries no location identity; the panel says "this location" and Connect drops the scope | **ACCEPT** — `summary.locationId` added; the panel names the location; the Connect link carries `?locationId=` |

### Red team (11, status OPEN_P0 at round 1)

| # | Sev | Finding | Verdict |
|---|---|---|---|
| RT-01 | P0 | Docs claim rule 11 BUILT; Sentry has no such rule in either project | **ACCEPT** (= S2) — docs to the honest state now; build blocked on the owner's token. Surfaced to the owner as the P0 |
| RT-02 | P1 | The version-token property never generates a different-`businessId`/same-`updatedAt` pair | **ACCEPT** — generator draws `updatedAt` from a small constant set so both fields collide; the property kills M06 |
| RT-03 | P1 | Sibling-stale `status = 'pending'` guard unverified | **ACCEPT** — live-DB fixture adds an applied sibling and asserts it stays applied |
| RT-04 | P1 | `archived_at IS NULL` pinned only by SQL text | **ACCEPT** — live-DB case: pending Proposal, location archived after preparation → `rejected` / `location_not_found`, no voice write |
| RT-05 | P1 | `writerFields` tested for `set_tone` only | **ACCEPT** — catalog test asserts each proposable's `writerFields` names exactly its own column(s) |
| RT-06 | P1 | Per-turn `unsupported` wiring has no vitest coverage | **ACCEPT** — reads.integration seeds an unsupported row and asserts it on the transcript turn |
| RT-07 | P1 | `readConnectionStatus` covered only for `null` | **ACCEPT** — reads.integration seeds two `zernio_connections` rows (older active, newer disconnected) and asserts the latest wins and the JOIN scopes by account |
| RT-08 | P2 | `activeLocationId` archived predicate unverified | **ACCEPT** — folded into the RT-04 fixture |
| RT-09 | P2 | A third impersonation-presence spelling on the auto-approval server PAGE | **REJECT** — the finding itself says it is not a defect: the page has `cookies()`, not a `NextRequest`, so the helper cannot fit. Recorded |
| RT-10 | P2 | Sibling-sweep `account_id` predicate behaviourally redundant | **REJECT** — kept on purpose: `ci:tenant-scope` and invariant #9 require the predicate on every statement over a tenant table; redundancy is the point |
| RT-11 | P2 | Two prevalidator "stale commits" are fragments of a Codex session UUID in the handoff | **ACCEPT** — the handoff spells the session id in backticks with a "thread" label so the resolver skips it |

## Fix commits (round 1)

- `64f9de864` docs — RT-01/S2 (rule 11 back to NOT BUILT in the runbook row, spec §14, §15), RT-11 (handoff thread id).
- `aa7fd157a` server — F1, F6, F8, F9, S5/F10 (`Receipt.actorName`), S7 (`location_not_found` in both branches), C1 (`readSummaryEntitlement` + `subscriptionAllowsDashboardRead` → `summary: null`), C3 (`summary.locationId`), RT-02…RT-08 tests. One recorded deviation (RT-07: the CHECK constraint stands in for an unseedable status).
- `cd4710b4b` client — S1, S3, S4, S5/F10, S6, S7, F2 (`useOperatorConversation`, `useTurnPoll`, `TurnBody.tsx`), F3/F13, F4 (`VOICE_FIELD_LABELS`), F5 (`postJson`), F12, C2 (30 s POST deadline → lost-response retry), C3.
- Fast gate after the fixes: GREEN (`.feature/logs/fast-gate-fix1.out`; only the known reclassify WARN).

## What happens next

Fix commits (server lease, then client lease, then docs) → gate loop → red-team round 2 scoped to the fix hunks and their direct callers → final review gate → `red-team-status.mjs` → `reviewed`. The P0 (RT-01/S2) is the owner's: the branch does not claim the alert exists until it does, and T8's flag flip gates on it.
