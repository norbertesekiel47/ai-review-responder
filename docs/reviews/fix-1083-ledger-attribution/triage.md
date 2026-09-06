# Review round 1 — triage · fix/1083-ledger-attribution

Fork `91b32506` · reviewed HEAD `c94277bf` · RISK `high` · four axes, one dispatch.

25 findings. Every one carries a verdict below, so a resumed session inherits
triage state rather than re-deriving it.

## Why the convergence matters

The four axes were dispatched together, given different briefs, and could not
see each other's work. They landed on the same two defects anyway:

| Defect | Found independently by |
|---|---|
| The set arm's `extra` payload | red team (×2 P0), adversarial, spec, standards |
| The 200-char truncation rationale is arithmetically false | spec, standards, red team |
| The runbook names the wrong emitter | spec, standards, red team |
| The tags cannot separate the two fault classes | standards, red team |
| Stale line citations | standards, red team |

Independent convergence is the strongest signal a wave produces. Nothing below
rests on a single axis's judgement except where the table says so.

## The two P0s, and why the eval let them through

**RT-1 — the payload was not closed.** Adding
`refusal_codes: inputs.map(r => r.refusalCode).join(',')` to the set-arm `extra`
survived the entire suite: 146/146 green, both live-DB suites included. Gate
reasons are free-ish text on several lanes, so prose could ride a Sentry event
against the intake's own invariant.

The eval asserted the payload by **presence** — every expected key is there —
which cannot fail on an *added* key. The fix is one line per arm:
`expect(Object.keys(extra).sort()).toEqual([...KEYS].sort())`. Verified by
re-applying the mutation: the suite now fails.

**RT-2 — `refusal_lanes` was asserted only on a single-lane fixture**, so
degrading it to `inputs[0].refusalSource` also survived. Moot after the redesign
removed the field, but the lesson stands: the multi-lane case asserted `tags` and
never read `extra`.

Both are the same underlying error — an assertion that describes what the code
does rather than what it must never do.

## Findings and verdicts

### Fixed

| ID | Axis | Sev | Finding | Resolution |
|---|---|---|---|---|
| RT-1 | red team | P0 | Set-arm `extra` not a closed key set | Exact sorted-key assertion on **both** arms |
| RT-2 | red team | P0 | `refusal_lanes` under-asserted | Field removed; see A1/S1 |
| A1 | adversarial | — | Set arm carries no tenant/batch/run identity | `{ row_count, account_id, account_count }` — account, not batch, because batch would widen the interface this branch exists to protect |
| S1 / M4 / RT-6 | spec, standards, red team | med/P2 | 200-char truncation rationale false (108 actual) | Field and rationale removed from code, test, `CONTEXT.md`, plan, D4 |
| M1 / RT-8 | standards, red team | med/P2 | Two fault classes byte-identical in every tag | `fault=ledger_write` / `fault=ledger_vocabulary`; 17th eval title added |
| L3 | standards | low | Single-row `extra` duplicates `refusal_source` | Removed — the tag carries it and a tag is filterable |
| S2 / M3 | spec, standards | low/med | Three docblocks name the removed wrapper, **inside the lease** | Corrected |
| S3 | spec | low | `vocabulary.ts` says "uncaught INSERT" | Corrected (surface amendment #1) |
| S4 / M2 / RT-3 | spec, standards, red team | low/med/P1 | Runbook: three emitters, wrapper named as attribution source | Four emitters, both `fault` values, wrapper scoped to vocabulary (amendment #1) |
| M5 / RT-4 | standards, red team | med/P1 | Handoff's four `write.ts` citations stale at HEAD | Rewritten to cite symbols |
| RT-5 | red team | P1 | D3 repeats those citations; D4's rationale false | Both corrected |
| M6 | standards | med | `write.ts:61` import cited; moved to `:73` | Corrected |
| L1 | standards | low | `directory.md` claims `uuidv7()` interpolated in **both** templates | Split into the two genuinely different mechanisms |
| L2 | standards | low | `withLedgerAttribution`'s `lane` param admits one value | Parameter removed, literal inlined |
| RT-7 | red team | P2 | D9 claims a current fingerprint two commits behind | Tense corrected, SHA named |

### Rejected, with reasoning

| ID | Axis | Finding | Why |
|---|---|---|---|
| A2 | adversarial | No latch/cooldown/cap on the capture | Owner decision 2026-09-04. The module's two existing latches prevent unbounded issue-GROUP scattering — their keys are distinct codes. This capture has one exception shape across seven bounded lanes, so Sentry groups it into a single counted issue. A latch would additionally hide whether an `error`-level write fault is still happening, mid-incident, which inverts its purpose. Full reasoning in `adversarial-approach.md`. |

### Open

| ID | Axis | Finding | State |
|---|---|---|---|
| S5 | spec | T6's retry-cost follow-up ticket not filed | Outstanding before the PR. Named in the intake's first non-goal. |

## What held under attack

Recorded because a review that only lists defects misrepresents what was tested.

- All four guard mutations named in the red-team brief were **killed**: the
  `uuidv7` hoist, moving the set guard to the INSERT, computing lanes from
  `rows`, and dropping `.sort()`. Thirteen more besides.
- **#1079's kill-switch containment is intact** — no path found by which a
  ledger throw reaches a caller's transaction with the flag off.
- **No double-reporting path** between the writer and the surviving wrapper.
- **Zero missed siblings** across the five unedited lane files, with the search
  recorded rather than asserted.
- Live-DB lane confirmed **running, not skipping**: 39/39.
- D9's two gate flakes reproduced green in isolation (43/43 and 17/17),
  confirming they were machine load rather than branch defects.
- 28 inventory rows, 17 killed, 3 confirmed survivors, 0 inconclusive.
- **Every mutation restored**; finalizer run by the orchestrator, journal closed,
  porcelain empty.
