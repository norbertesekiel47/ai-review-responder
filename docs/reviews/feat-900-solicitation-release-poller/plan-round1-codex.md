I’m using the repo’s `verify-spec` workflow because this is a pre-implementation spec/plan audit. I’ll validate every cited artifact against disk, then attack Task 0’s test oracle for silent safety failures.

---

The plan file is currently untracked, alongside a separate untracked deviations note. I’m treating the supplied plan as the review target and the checked-in code/specs as the behavioral baseline.

---

Yes. All 27 promised tests can pass while the release behavior is unsafe or permanently wedged.

| severity | artifact:line | one-line finding |
|---|---|---|
| CRITICAL | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:250 | Task 0 lacks a NULL-veto-deadline case, permitting a silent auto-lane release with no confirmed notice. |
| CRITICAL | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:222 | The planned governor order puts Judge and subscription before the account cap, contradicting B6/B14’s fixed order. |
| CRITICAL | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:220 | No eval proves a `readSendBreaker` throw prevents enqueueing; an accidental fail-open catch passes the open-breaker test. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:397 | No forced-failure test pins the release CAS and outbox insert as atomic; a committed `queued` row without an outbox job is permanent. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:457 | P1’s absence-of-in-flight check is outside its transaction and is not rechecked in the terminal CAS. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:457 | The unknown sweep terminalizes the Outreach row and parent join but omits the already-created lazy child run. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:381 | The Judge-downgrade UPDATE lacks `halted_at IS NULL`/`send_closed_at IS NULL`, so a concurrent halt can have its approval history erased. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:397 | The locked release re-read omits the 72-hour window predicate, allowing a candidate delayed on the batch lock to queue after expiry. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:261 | The system-halt eval does not prove that `sending` is untouched or that the `batch_halted` receipt truthfully identifies the actorless system halt. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:261 | Judge tests cover “unhealthy” but not `JUDGE_ENABLED=false`, although D18 requires both to fail closed. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:221 | The eval tests a reached platform cap, not the partial-remaining-cap case; a two-row tick can exceed the ceiling. |
| HIGH | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:539 | The self-review’s §1–§9 citations do not name the executor-spec sections containing the claimed behavior. |
| MEDIUM | docs/superpowers/plans/2026-08-22-solicitation-release-poller.md:3 | The mandated `subagent-driven-development` sub-skill is not installed or available in this repository’s skill catalog. |

Missing failing test: `never releases an approved batch with a NULL veto_deadline_at`. The existing “does not release before its veto deadline” can pass using only a future non-NULL deadline. A regression from `AND veto_deadline_at IS NOT NULL` to a permissive NULL branch would send an auto-approved message without the required confirmed-delivery notice.

Missing failing test: `does not downgrade a cap-exhausted batch when Judge availability is false`. B6/B14 require breaker → platform ceiling → account cap → subscription, with Judge availability additionally gating release. The plan instead evaluates Judge before the account cap. With a cap-exhausted account and an unhealthy Judge, it can clear an otherwise-valid approval rather than simply stop at the cap. The current fixed-order title can pass if its fixture leaves Judge healthy.

Missing failing test: `propagates a Send breaker read failure and enqueues no solicitation_send row`. Testing an open breaker does not test the fail-closed throw contract. `readSendBreaker` already has its own throw test, but the releaser could catch that throw and proceed; all 27 titles could remain green while a breaker DB failure sends customer email.

Missing failing test: `rolls back rendered-to-queued when enqueueSolicitationSend throws`. This must inject an outbox-helper failure after the CAS. If those statements are accidentally split across transactions, the row becomes `queued` with no job; P4 only selects `rendered`, so neither the poller nor the dispatch worker can move it forward.

Missing failing test: `does not terminalize a sending row when its outbox is re-pended between P1 selection and the unknown CAS`. A watchdog can restore an outbox row to `pending` after the outer P1 query observes none. Task 6’s UPDATE only checks `delivery_status='sending'`, so it can falsely write `unknown` despite the normal recovery being in flight.

Missing failing test: `unknown terminalization also terminalizes the existing lazy child in the same transaction`. A `sending` row necessarily acquired its child before the dispatch CAS. Task 6 updates only `solicitation_outreach` and calls the parent join; the child remains `running` forever, and the failed hook subsequently treats the terminal Outreach row as already owned.

Missing failing test: `does not clear approval or append approval_downgraded when a concurrent Halt latch wins`. A halt does not clear `approved_at`; therefore, after the stale candidate waits on the batch lock, Task 3’s proposed UPDATE still matches a halted or closed batch. It can erase the original approval evidence and append a false Judge-downgrade receipt after terminalization.

Missing failing test: `does not queue an Outreach row when the send window elapses while release waits for the batch lock`. P2 runs before P4, but P4’s candidate query can become stale while blocked. The planned lock-time re-read checks halt/closure/approval only, not `approved_at > NOW() - 72h`, so it can release after the terminal deadline.

Missing failing tests: `latchSystemHalt never cancels a sending Outreach row` and `latchSystemHalt records batch_halted with halted_by null and the system reason`. Cancelling `sending` can discard a real provider delivery from durable lifecycle accounting; a later batch may treat the contact as unsent and email them again. The proposed tests check the batch column and audit-log absence, not the live-send exclusion or the spine receipt’s truthfulness.

Missing failing test: `treats JUDGE_ENABLED=false exactly as Judge unhealthy before and after first release`. `judgeEnabled()` is named in the implementation plan, but neither promised Judge title requires the disabled configuration. A boolean inversion or omitted flag check can therefore silently release while the Judge is disabled.

Missing failing test: `releases no more than the remaining platform capacity across accounts in one tick`. With nine prior dispatch attempts and a platform cap of ten, a budget-two tick can queue two rows unless it decrements the remaining platform allowance after the first release. “Ceiling is reached” passes at ten already queued rows and does not catch this overrun.

Artifact check: the source paths, existing symbols, migration objects, constants, and explicitly cited governing sections resolve, except for the two findings above. The plan’s self-review should cite §4 D7/D9/D10 for poller/release/veto/halt, §5 D11/D12/D14 for join/unknown/rollup, and §7 D18 for Judge behavior—not its current §1–§9 labels. New files and symbols explicitly marked Create/NEW were not treated as missing artifacts.

VERDICT: REVISE

---

The repository stop hook requires its gate verification before I can conclude. I’ll run the required read-only gate now; it won’t modify the plan or source.

---

The gate itself writes transient evidence under `.feature/`, which the read-only sandbox blocked before any checks ran. I’m requesting permission to run that required verification so the hook can record the result.

---

Gate verification could not run: it writes `.feature` logs/status, conflicting with the read-only review constraint; escalation was rejected. No repo files were changed.

VERDICT: REVISE