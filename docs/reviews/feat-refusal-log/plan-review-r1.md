# Plan review round 1 — adversarial, read-only

Reviewer: `codex exec` (codex-cli 0.145.0), read-only sandbox, 172,428 tokens.
Full transcript: `.feature/logs/codex-plan-review-r1b.log` (6,313 lines).
Plan under review: `docs/superpowers/plans/feat-refusal-log-plan.md` @ `e721a57a`.
Pre-validation before dispatch: `PREVALIDATE: PASS` (4 citations, 1 commit, 0 stale).

**VERDICT: REVISE** — 6 P0, 14 P1, 4 P2.

## Triage

Verdicts are mine. Every finding marked VERIFIED was re-checked against the
code independently, not accepted on the reviewer's word.

### Findings that change the design

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 11 | P1 | Judge verdicts are POST-publication, so counting one as a refusal is false, and it double-counts the suspension it triggers. | **ACCEPT — VERIFIED.** `judge-policy.ts:9` "a reply that has already been posted"; `judge-store.ts:115` `WHERE r.status = 'posted'`; `judge/context.ts:65` gates on `status === 'posted'`. **Drop S2.** |
| 13 | P1 | A lifted suspension leaves no trace: unsuspend clears `suspended_at` AND `suspended_reason`. Intake edge case 47 is impossible as planned. | **ACCEPT — VERIFIED.** `suspension.ts:352-354` sets both to NULL. |
| 12 | P1 | `suspended_reason` is owner-facing prose production refuses to machine-parse; the durable trigger lives in `account_audit_log`. | **ACCEPT — VERIFIED.** `suspension.ts:309-313` writes `eventType: 'autonomy_suspended'` with the trigger in the payload. **Re-source S4.** |
| 15 | P1 | `rendered_at` is not the refusal time for a dispatch-time withhold — the transition writes `updated_at = NOW()`. | **ACCEPT — VERIFIED.** `dispatch.ts:1371-1379` `commitWithhold`. **Anchor S6 on `updated_at`.** |
| 14 | P1 | `admin_halt`/`platform_halt` are promised in plan §2 but have no source row, no query, no task and no test. | **ACCEPT.** Add S7 = `solicitation_batches`. |
| 17 | P1 | The 22-member `AutoApprovalBlockReason` lane is missing — the per-review "why we did not auto-post this" vocabulary. | **ACCEPT — VERIFIED, and it is worse than stated.** `auto-approval.ts:37` declares 22 members; `persist.ts:570-576` emits them via `logger.log` only. Not durable. Not recoverable without a capture change. **Escalate to the owner.** |
| 24 | P2 | A single `UNION ALL` with one safe-column arm per source is simpler and safer than six independently scoped queries. | **ACCEPT.** One scan plan, one sort, one place tenant predicates live. Also moots plan §7.3. |
| 20 | P1 | `docs/adr/0022-*` collides with the existing `0022-solicitation-rate-cap-not-yield.md`. | **ACCEPT.** Next free is **0023**. |
| 21 | P2 | Plan §2 cites HEAD `2f4497a9`, which is neither current nor ancestral to `75a1f436`. S3 omits migration 002; S6 omits 108/109. | **ACCEPT.** `2f4497a9` was the pre-squash branch tip. Correct all three citations. |

### Eval findings — accepted, fold into T0

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 1 | P0 | The two redaction tests pass on shallow property checks while SQL still selects the secret or the API leaks it via nesting, JSONB, an error path, or a log line. | **ACCEPT.** 5 new titles. |
| 2 | P0 | The eval can hide `flagged_responses.reason` while returning the draft or joined review text in an unused field. | **ACCEPT.** 1 new title. |
| 3 | P0 | T2 turns all four tenant tests green with only S5 built, leaving T3/T4 queries free to omit tenant predicates. | **ACCEPT — the core eval defect.** Per-source tenant tests, 4 new titles. |
| 4 | P0 | Generic `business_id` tests cannot verify `auto_approval_policies`, keyed on nullable `location_id`. | **ACCEPT** (now applies to the re-sourced S4 join). 3 new titles. |
| 5 | P0 | `flagged_responses` uses independent FKs, not tenant-composite keys, so an unscoped join can expose a foreign review. | **ACCEPT — VERIFIED** against migration 051:15. 3 new titles. |
| 6 | P0 | Module tests do not prove the route passes the impersonated account. | **ACCEPT.** 1 new title. |
| 7 | P1 | No test requires most sources to produce an entry — an omitted source stays green. | **ACCEPT.** 5 new titles (was 6; the judge one dies with S2). |
| 8 | P1 | Exhaustiveness tests assert only that *a* category exists, so every code could map to the same wrong one. | **ACCEPT.** 1 new title (the precedence one dies with S2). |
| 9 | P1 | The outreach vocabulary is authoritative only in the migration 111 CHECK, so the `satisfies` claim does not hold for it. | **ACCEPT — VERIFIED.** 1 new title. |
| 10 | P1 | Plan §3 maps exclusions to `null`; intake test 6 says they are absent. The two cannot both be the map. | **ACCEPT.** `null` wins — explicit and exhaustive. Retitle intake test 6. Retitles are deviations-file entries, not surface amendments. |
| 16 | P1 | Singular exclusion tests cover one representative; `superseded` and `send_indeterminate` are unclassified. | **ACCEPT.** 3 new titles. |
| 18 | P1 | The UI eval pins no total, ordering, link coverage, window set, scope, or subscription branch. | **ACCEPT.** 7 new titles. |
| 19 | P1 | Nothing verifies invariants #12 and #15 for the new module. | **ACCEPT.** 2 new titles. |

### Rejected or no action

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 22 | P2 | All other cited artifacts resolve. | No action — confirmation, not a defect. |
| 23 | P2 | T6's edge on T0 alone holds only if its page shell imports neither T5 nor T7. | **ACCEPT as a constraint, not a defect.** T6's page shell renders the loading branch only; T7 wires the data. State it in the task. |

## Net effect on the source inventory

| Source | Before | After |
|---|---|---|
| S1 `flagged_responses` | keep | keep — the only remaining deny-all table |
| S2 `judge_verdicts` | keep | **DROP — post-publication, not a refusal** |
| S3 `approval_audit_log` | keep | keep |
| S4 autonomy suspension | `auto_approval_policies` | **RE-SOURCE → `account_audit_log`** |
| S5 `solicitation_asks` | keep | keep |
| S6 `solicitation_outreach` | anchor `rendered_at` | **anchor `updated_at`** |
| S7 `solicitation_batches` | promised, unbuilt | **ADD (admin_halt, platform_halt)** |
| `AutoApprovalBlockReason` | absent | **UNAVAILABLE — log-only, needs a capture change** |

Dropping S2 halves the redaction burden and removes a false claim from the
product. `below_our_bar` survives on `render_failed` and `lint_failed`.
