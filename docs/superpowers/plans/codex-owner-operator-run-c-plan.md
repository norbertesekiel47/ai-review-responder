# Owner Operator Run C: implementation plan (root revision 3: ingestion-origin amendment, verified)

**Base:** `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c`
**Intake:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c/docs/superpowers/plans/codex-owner-operator-run-c-intake.json`
**Spec:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c/docs/roadmap/2026-09-11-owner-operator/README.md`

## 0. Checks of the brief against the spec and intake

1. **Lock name.** Intake invariant and spec §6.4 step 1 say "`lockAccount` first". `lockAccount` is private in `settings.ts:379`. Apply reuses `lockAutonomyAccount(tx, accountId)` from `src/lib/auto-approval/account-lock.ts` to lock the identical guaranteed parent row before the proposal; it does not pretend the private settings helper is exported. The shared writer then reacquires that row in the same transaction and loads its own entitlement fields. This preserves the specified account-before-proposal order.
2. **Veto phrase.** Spec §3.5 says "Each auto-post waits 30 minutes for you first." The draft brief supplied an incorrect alternate sentence; the user never approved that copy change. Preserve the spec phrase, using the proposed 15 or 30 minutes.
3. **Confirmation.** Spec §6.4 step 4 matches the owner answer. First, Apply checks the typed phrase exactly. Then Apply maps it to `standard`. Then the writer's `assertConfirmationProvided` runs without change.
4. **Gate list.** Spec §12.2 also lists `ci:outbox-seam` and `ci:outbox-status`, but the intake command list does not. Add both to the final gate.
5. **§12.2 scope.** Some §12.2 bullets belong to other runs or are already done: pasted review, `scope_check`, offboarding purge and weekends capability. T8 marks only the Run C bullets.
6. **UI name.** The UI name is Console (Harbor). Do not use the old "Island" wording from the ticket.
7. **Ingestion origin (owner-approved 2026-09-13).** Source inspection (`docs/reviews/codex-owner-operator-run-c/map-gap.md`) disproved persisted import provenance. The owner approved three things: track whether a new review was imported, count only confirmed live reviews, and label reviews excluded because their origin is unknown. There is no migration. The work is a T5 prerequisite (T5.0), not a new tracer. The four earlier approved deltas do not change.
8. **Source drift corrections.** `src/lib/agents/operator/prompt.ts` owns the Operator prompt version and hash, not `src/lib/responses/prompt-policy.ts`. The model schema uses a regular `z.union` of strict variants with operation literals, not `z.discriminatedUnion`. The reason is that the OpenAI helper must traverse the nullable scope fields.

## 1. Tracer order and edit leases

```
T1 (alone) ──► T2 ─┬─► T3 ──► T5 ──► T6 ──► T7 ──► T8
                   │           ▲
          T4 ──────┴───────────┘
```

- T1 runs alone. No other tracer starts until T1 lands.
- T2 and T4 can run in parallel after T1. Their files do not overlap.
- T3 needs T1 (the writer seam) and T2 (the operation phrase and scope rules).
- T5 needs T3 (the Apply transaction) and T4 (`simulateRule`).
- T5 starts with T5.0 (ingestion-origin markers). T5.0 lands with its tests before the consequence reader. The count stays at eight tracers.
- T6 needs the stored proposal and receipt shapes from T5.
- T7 needs T5 and T6. T8 is last.

**Serialized leases.** Only one delegate edits each group at a time:

| File or group | Holders, in order |
|---|---|
| `src/lib/agents/operator/catalog.ts` | T2 → T3 → T5 |
| `src/lib/agents/operator/schema.ts` policy-state and receipt types | T2 → T5 |
| `src/lib/agents/operator/apply.ts` | T3 → T5 |
| `src/lib/agents/operator/proposals.ts` | T3 invalidation → T5 stamping |
| `src/lib/agents/operator/context.ts` | T2 projection → T5 consequence inputs |
| `src/lib/agents/operator/version-token.ts` | T3 |
| `src/lib/llm/{tasks,types,run-task,openai-provider,anthropic-provider}.ts` | T2 |
| `src/lib/reviews/process-review.ts` + `__tests__/process-review.test.ts`, `__tests__/import-review.integration.test.ts` | T5.0 |
| `worker/jobs/zernio/zernio-ingest-shared.ts` + `__tests__/zernio-ingest-shared.test.ts`, `__tests__/ingestion-origin.integration.test.ts` (new only if justified) | T5.0 |
| `docs/directory/{lib-reviews-responses,worker-jobs-b,worker-jobs-c}.md` | T5.0 → T8 |
| `docs/directory/lib-owner-operator.md` | T2 → T4 → T8 |
| `e2e/operator.spec.ts`, `e2e/helpers/operator-seed.ts` | T7 |

Each tracer that adds a new file adds its directory row in the same commit, so `ci:directory-map` stays green at every commit. T8 does the final sweep. Owner update, 2026-09-13: use Codex without external Opus delegates for remaining work. Root integrates and reviews.

Owner-approved supporting surface amendment 2 (2026-09-13): add `scripts/ci/tenant-scope-allowlist.ts` for one exact `agent_run_steps` binding in the policy snapshot query. Its parent run is scoped by account, business and review subject. Independent isolation review and live foreign-account/business/subject tests verified that proof. The checker itself and every other binding stay unchanged. The owner approved the concrete patch; the existing three plan-review rounds remain recorded, with no fourth round claimed and no change to the tracer decomposition or product behavior.

---

## T1: Export the transaction-aware writer (runs alone)

**Seam.** `src/lib/auto-approval/settings.ts`
- Add the export `patchAutoApprovalSettingsInTransaction(tx, input)`. It does three things in order:
  1. It rejects an impersonated actor on its own.
  2. It calls the private `updatePolicyInTransaction(tx, input)`.
  3. It returns `loadAutoApprovalSettings(tx, …, lockedAccount)`.
- `patchAutoApprovalSettings` stays a thin wrapper. It keeps its early impersonation rejection before `sql.begin`, then calls the new export inside the transaction.
- The input confirmation type stays `standard` plus the legacy `all_ratings`. Do not widen the settings form type.
- These stay unchanged: the private `lockAccount`, `classifyPolicyExposure`, the archived-policy rule, readiness, `assertConfirmationProvided`, `writeAccountAuditLog`, and the form route contract.

**Behavioral tests.** Add to `settings.test.ts` and `settings.integration.test.ts`. The baseline is 62 green tests in these two files on the local DB.
1. The tx export writes the policy and returns reloaded settings on the caller's transaction.
2. A caller throws after the export returns. The rollback leaves no policy row and no audit row. This proves atomicity.
3. One successful call writes exactly one `account_audit_log` row.
4. The account lock comes before any policy read. Add an explicit query-order assertion proving the account `FOR UPDATE` precedes the first policy-state read; moving the read above the lock must fail the test. Also use a live-DB barrier with two connections and no sleep: A holds the account row and B's writer cannot finish until A releases it. The completion barrier proves blocking, not ordering; both assertions are required.
5. Both seams reject an impersonated actor with zero writes. The wrapper still rejects before `sql.begin`.
6. A first location dial write uses `freshRowSeed`. Threshold is `null` (manual), and the other dial inherits the account default. On an existing row, fields the input does not name stay unchanged.
7. An archived location is refused for `set_location_override` and for any expansion, by the shared rule exactly as it is.
8. Exposure: every expansion dimension wins, with the `completeDisable` special case kept.
9. The existing form route tests pass with no change.

**Blocking edge.** T3 and T5 import this export.
**Precedent.** The current `patchAutoApprovalSettings` wrapper and `updatePolicyInTransaction`.

---

## T2: Three catalog operations and per-task provider schemas

**Seams.**
1. **Leaf input module.** Use `src/lib/agents/operator/operation-inputs.ts`, a leaf imported by both the catalog and model schema. It holds strict Zod input schemas for the four voice operations and for `set_auto_reply_scope`, `set_veto_window` and `set_daily_cap`. `catalog.ts` and `schema.ts` both import it, so there is no `catalog → schema → catalog` cycle. The new file is justified by the two consumers and avoids putting operation schemas behind the catalog or introducing a schema/catalog cycle.
2. **`catalog.ts`.**
   - The four voice operations stay at `contractVersion 1`.
   - Add the three autonomy operations at version 1. Each one declares: `parseInput` as the only door, `describe`, `preview` (full effective state), `writerFields`, `inputShape`, target scope rule and effect timing.
   - Each operation's own input adapts into the shared writer enum: `set_account_default`, `set_account_manual`, `set_location_override`, `set_location_manual`, `set_{account,location}_veto_window` and `set_{account,location}_daily_cap`.
   - Each operation owns `confirmationPhrase(after, scope)`. It returns `'4 and 5 star'`, `'5 star only'` or `'off'` for a location, from the after threshold, including an expansion that a dial causes. It returns `'all locations'` for an account.
   - Do not add `clear_location_override`. It belongs to Run E.
3. **Full effective state.** The shape is `{threshold, vetoWindow, dailyCap, effectiveCap, rowExists}`. The preview includes the effect of creating an override. The describer writes one sentence when it creates an override and names the inherited values.
4. **`schema.ts`.** Only the model transport input changes. It goes from `z.record(unknown)` to a regular `z.union` of strict proposal variants keyed by operation literals. Do not use `z.discriminatedUnion`, because the OpenAI helper must traverse the nullable scope fields. The final semantic validator stays. The §3.4 count and completion rejection stays. Existing fixtures stay.
5. **`prompt.ts`.** List the three operations with their `inputShape`. Bump the prompt version. `src/lib/agents/operator/prompt.ts` owns the Operator prompt version and hash; `src/lib/responses/prompt-policy.ts` does not.
6. **LLM seam.**
   - `run-task.ts`: the request gains the task's output schema. It flows through retries and fallback to both providers. Billing and semantic validation do not change.
   - `openai-provider.ts`: use the installed 6.39.1 `zodResponseFormat` in strict mode. Every field is required, optional fields become nullable, and `additionalProperties` is false.
   - `anthropic-provider.ts`: use the installed 0.100.1 SDK's `output_config.format` with its `zodOutputFormat` helper. The original plan's 0.106.0 version was corrected against the isolated worktree's installed package; no dependency upgrade is required.
   - Both adapters keep refusal, truncation and usage-cost error handling.
   - Build each schema at the registry/provider seam from the authoritative `LLM_TASKS[*].outputSchema` for `triage`, `judge`, `solicitation_ask` and `owner_operator`. Do not hand-write a second shape.
   - The unstructured tasks (reply, insights) send the same requests as before.
7. **Wire nulls.** Change a wire `null` for an optional location to `undefined` in one place, before semantic validation. The tenant check does not get weaker.
8. **Manual location projection.** In `context.ts:projectOperatingRules`, choose the effective location object before reading its threshold. A deliberate null/manual threshold must not fall through `??` to an active account threshold. Pin the case account=4 stars, existing location override=null; both prompt and summary must report manual. This preserves whole-row inheritance for the new autonomy previews.

**Behavioral tests.**
- Each new operation's `parseInput` rejects unknown keys and out-of-range values: veto windows other than 15 or 30, and caps outside 1–50 or the platform default.
- Describers render the full before and after state. They render "created override" when the row is absent.
- The prompt lists the three operations and their shapes. A mutation that removes a shape makes the test fail.
- For each of the four structured tasks, the captured OpenAI and Anthropic requests carry the derived schema. The unstructured requests stay byte-equal to the baseline.
- The transport schema enforces the finite wire shape; the semantic validator still rejects invalid tenant/scope references, prohibited count prose, and operation-specific meaning. Nullable wire fields are normalized before existing semantic validation. The model schema has no count, approval or receipt field.
- Inspect imports and run typecheck to verify the leaf creates no module cycle.

**Blocking edges.** T3 needs the phrases and the writer adapters. T5 needs the state types. T7 needs the schemas for the keyed evals.
**Precedent.** T8's `inputShape` fix and the tests for `catalog.ts` and `prompt.ts`.

---

## T3: Version tokens, lock order, typed confirmation and readiness in Apply

**Seams.**
1. **`version-token.ts`.**
   - Add a policy token. A row part is `{id: uuid, updatedAt: string} | {id: 'absent'}`.
   - An account-scope token is the account default row only.
   - A location-scope token is the location row plus the account default row, even when an override row exists.
   - Read timestamps as `::text`. Treat them as opaque strings, which keeps microseconds.
   - `parseVersionToken` tells voice and policy tokens apart. `versionTokensEqual` compares structure.
   - `VoiceVersionToken` does not change.
2. **Apply outside the transaction** (`apply.ts`).
   - Load the proposal by id and account.
   - If the contract version is not current, return `contract_changed`. The status update is a pending-only compare-and-set: `WHERE status='pending'`. It never overwrites a concurrent applied receipt.
3. **Policy scope inside `sql.begin`**, in this order:
   1. Lock the account row through `lockAutonomyAccount`, whose scoped `SELECT … FOR UPDATE` provides the same parent serialization as the private settings helper.
   2. Lock the proposal row `FOR UPDATE`.
   3. If the proposal is `applied`, return the stored receipt. Do this before the actor, location and archive gates, so a repeat Apply still works after an archive.
   4. Check that the status is `pending`.
   5. Revalidate: actor writable, `subscriptionGrantsFullAccess`, offboarding, tier, and archived location. The three multi-location checks stay separate.
   6. Read the policy rows. Compute the token. Require three-way equality: expected token = prepared token = token from the locked rows. A miss sets `stale` with no policy write and no audit write.
   7. Classify exposure on the server from the stored state and the locked full state. Never trust the model's `requiresConfirmation`.
   8. For an expansion:
      - If readiness is unmet, reject with the readiness reasons.
      - Compare the typed text to the stored proposal's `confirmationPhrase` byte for byte. No trim and no case folding.
      - A mismatch returns a typed validation error with no write and leaves the proposal pending so the owner can correct the field.
      - A match maps to `standard`.
   9. For a contraction or a fact change, do not check readiness or a typed phrase.
   10. Call `patchAutoApprovalSettingsInTransaction(tx, input)`.
   11. Write the receipt, set `status='applied'` and set `decided_by_user_id` in the same transaction.
- A thrown transient DB error rolls back everything.
- A deterministic writer refusal returns an owner-safe rejection. Apply already checks readiness, archive and confirmation before the writer, so the writer check is defense in depth. Known domain refusals that occur before any mutation commit only the rejected proposal status with the existing failure mapping plus owner-safe readiness detail. SQL/transient failures roll back; never catch an aborted SQL transaction and try to write inside it.
- Voice scope keeps the business lock before the proposal lock. Policy scope takes no business or review lock after the account lock. The global order is review → business → entitlement advisory → account.
 - **Sibling invalidation (`proposals.ts:markSiblingProposalsStale`).** Replace the voice-only assumption that every same-location proposal depends on `businesses.updated_at`. Voice writes invalidate only voice-token proposals for that business; location-policy writes invalidate only policy-token proposals for that location; account-default writes invalidate dependent account and location policy tokens, including locations with overrides because their token includes the parent. Keep cross-conversation coverage. Never sweep the other token domain or acquire its proposal locks; this preserves independent parent-lock ordering.
4. **Route.** `POST /api/operator/proposals/[id]/apply` accepts an optional typed confirmation string. It maps the new refusals to distinct response codes and never logs owner text.

**Behavioral tests.**
- Unit: a token with an absent account row differs from a token with an absent location row. A present row never equals an absent row. The location token changes when only the account default changes.
- Live DB: account-lock blocking plus explicit query-order evidence proves account before proposal. A mutation moving the proposal lock first must fail even if both calls eventually finish. `contract_changed` happens before the transaction opens. The compare-and-set does not overwrite `applied`.
- Typed phrase: a near match, a different case, a stale phrase or the wrong scope phrase each writes nothing. The exact phrase applies and the writer gets `standard`.
- Readiness unmet: the expansion is rejected and the matching contraction applies.
- An impersonated actor writes nothing.
- A repeat Apply returns the same receipt and adds no audit row.
- Apply adds no `api_costs` row.

**Blocking edge.** T5 adds the consequence and retained-veto fields into this transaction.
**Precedent.** The voice path in `apply.ts`, `computeVoiceVersionToken`, and T1's lock.

---

## T4: Pure consequence simulator (can run in parallel with T2)

**Seam.** New file `src/lib/agents/operator/consequence.ts` (spec name). It has no DB import.

`simulateRule(reviews, dials)`:
- **Input rows:** `{businessId, reviewId, stars, detectedAt, dayKey, imported}`.
- **Dials:** one set per business: `{threshold | null, dailyCap}`.
- **Order:** sort by `dayKey`, then timestamp, then `reviewId`, so the result is always the same.
- **Imported reviews:** remove them first. They are in neither eligible nor held, and they are not in the total.
- **Threshold null:** every non-imported review is held with reason `manual`.
- **Otherwise:** check `starMeetsThreshold` from `src/lib/auto-approval/policy.ts` for each review. Keep a cap counter for each business and each day. Reviews past the cap are held with reason `cap_reached`. Reviews below the threshold are held with reason `below_threshold`.
- **Output:** `{total, eligible, held: {below_threshold, cap_reached, manual}, byDay}`.

**Day key.** The pure function groups on `dayKey` only. The publisher counter at `worker/jobs/response-generation/auto-approval.ts:217` uses `created_at >= date_trunc(\'day\', NOW() AT TIME ZONE \'UTC\') AT TIME ZONE \'UTC\'` on approval grants. Preserve that exact UTC-boundary expression in the source citation; historical simulation substitutes each review\'s `detected_at` for `NOW()` in the same `date_trunc(\'day\', … AT TIME ZONE \'UTC\') AT TIME ZONE \'UTC\'` structure. Return the UTC date key as SQL text, without a JS Date round trip. Never bucket every review using the current day. This is a workflow eligibility simulation, so use `detected_at` following `src/lib/dashboard/aggregate-queries.ts:171`; reputation KPIs separately use the Review-time anchor. Document the 30-day period as reviews received, with exclusive window end. `byDay` aggregates all selected businesses for the busiest-day sentence, while cap counters remain per business.

**Behavioral tests.**
- Eligible and held partition the non-imported total.
- With cap 2, the third review in one UTC day is held.
- Caps apply separately for each business in an account aggregate.
- A null threshold gives zero eligible.
- Imported reviews are left out of both counts.
- A spy shows `starMeetsThreshold` is called once per non-imported review when the threshold is not null.
- An empty window gives zeros and an empty `byDay`.
- A ten-review fixture matches a hand count written as a table in the test.

**Blocking edge.** T5.
**Precedent.** `starMeetsThreshold`, and the grant count per business per UTC day at `auto-approval.ts:217`.

**Amendment note.** The T4 simulator contract does not change. The T5 reader gives it only confirmed live, deduplicated rows. It keeps the `imported` filter as defense in depth.

---

## T5: Worker stamping, Apply recomputation and the retained-veto count

### T5.0: Ingestion-origin markers (prerequisite, owner-approved 2026-09-13)

**Contract.**
- Marker: key `ingestion_origin`, closed enum `live | imported | unknown`. It lives in the existing `agent_run_steps.detail` JSONB of the `review_ingested` step. Write it through the run-spine single writer (`src/lib/agents/run-spine.ts`) in the same transaction as the actual first review insertion. No migration. No run-spine production edits.
- `processReview` (`src/lib/reviews/process-review.ts:40`): the default lane or `LIVE_INGEST_NEW` writes `live`. `BACKFILL` writes `imported`. Any other explicit lane on a new insert writes `unknown`.
- `importReview` (`process-review.ts:552`) writes `imported`.
- Only the winning insert writes a marker. A duplicate or retry that loses `ON CONFLICT … DO NOTHING` writes none. Later updates (`review_updated`) and on-demand generation never create, backfill or relabel an origin.
- Answered import `insertImportedReview` (`worker/jobs/zernio/zernio-ingest-shared.ts:483`):
  1. Mint a new UUID before the insert.
  2. Keep `ON CONFLICT … DO UPDATE … RETURNING id`.
  3. Treat the row as inserted only when the returned id equals the minted UUID.
  4. Only for that winner, resolve the billing account through `businesses`. Require `startOrGetActiveRun` to report a newly created run; otherwise throw an invariant failure. Record the `imported` marker with `recordStep` and complete only that new run via `completeRun` in the same transaction.
  5. Existing rows keep their original provenance.
- WARNING: the `accountId` parameter of `insertImportedReview` is the Zernio provider account ID. Never use it as the billing tenant.
- No response, job, publishing or consent change. No new production origin module. Annotate the two current writers only.
- Retention: the run spine keeps 180 days. Ordinary new reviews in the 30-day received window retain provenance, but a resurrected review resets `detected_at` and its original marker may already be pruned. Absent or pruned markers are `unknown`; never reconstruct them.

**T5.0 behavioral tests.**
- The first live insert and the first import each commit the marker atomically with the review row. A forced rollback leaves neither.
- A losing duplicate insert and a content update write no marker and do not rewrite the existing marker.
- An explicit `BACKFILL` insert records `imported`. Another explicit non-live lane records `unknown`.
- Answered import: only the real winner gets `imported`. A duplicate import and a live-then-import race keep the first origin.
- The answered-import marker carries the billing account from `businesses`, never the provider account ID.
- Update the directory rows in `lib-reviews-responses.md`, `worker-jobs-b.md` and `worker-jobs-c.md` in the same commit if a row's described behavior changes.

**Seams.**
1. **Consequence reader.** It takes `sql` or `tx` as an explicit parameter (invariant #15). Place database reads in `src/lib/agents/operator/policy-state.ts`, alongside policy snapshots/tokens; keep `consequence.ts` pure. This new module has worker and Apply consumers.
   - It reads non-deleted reviews received in the last 30 days (`detected_at`) for the scope. Scope is the billing account, active businesses and the review identity. Return no rows outside `[windowStart, windowEnd)`. Use canonical UTC text and SQL day buckets.
   - It reads only `review_ingested` markers on the `review_handler`/`review` subject with an exact account, business and review match.
   - Only nonempty, consistently `live` markers qualify. Consistent `imported` markers go to `excludedImported`. Missing, `unknown`, unrecognized or contradictory markers go to `excludedUnknown`.
   - Never use connection dates, later generation lanes, external response activity or a lack of drafts to infer live. Missing markers remain unknown.
   - Deduplicate review IDs before `simulateRule`, so extra step rows cannot inflate counts or cap holds.
   - It returns only IDs, stars, the SQL `dayKey` and the timestamp for included rows. It returns no review body.
   - It returns `{windowStart, windowEnd, asOf, source, excludedImported, excludedUnknown}` so the result is always the same.
   - Excluded reviews are never in `total`, `eligible`, `held` or `busiestDay`.
   - The model never sees these rows.
2. **`worker/jobs/agent-turn/AgentTurnWorker.ts`.**
   - Use the same scoped read as the snapshot.
   - Build the full before and after state, the policy token and the server exposure class for each autonomy proposal.
   - Store the consequence inside the typed `before`/`after` JSONB as a nested optional server field. Add no migration and no model field.
   - The stored consequence includes `excludedUnknown`, `excludedImported` and the window. These are server-only fields.
   - **Account aggregate:** dials for each business, before and after. Existing overrides keep their values. Inheritors take the new default.
   - Old voice snapshots and receipts that have `updatedAt` still parse.
3. **`apply.ts` inside the T3 transaction.**
   - Recompute the old consequence from the locked current rows.
   - Recompute the new consequence from the writer's effective result.
   - Recompute `excludedUnknown` and the window with the same reader, and write them into the receipt.
   - Compare the committed after state with the stored `after`. Flag any difference on the receipt.
4. **Retained-veto count, under the same account-locked transaction.**
   - Use a single SQL statement with a lateral latest-grant lookup and `FOR SHARE OF aal` on immutable audit rows only. Never acquire business, review, or response row locks after the account lock. Record `statement_timestamp()::text` as the count\'s `asOf`; it is the actual statement-time count, not a claim to freeze later publisher/veto transitions until commit.
   - Take the latest `AUTO_APPROVED_BY_POLICY` audit row for each response and business, with its `metadata.veto_window_minutes`.
   - Count one response with `status=approved` and `approval_method=AUTO_POLICY` per active target business. Account scope includes only active locations with no Reply/posting location policy row; whole-row overrides never inherit individual dials. Scope every join by account/business/response. A LEFT LATERAL latest-grant read detects missing/null grant windows; treat these as invariant failures, matching the publisher. Do not filter by scheduled deadline or notice state because late notices can reschedule the immutable granted window.
   - Exclude posted, cancelled and owner-only outcomes. Remove duplicate audit rows.
   - Never infer the count from the simulator or from history.
   - Write old and new counts plus the retained count into the receipt.

**Behavioral tests.**
- The worker stamps the consequence from the snapshot read, and the model output cannot set it.
- Receipt old and new counts match a hand-counted live-DB fixture.
- **Retained count:** seed duplicate grants plus posted, cancelled and owner-only rows. The count matches a hand count.
- **Invariant:** after Apply, every existing grant's `veto_window_minutes` is unchanged, and the veto-window gate still reads the original value.
- The `dayKey` SQL boundary cases (23:59:59.999999 UTC and 00:00:00 UTC) go to the correct days.
- Only confirmed live reviews count. A foreign-tenant or mismatched-subject marker never qualifies.
- Absent, unrecognized and conflicting markers are excluded, and each one adds to `excludedUnknown`.
- Duplicate step rows for one review count once, before caps.
- The 30-day `[windowStart, windowEnd)` bounds and the day keys do not change with origin filtering.
- The worker proposal and the Apply receipt recomputation both carry `excludedUnknown` and the window.
- Legacy voice proposals still parse.

**Blocking edges.** T6 and T7.
**Precedent.** `worker/jobs/publisher/veto-window-gate.ts` (read only) and the Run B receipt writer.

---

## T6: Console cards, friction and order

**Seams.** Everything is under `src/app/(authenticated)/dashboard/operator/**`: `ProposalCard.tsx`, `ReceiptView.tsx`, `OperatorClient.tsx` and `wording.ts`.
- **Expansion card:** a typed-scope field and no plain Apply button. On mismatch it shows "typed scope does not match". It shows readiness reasons and blocks Apply when readiness is unmet.
- **Contraction and fact cards:** one Apply button. They ignore readiness.
- **Order:** expansion cards render last, after a visible separator. There is no Apply-all control.
- **Wording (`wording.ts`, server-owned):**
  - Scope card: the word "eligible". Never "would have posted".
  - Veto card: counts plus the spec phrase "Each auto-post waits 30 minutes for you first." (substitute 15 for a 15-minute proposal)
  - Cap card: a sentence with the busiest day's count.
  - Zero counts render as zero.
  - Every consequence card and receipt states the 30-day received window and the count excluded because origin is unknown. It shows this even when the included counts are zero.
- **Receipt:** old and new counts, the retained-veto count, the excluded-unknown count with its window and the "actual differs" flag.
- Targets come from the stored scope, not from the location selector.
- Use `repworth-brand-design` and keep the Console (Harbor) tokens. No client code touches `auto_approval_policies`.

**Behavioral tests.**
- Component tests for each rule above, including a banned-phrase assertion and an order assertion.
- The card and the receipt render the excluded-unknown count and the window, including at zero included counts.
- `react-doctor` checks on the changed components.

**Blocking edge.** T7 browser tests.
**Precedent.** Run B's `ProposalCard` and `wording.ts`.

---

## T7: Concurrency, keyed evals and browser evidence

**Live-DB concurrency.** Name suites `*.integration.test.ts` and follow `.claude/rules/live-db-tests.md` (`assertSchemaReady`). Use at most two connections and explicit barriers, not sleeps.
1. The form writes first, then Apply runs. Apply is `stale`.
2. Apply writes first, then the form makes a valid write. The write succeeds because the form has no token.
3. Two pending proposals target the same scope. Exactly one wins, with one write, one receipt and one audit row. The other is `stale`.
4. Two Apply calls race to create the first location row, starting from an absent token. The result is exactly one row.
5. The account default changes under an inheriting location. The prepared proposal is `stale`.
6. A repeat Apply returns the stored receipt and adds exactly one audit row in total.
7. Prepare voice and policy proposals for one location: applying either preserves the unrelated token-domain proposal as pending. A changed account default stales dependent location-policy proposals across conversations, while voice proposals remain pending.

Before any live-DB run, confirm the local target is localhost `test_ws4` at migration head on Docker port 5499. Do not print environment values.

**Keyed evals** (existing `tests/llm-eval/` runner and fixtures; locate the current loader before editing).
- Add at least one real keyed case for each of `triage`, `judge`, `solicitation_ask` and `owner_operator`. The `owner_operator` case: a "widen the scope" instruction produces `set_auto_reply_scope`.
- Assert the exact schema in the request through the billed-call seam. Do not simulate keyed proof.

**Browser evidence.**
- Tool: Chrome DevTools MCP, in place of Computer Use (authorized). Record this substitution in the evidence.
- Tests: `e2e/operator.spec.ts` with `operator-seed.ts`, at 390px and 1440px.
- Cover: the expansion card with its typed field, a typed-scope mismatch, a stale card, a contraction with one click, and a receipt.
- Record the target, build SHA, steps, errors and outcomes. Sanitize the screenshots.
- Make backend assertions on the receipt and audit rows.
- Store the evidence under `docs/reviews/codex-owner-operator-run-c/evidence/`.

**Blocking edge.** T8.

---

## T8: Docs

Update these files:
- `docs/directory/lib-owner-operator.md` and `docs/directory/worker-jobs-a.md`: the final row sweep.
- `docs/directory/lib-reviews-responses.md`, `worker-jobs-b.md` and `worker-jobs-c.md`: confirm the T5.0 rows.
- `docs/context/owner-operator.md` and `CONTEXT-MAP.md`: new terms. The terms are Consequence line, typed scope, policy version token, retained veto window count and ingestion origin.
- Spec §3.5: retain the fixed veto phrase and document the workflow timestamp and UTC simulation bucketing.
- Spec §12.2: mark the Run C bullets only.
- Spec §15: add a review-log entry.
- `.claude/reference/arch-review-log.md`: check the counter against the threshold.

---

## 2. Closeout sequence (root owns every step)

1. Run narrow tests after each tracer.
2. Take current main before freezing the merge-base; commit the implementation, run a full verified review gate, and establish a fresh fingerprint before independent review.
3. Dispatch required correctness, maintainability, applicable risk, and red-team members in one wave. Root does not edit files while the wave is in flight.
4. Root finalizes. Triage the findings and commit the fixes.
5. After all docs, reports and commits exist, run the gate **last, as one serialized step**, with the verified-gate wrapper, on the current HEAD SHA:
   - `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
   - `ci:tenant-scope`, `ci:rls-audit`, `ci:static-policy`, `ci:directory-map`, `ci:db-imports`, `ci:outbox-seam`, `ci:outbox-status`
   - `eval:llm` (keyed), `test:e2e` and `react-doctor`
   - Confirm the DB lane actually ran. A silent skip is not a pass.
6. Before promotion, deploy the reviewed candidate to staging per `docs/runbooks/deployment-guide.md` and verify the deployed worker/provider paths, including a schema-constrained Operator scope proposal and fallback-provider coverage. The production Operator flag does not contain regressions in other structured tasks. Record candidate SHA and sanitized backend/browser evidence; after any evidence artifact or commit, regenerate the verified gate last. Only then merge the PR into `main` with green required CI. Record PR number, squash SHA, gate SHA, browser evidence, eval report, review and red-team results.
7. After the merge, drive a scope card on staging and record the true counts. Follow the staging runbook. Do not touch the production flag.
8. Open a separate closeout docs PR with the §15 update before Run D starts.

**No migration. No production flag change.**

## 3. Root decisions and remaining questions

**Reclassification check (2026-09-13).** The review gate measured4686 production-classified and5833 test changed lines, over twice the initial1250/1800 estimates. Root re-ran the classification: this remains one reviewable high-risk Run C feature with the same eight tracers and no unresolved product questions. The required provider schemas, full policy-state parsing/receipts, provenance reader/writers and concurrency tests account for the larger implementation; the gate also classifies the keyed eval runner and non-workflow docs as production. The existing scoped approvals cover these paths. No ninth tracer, migration, production operation or Run D/E behavior was added. Keep the original estimates and visible warning rather than rewriting them to erase the discrepancy; the complete high-risk review wave remains mandatory.

**Acceptance-title reconciliation (2026-09-13).** The original63 compound obligations are preserved and mapped in `docs/reviews/codex-owner-operator-run-c/evidence/promise-audit.md`; four actual assertion gaps were filled. The intake's72 entries now name real source test titles, as its schema requires. Live provider and browser execution obligations remain in the verification plan and their dedicated evidence artifacts, since the promised-title scanner searches only src/worker/scripts tests. This is a mechanical evidence correction with no removed acceptance requirement or fourth plan-review round claimed.

**Supporting-test reconciliation (2026-09-13).** The owner's existing authorization to include required supporting tests covers two reviewed-caller tripwires discovered by the full coverage run: `src/__tests__/cost-guard-contract.test.ts` and `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`. Surface amendment 3 records those exact test paths. Root reviewed the opt-in synthetic structured-eval exception and the imported-review winning-INSERT lock ownership before adding their named callers. No enforcement logic, lock exception, production scope, or tracer contract changes.

No unresolved product delta. The busiest day is the aggregate scope day, with independently enforced per-business caps. Workflow review time is `detected_at` (source precedent above). Account-default retained count covers active inheritors only. Provider JSON-schema compatibility is an implementation check: preserve authoritative Zod semantics and prove both provider requests plus real keyed outputs. No new permission or invented schema guarantee follows from an unsupported provider keyword.

**Owner-approved tradeoff (2026-09-13).** Counts use only reviews with a confirmed live ingestion origin. Reviews inserted before T5.0 ships have no marker, so they are excluded as unknown. Early after deployment, the excluded count can be larger than the counted total. The card shows the excluded count, so it does not hide this. No backfill or heuristic classification is authorized.
