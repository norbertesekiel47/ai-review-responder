# Branch review round 1 — triage

Three axes, run in parallel against HEAD `05e52e3f` (fork point `0494297a`).
**12 findings: 2 high, 4 medium, 6 low. Eleven ACCEPTED, one REJECTED.**

Full reports in this directory: `spec-correctness.md`, `standards.md`,
`adversarial-approach.md`, plus `blast-radius.md`.

| # | Axis | Sev | Finding | Verdict |
|---|---|---|---|---|
| A-01 | adversarial | **high** | The input type exposes the full C1–C5-invalid cross-product; a mis-paired lane aborts the deciding transaction | **ACCEPT** (owner-ratified) |
| A-02 | adversarial | **high** | The Sentry cooldown retries a synchronous throw that real delivery failures never produce | **ACCEPT** |
| S3 | standards | med | Same defect as A-01, reached independently | **ACCEPT** (folded into A-01) |
| S1 / SP2 | standards + spec | med / low | `eval-completeness` scans 7 files; the branch touches 9 | **ACCEPT** |
| S2 | standards | med | One new poller arm needs five coordinated edits; hit twice | **REJECT — filed** |
| SP1 | spec | med | Test 28 exercises ONE failure, so the round-3 defect could regress unseen | **ACCEPT** |
| S4 | standards | low | Production SQL reshaped to fit a test's regex | **ACCEPT, partially** |
| S5 | standards | low | The one genuinely non-obvious line carries no comment | **ACCEPT** |
| S6 | standards | low | Docblock overstates; a throwing logger loses the warning entirely | **ACCEPT** (folded into A-02) |
| SP3 | spec | low | A title renamed to "11 target counts" over a body asserting 10 | **ACCEPT** |
| SP4 | spec | low | `arch-review-log` says six artifacts left alone; the table lists eight | **ACCEPT** |

---

## A-02 is the strongest finding of the entire run

Plan review rounds 1, 2 and 3 each found a different bug in the same five-line
warning path, and each fix was correct about the failure it addressed. Round 3's
cooldown looked like the end of the chain.

It was not, because **all three rounds reasoned about a mechanism none of them
read.** The reviewer went to `node_modules` and established that
`@sentry/node` 10.55.0's `captureMessage` returns an event id immediately (even
with no client configured), buffers the event, sends asynchronously, and catches
transport failures internally rather than throwing back.

So "capture succeeded" only ever meant "capture was queued", the `try/catch`
could never see a real delivery failure, and a Sentry outage latched the flag
with the warning undelivered — the precise permanent silence rounds 2 and 3 were
chasing, reached by a route none of them examined.

**Lesson, and it outranks the bug: verify the primitive before designing on top
of its assumed behaviour.** Three careful adversarial rounds are no substitute
for reading the library.

## A-01 / S3 — a finding against reasoning, not against code

Two axes independently found that `WriteRefusalEventInput` accepted states
CHECKs C1–C4 forbid. The plan had rejected a union on the ground that a
TypeScript copy would be "a second authority over the same five facts".

**Both reviewers said that conflates storage authority with API shape, and they
are right.** Migration 116 must stay the storage authority — TypeScript cannot
protect SQL written by another process. That does not require the API to accept
states already known to be illegal. A union is a compile-time *projection* of
the same authority and cannot drift silently, because adding a lane to
`REFUSAL_SOURCES` without an arm is a compile error.

Owner ratified the reversal 2026-08-30. Shipped as a mapped type over
`RefusalSource`; `refusalCategory` deliberately NOT narrowed per lane, because
#1001 declined to pin a lane's category and that decision stands.

## S2 — REJECTED, and filed rather than dismissed

*"Adding one retention arm needs five coordinated edits plus two sibling test
numbers; the branch hit this twice (D10, D18) and shipped a manual-grep process
remedy instead of the available structural one."*

**The observation is correct and the evidence is strong** — the same class did
hit twice in one run. It is rejected for **scope**, not merit: the fix rewires
all eleven arms' counting and logging inside a slice whose surface must stay
tight, and the plan already rejected touching the nine working arms on the same
grounds. The reviewer is careful to note this is NOT the per-arm SQL abstraction
the plan rightly rejected, and that distinction is fair.

Filed as a follow-up. Both positions are recorded here and in the PR
description.

## S4 — ACCEPTED, and it uncovered something better than the finding

The finding was that arm 11's `FOR UPDATE SKIP LOCKED` sits before `LIMIT`,
unlike all ten siblings, purely to satisfy a test's capture regex — production
SQL shaped by a test's parser.

Half the fix landed: the regex is widened and is now order-independent. The
other half could not: restoring the sibling ordering fails `ci:tenant-scope`,
because `tenant-scope-allowlist.ts` pins the snippet by exact
whitespace-normalised equality, and that file was outside the fixing agent's
surface.

**So the real finding is sharper than the reported one: arm 11's order is pinned
TWICE.** One pin is now gone; the other is documented in the arm's comment so
the next maintainer knows the two files move in lockstep. The agent stopped and
reported rather than reaching outside its surface, which is the behaviour wanted.

## Round-2 verification

Not run. Round 1's fixes are pinned by tests rather than by inspection — the
fixing agent mutation-checked them: removing the episode reset fails tests 8 and
28, and folding the log line back inside the Sentry `try` fails test 10. Step
7.5's red-team pass is the adversarial re-check, and it runs against committed
HEAD with the full gate re-run afterwards.
