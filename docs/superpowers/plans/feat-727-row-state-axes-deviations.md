# feat-727-row-state-axes — deviations log

Entries the plan did not anticipate, or corrections to the seeded artifacts.
Verdict column filled during the step 6 read-back (ACCEPT / RE-PLAN).

- [2026-08-09] **ADR number: 0018, not 0017.** #723's resolution comment says
  "ADR 0017", but 0017 was taken by #724's persist-boundary freshness-gate ADR
  after that comment was written. This feature's ADR lands as
  `docs/adr/0018-row-state-axes-projection.md`. — VERDICT: ACCEPT (owner-visible
  in intake sign-off).
- [2026-08-09] **#723 self-contradiction on orphan×held resolved in favor of the
  table.** The resolution prose says "held → 'none' in EVERY reply_state", but
  the locked cross-product table and the prototype's `derivePresentation` both
  give orphan×held → `recover` ("recovery unaffected; #726 owns the discard
  hold-check"). The table is the reacted-to HITL artifact, so it wins: the
  invariant is *a held draft never projects an affordance of its own* —
  `none`/`posted`×held → `none`; `orphan`×held keeps `recover`, which addresses
  the orphan incident, not the draft. CONTEXT.md and ADR 0018 must state the
  refined wording, not the loose prose. — VERDICT: ACCEPT (consistent with the
  locked table; prose was summary shorthand).
- [2026-08-09] **Intake `tests_to_add` retitle (owner-approved deviation, not a
  surface amendment).** Title "projects a held draft to a none action in every
  reply state (invariant #4)" was wrong for orphan×held per the entry above;
  retitled to "never offers a draft affordance for a held draft in any reply
  state (invariant #4)". Both intake copies updated. — VERDICT: ACCEPT.
- [2026-08-09] **none×held rendering + wire typing locked by owner Q&A** (see
  intake): today's "Reply on hold" panel is preserved, reconstructed client-side
  from `reply_state 'none'` + `row_action 'none'`; new wire fields use proper
  union types end-to-end. — VERDICT: ACCEPT.
