# Review triage — fix/1016-612-purge-terminal-alert, round 1

Reviewed SHA `6df3c95dfbabad6046b5dfbd455730233bc6e58c`, merge-base `75c8d54cb77ac34d1f2f7686b9171528871b81f3`.
Measured production diff (tests excluded): code 23 added / 4 removed; docs 43 added. RISK = high, so the
standards axis ran regardless of the 300-line threshold. Wave: spec-correctness (+ async/operations lens),
standards-maintainability, adversarial-approach (Codex `gpt-6-astra`, session
`01a0c4bd-1b04-7d12-baaa-8d6c4723e3a9`), red team (`docs/reviews/red-team/fix-1016-612-purge-terminal-alert-e8cee7/`,
status OPEN_P0). Every axis: REVISE. The per-finding JSONL transcript (`review-log.mjs`) was not populated; this file is the record.

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| RT16-01 · Spec F1 — the runbook prescribes a re-drive no code path can perform | P0 | ACCEPT (owner decision 2026-09-21) | Verified by two reviewers: `validatePurgeableOffboarding`, the purge poller and `shouldTransitionToPurgeScheduled` all disqualify `status='failed'`/`failed_step='purge'`; no admin route. Owner: write the truth (no mechanism exists; recovery is manual engineering work; the account holds live PII) and file a P1 ticket for the recovery mechanism. The alert ships. |
| RT16-02 · Codex A4 · Std S2 · Spec F2 — the doc pin pins the FILE, not the rule-16 row | P0 | ACCEPT | Four reviewers; red team survivor RT-A6: row corrupted to `terminal equals false` / `warning` / retry fingerprint, test stayed green. Fix: slice to the rule-16 block, match the filter, level, trigger and BOTH fingerprints as patterns. |
| Codex A1 — all terminal failures share one issue; the per-issue 60-minute throttle suppresses a second account's page | P1 | ACCEPT (owner decision 2026-09-21) | The defect is the intake's locked two-member fingerprint. Owner: terminal fingerprint becomes `[account_offboarding_purge_failed, terminal, <account_offboarding_id>]`; retry stays shared. The rule filters on tags, so the rule text is unchanged. Intake corrected; recorded in the deviations file. |
| Std S1 — `PURGE_RETRY_FINGERPRINT` exported with no importer; docblock and ledger line overstate "a test pins the two spellings" | P2 | ACCEPT | The rewritten pin imports and pins both; the docblock and the ledger line are corrected. |
| Std S4 — two live owners for three facts (§1 bullet and the rule-16 block) | P2 | ACCEPT | `context-layout.md` § Ownership and the file's own pattern: cut the §1 bullet to identity + pointer. |
| Spec F3 — "a re-run resumes" and "`failed_step` says which stage stopped" are false | P3 | ACCEPT | No checkpoint exists; `failed_step` is the constant `'purge'`; `last_error` is what names the stage. The inert `terminal_at` warning goes too (migration 056's CHECK forbids the edit). |
| Spec F5 · RT16-03 — "rides rule 1" overstates it | P1/P3 | ACCEPT | Rule 1's §1 box is unchecked (not configured), it triggers on first-seen, and the finding's message embeds the count. Runbook and ledger line corrected. |
| RT16-08 — rule-11 reasoning incomplete | P2 | ACCEPT | Rule 11 also filters `queue = agent_turn`; state it. |
| Std S3 — assertion subsumed by the next | P3 | ACCEPT | Disappears in the pin rewrite. |
| Std S5 · Std S6 — production comment reworded only to dodge a test regex | P3 | ACCEPT | The lab notes give the opposite answer (scope a grep gate to code). The scan strips comment lines; the regex is unchanged (locked); the original `purge-stages.ts` comment is restored, so that file leaves the diff. The intake's "reword the comment" edge case is superseded; recorded in the deviations file. |
| Std S7 · RT16-07 — the width test pins one hard-coded filename | P3/P2 | ACCEPT | Assert the scan visits the `worker/jobs/account-offboarding/` directory; drop the absolute→relative→absolute round trip. |
| Codex A5 — the regex cannot see an equivalent string construction | P3 | REJECT | Inherent to a regex guard and identical to the `solicitation_batch` precedent; the regex is locked. The guard's stated claim is narrowed in its comment instead. |
| Codex A2 — a watchdog-terminalized purge carries no offboarding id | P1 | REJECT for this run → issue | Pre-existing, outside the surface (`OutboxPoller`, `AccountOffboardingPurgePoller`). Filed as a follow-up issue; the runbook names the uncovered path. |
| Codex A3 · Spec F4 · RT16-06 — `account_offboarding_not_found` and a `loadPurgeOffboarding` throw raise no rule-16 event | P2/P3 | REJECT for this run → issue | Pre-existing; changing them is new alerting behavior the intake does not name. Filed; the runbook stops presenting rule 16 as the only page and names both paths. |
| RT16-04 · RT16-05 — `TeardownWorker` and `BillingScheduleWorker` carry the same RT-08 shape | P1 | REJECT for this run → issue | Sibling defects, outside the surface. Filed as one follow-up issue. |

Issues filed 2026-09-21: #1411 (no recovery path for a terminally failed purge), #1412 (the Teardown/BillingSchedule
siblings), #1413 (the three purge paths that raise no signal naming the offboarding).

# Round 2 (verification-only) — fix commit `4070fad8bb141455be5a51d598563dd355ad5aa1`

Members: one Claude verification agent (`round-2-verification.md`, 11/11 accepted findings ADDRESSED, REVISE on
defects the fixes introduced), the Codex session resumed (`adversarial-round-2.md`, REVISE), red team round 2
(22 mutations; the exact round-1 survivor RT-A6 is KILLED; 3 new survivors; status OPEN_P0). The red-team cap is
two rounds; the owner authorized a third round on 2026-09-21, scoped to the round-3 fix hunks, and adjudicated the
open out-of-scope P1s as accepted risk tracked in #1412/#1413 (both recorded in the sidecar).

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| RT16-02 (still open) — the row-scoped regexes match the OTHER cell's sentence, so SWAPPING the two fingerprint spellings inside rule 16's row survives | P0 | ACCEPT | Measured by the red team. Position-scope the assertions: the terminal fingerprint must appear in the grouping cell's head; the retry fingerprint only in the retry-arm sentence. |
| RT16-10 · Verif N1 · Codex A4 — the row states the level twice and only the filter cell is pinned; throttle and destination are unpinned; the new prose promises more than the pin checks | P2 | ACCEPT | Pin the grouping cell's level, the 60-minute per-issue throttle and integration 443670; make the prose claim exactly what the pin asserts. |
| RT16-09 · Verif N2 · Codex — `stripCommentLines` drops CODE lines that begin with `*` or `/*` | P2 | ACCEPT | Three reviewers; the red team measured a respelling on a `*`-leading continuation line staying green. Strip only the COMMENT PART of a line and keep any code on it. |
| Verif FALSE claim — "no admin route mutates purge state" | — | ACCEPT | False as written: the provider-disposition admin route writes `status`/`failed_step`. True in scope: it refuses a `failed_step='purge'` row. Say that. |
| Verif FALSE claims — "reads them back out of the table row" / "asserts on its table ROW … BOTH constants" (runbook `:578`, ledger) | — | ACCEPT | Made true by the RT16-02 fix; reword to match what the pin really asserts. |
| Codex — runbook `:578` "keeps a repeat failure on the same offboarding from being swallowed" | — | ACCEPT | Too strong: the SAME offboarding is still throttled for 60 minutes. Only the cross-offboarding guarantee holds. |
| Verif N3 — a systemic N-offboarding failure now sends N pages with no aggregate ceiling | P3 | ACCEPT (one sentence) | Owner-decided trade-off; the rule documents only the benefit. State the cost. |
| Verif N4 — `fingerprintPattern` interpolates constants into a `RegExp` unescaped | P3 | ACCEPT | Escape regex metacharacters. |
| RT16-04 · RT16-05 · RT16-06 — out-of-scope siblings and the silent not-found path | P1/P2 | ACCEPTED RISK (owner, 2026-09-21) | Tracked in #1412 and #1413; listed in the PR body. |

Round 3 for this branch is the authorized third red-team round on the fix hunks.
