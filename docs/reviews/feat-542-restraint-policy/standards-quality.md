# Standards & Maintainability Review — feat/542 restraint-policy

- **Branch:** `feat-542-restraint-policy` (2 commits over `main`)
- **Scope reviewed:** `src/lib/solicitation/restraint-policy.ts` (317 LOC),
  `src/lib/solicitation/__tests__/restraint-policy.test.ts` (383 LOC), plan/spec docs
- **Method:** thermo-nuclear-code-quality-review skill + repo axes
  (repworth.md, design.md, engineering.md, production.md, CONTEXT.md glossary,
  deep-module discipline, test-quality)
- **Verification run:** `pnpm vitest run src/lib/solicitation/__tests__/restraint-policy.test.ts`
  → 32/32 pass; `pnpm exec eslint src/lib/solicitation --max-warnings=0` → clean;
  `pnpm typecheck` → clean. Offset-timestamp divergence reproduced with a Node
  one-liner (`utcDayNumber('2026-07-24T08:00:00+10:00')` = day 20658, true UTC
  day = 20657).

## Overall verdict

**APPROVE with minor findings.** This is a genuinely deep module: a small,
spec-verbatim interface (`evaluateAsk`, `evaluateBatch`, `resolveVertical`,
constants) hiding precedence logic, vertical mapping, calendar arithmetic, and
banking order. No structural regressions, no spaghetti growth, no file-size
concerns, no `any`, named exports throughout, comments carry rationale not
narration. No "code judo" restructuring is warranted — the sequential gate
`if`s in `evaluateAsk` are the boring, direct shape the skill prefers over a
gate-array abstraction, and the batch pass is single-purpose and O(n log n).
The three findings below are contract-tightening and hygiene, not design flaws.

## Findings (≥80% confidence)

### F1 — Minor — `restraint-policy.ts:99` / `:191-197` — `decidedAt` "UTC date" contract diverges from lexical-date-part implementation

**Standard violated:** production.md ("external input … validated before
trusted"; make boundary contracts explicit) + design.md (interface comment must
match behavior).

`BatchContext.decidedAt` is documented as ISO 8601 with «"Today" for gate
arithmetic is its UTC date», and `utcDayNumber`'s doc claims "UTC day number …
(or the date part of an ISO timestamp)". The implementation slices the literal
first 10 characters, which for a legal offset ISO timestamp is the *local*
date, not the UTC date: `'2026-07-24T08:00:00+10:00'` (= `2026-07-23T22:00Z`)
yields day 20658 vs the true UTC day 20657 — a one-day skew that shifts every
`stale_visit` / `over_contacted` boundary. Same applies to
`priorBatch.decidedAt`. Today's caller (#543) will presumably pass
`toISOString()` (always `Z`), so this is latent, but the module's stated
posture is "trusted inputs per an explicit precondition" — the precondition as
written admits inputs the arithmetic mishandles.

**Remedy (either):** tighten the documented contract to "UTC (`Z`-suffixed)
ISO timestamp or `YYYY-MM-DD`" so the precondition and the arithmetic agree,
or parse via `Date` and derive the true UTC date. The doc-tightening fix is
one line and keeps the module dependency-free.

### F2 — Minor — `restraint-policy.ts:176` — per-call `new RegExp` construction inside a per-candidate loop for batch-invariant data

**Standard violated:** thermo-nuclear rule 7 (avoidable orchestration cost) /
engineering.md (think beyond the local edit).

`resolveVertical(context.businessCategory)` is batch-invariant — it depends
only on `BatchContext` — yet `evaluateAsk` recomputes it for every candidate
that reaches the freshness gate, and each call compiles up to ~90 `RegExp`
objects from constant strings. Behavior is correct and deterministic; this is
pure waste, not a bug.

**Remedy:** precompile the keyword regexes at module scope (they are
constants), which removes ~all of the cost with zero interface change. Do
*not* hoist the resolution into a caller-supplied parameter — that would leak
mechanism through the `evaluateAsk(candidate, context)` interface the spec
locks. An internal memo on the (single) category string inside `evaluateBatch`
would also be acceptable but is not required once the regexes are precompiled.

### F3 — Minor — `docs/directory.md` — new `src/lib/solicitation/` domain missing from the code map

**Standard violated:** repworth.md "Always do — check `docs/directory.md` …
before adding a new file or top-level directory" + docs-hygiene rule (dangling
refs/stale inventories are bugs).

`docs/directory.md` §`src/lib/` enumerates every existing lib subdomain with
per-file entries (`db/`, `dashboard/`, `agents/`, `analytics/`, `shared/`, …);
`rg solicitation docs/directory.md` returns nothing. The branch introduces a
new domain directory without adding its inventory row. If the team's
convention is to run the `document-feature` sweep at merge time, note that in
the PR; otherwise add the two-row entry (`restraint-policy.ts` + tests) in
this branch.

## What was checked and found sound

- **Deep-module discipline:** interface is 3 functions + 5 constants + typed
  decision contract; precedence, keyword tables, date arithmetic, and banking
  order are all hidden. `PerCandidateDecision` vs `AskDecision` encodes
  "`evaluateAsk` can never return `velocity_banked`" in the type system —
  exemplary boundary work, not type sprawl.
- **Glossary conformance (CONTEXT.md §Restraint policy, locked 2026-07-23):**
  `WithholdReason`/`WITHHOLD_REASONS` (never "refusal code"/"skip reason"),
  `FRESHNESS_WINDOW_DAYS` (freshness window), `velocity_banked`/banking
  vocabulary, "would-have-sent", evidence field names snake_case verbatim from
  spec §4. Enum order, windows table, cap 25, tie-break on UUIDv7 row ID all
  match the locked spec exactly.
- **Repo standards:** no `any` in src (test-file `as string` casts are
  recorded in the deviations doc with a typecheck rationale); named exports;
  no string literal where a constant exists (reason literals are the
  discriminant of the typed union, which is the canonical TS shape); comments
  are why-only; `node:` crypto not applicable; pure module — invariant #15
  trivially satisfied (no DB client at all).
- **Sentiment-blindness (ADR 0012):** no sentiment/rating/star field anywhere
  in `AskCandidate`, evidence, or tests' serialized output; enforced by two
  runtime assertions including an fc property.
- **Test quality:** assertions are regression-detecting, not tautological —
  exact-boundary cases on both gates (day 14 send / day 15 withhold; gap
  exactly 30 allowed), first-match precedence peeled one gate at a time,
  tie-break test pins the exact banked ID, banking test proves the
  freshest-kept dominance property against the pool. fc block mirrors the
  `sentiment.test.ts` house style (same header comment, `fc.assert` +
  `fc.property`, invariant-per-`it`), and the "reason ∈ WITHHOLD_REASONS"
  property is the runtime guard for the enum contract.

## Low-confidence appendix (style preferences, <80% — not findings)

- `evaluateBatch`'s `velocity_banked` branch rebuilds the envelope
  (`contact_id`/`policy_version`/`decided_at`) inline instead of sharing
  `evaluateAsk`'s `DecisionEnvelope` construction; a tiny `envelopeFor()`
  helper would remove the duplication, but three fields may not earn a helper.
- `WithholdEvidence`'s `reason` literals are written independently of
  `WITHHOLD_REASONS`; a coordinated typo in both the union and a return site
  would pass typecheck (the fc containment property catches it at runtime).
  A one-line type-level assertion
  (`type _Check = WithholdEvidence['reason'] extends WithholdReason ? true : never`)
  would close the static gap.
- The locked glossary term is "evidence snapshot"; the type is named
  `WithholdEvidence`. "Evidence" is retained and the shape matches spec §4
  verbatim, so this reads as compression rather than renaming — flagging only
  for the glossary-verbatim purist.
- The `resolveVertical` comment "'car' cannot match 'carpet'" is slightly off:
  `car` alone is not a keyword (`car wash`/`car repair` are), so the example
  illustrates a case that cannot arise.
