# Root review triage

Original review HEAD: `27069fef26fb001ec5133fa41ec893521a2722f2`.
Independent reports were committed before corrections; the root-owned finalizer
restored all production files and the local dotenv before any report was written.

| Finding | Verdict | Correction |
| --- | --- | --- |
| S1 | ACCEPT | Archive disclosure tests explicitly render location scope and assert the location sentence, rather than letting the helper overwrite their payload scope. |
| RT-F01 | ACCEPT | The archival-overflow integration case asserts the last period's actual archive and reactivation dates, catching the demonstrated slice mutation that drops the newest event. |
| RT-F02 | ACCEPT | Coverage omission checks required disclosures and nonempty trimmed note text, without fixing the number of legitimate notes. |

The root verified each finding against the pinned source. These are test
corrections; production behavior and the approved contract do not change.
The independent maintainability and database/tenancy reviews approved the
production diff without actionable findings. Scoped verification must assess
the corrections; the round-one report is historical evidence, not a current
clearance.

The committed full review gate passed with serialized rows: 13,965 tests passed
and 1,157 skipped in the main row, 34 refusal-read and 52 batch-builder live
database cases passed separately, and 62/62 changed instrumented lines were
covered. Serializing rows resolved observed timing failures without source,
timeout, or assertion changes. A full gate is required again after these fixes.

The full mutation inventory has 241 candidates. Round one used the skill's
30-launch limit for 15 baseline/mutant pairs; 226 candidates remain unmeasured.
Scoped round two must preserve this budget limitation and cannot claim full
mutation clearance. Computer Use remains unavailable, so no desktop/mobile
browser journey or screenshot verification is claimed.

## Owner-supplied independent review follow-up

Reviewed against `5c6f194d5e081ff630bfcefc8b2f8cd155cf0fd6`.

- External finding 1: ACCEPT the remaining duplicate-scope coverage gap.
  The fixture has two visible notes, not three: archive truncation defaults
  false. The policy disclosure already uses a singular `getByText`, which
  rejects duplicates. The scope assertion now does too. Retain trimmed-note
  checks for blank/whitespace paragraphs; an exact total count is unnecessary.
- External finding 2: ACCEPT. Migration 001 permits NULL review status.
  A real local-DB regression with retained 90-day attribution and NULL status
  produces `sendCount: 1` before the fix. `IS DISTINCT FROM deleted` keeps
  that evidence while excluding explicit soft deletion. The parameterized
  persistence/replay case verifies real evidence, Refusal, run linkage and
  idempotency for both normal and NULL review status. Current writer
  reachability or production occurrence is not claimed.
- External finding 3: no policy change. The approved contract consumes
  retained confirmed attribution without filtering its existing rule domain.
  Both full-name and first/last-initial rules therefore remain eligible.
  Upstream false-positive risk is inherited, not eliminated. Restricting to
  full-name evidence would change the approved behavior.
- External finding 4: no join removal or speculative index change. Migration
  091's outreach-to-ask foreign key binds ask/account/location, but not the
  outreach contact and batch to that ask; the explicit join checks both.
  Contact/location FK enforcement overlaps the contact join, which retains
  explicit scope verification. The existing contact/business outreach index
  supports the lookup. No EXPLAIN or quantitative performance claim is made.
- Accepted conservative disclosures remain within the signed contract.
  Date rendering uses `formatDate` and `new Date`; the cited `formatDay`
  helper is not present in this component.

These corrections make prior red-team bindings stale. Both mutation rounds
were already used; their reports remain historical evidence and are not
rewritten as current clearance. The inventory limitation and unavailable
Computer Use verification remain unresolved. The feature cannot transition
to review-ready on this evidence.

Follow-up targeted verification: the NULL-status regression failed on the
original predicate with `sendCount: 1`, then passed with the NULL-safe
predicate. All 101 tests passed across batch-builder unit/integration and
RestraintReport component suites, including the existing explicit deletion,
foreign evidence, precedence, persistence and replay cases. This is automated
test evidence, not a third mutation round or browser verification.
