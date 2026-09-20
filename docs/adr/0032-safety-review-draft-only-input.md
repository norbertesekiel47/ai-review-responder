# ADR 0032 — The Safety review sees the draft, never the review

## Status

Accepted — 2026-09-18. Records why the **Safety review** is given the business's
own reply and nothing else.

Terms: `docs/context/core-reviews-responses.md` → **Safety review**,
**Moderation hold**, **Approval method**. Design of record:
`docs/roadmap/2026-07-01-agentic-reputation-platform-design.md` §8.
Evidence: `docs/runbooks/evidence/2026-09-17-provider-moderation-corpus.md`
(finding **G4-F1**).

## Context

The recorded provider-moderation corpus run failed identically in staging and
production. `omni-moderation-latest` returns `providerStatus: "clean"` on a
veiled threat and on sexual innuendo, and the local regex filter covers business
risks — refunds, legal fault, competitors — rather than interpersonal abuse. So
the merged `moderateResponse` decision misses both.

Provider moderation is a veto against **explicit** unsafe text. It is not a gate
against **implied** unsafe text. The Safety review adds that missing layer, on
the Auto-approval lane only, and it is the last thing standing between a
generated draft and Google when no human is in the loop.

An obvious improvement suggests itself: give the check the customer's review as
well as the draft. A reply reads very differently against what it answers. "We
still have your address from the delivery order" is menacing on its own and
merely clumsy if the reviewer just complained that a delivery went to the wrong
house. A judge with both would make better calls.

## Decision

**The Safety review receives the draft text ONLY.** `reviewSafety` takes a
`draftText` and builds its prompt from that alone. The review text is not passed,
not summarized, and not paraphrased into the prompt.

## Why

**The review is attacker-controlled. The draft is not.**

A review is written by anyone with a Google account and no relationship to the
business. A draft is written by our own model, from our own prompt. Feeding the
review into the gate that decides whether to post would put attacker-authored
text inside the one check that authorizes autonomous publishing — a prompt
injection path **into the gate itself**, not merely into the reply.

That is a qualitatively different exposure from the one the reply generator
already carries. The generator reads the review, and a successful injection
there produces a bad draft — which this check, moderation, and the owner can all
still catch. An injection into *this* check produces `{ cleared: true }`, and
nothing downstream re-asks the question. The failure is silent and terminal.

The draft is not a safe input either, and the prompt says so: it is framed as
data, delimited, and the system message states that text inside it asking to be
cleared is itself a reason to look harder. But the draft's authorship is ours,
so the attacker reaches it only through the generator — one indirection, with
the generator's own defences in between. Adding the review would remove that
indirection for no structural gain.

## The cost, stated plainly

**The check cannot tell a quoted complaint from an original insult.** A draft
that repeats the customer's own words back to them — "you said our staff were
lazy and disgusting" — reads to this check exactly as if the business had said
it. Some of those drafts will be held for owner review when they did not need to
be.

That cost is real and we are choosing to pay it. Three things make it bearable:

1. **The failure direction is right.** The cost is a false positive: a draft goes
   to the owner instead of posting itself. Nothing is lost but automation. The
   alternative failure — a cleared threat — is unrecoverable.
2. **It is measured, not assumed.** The corpus carries a `quoted_complaint`
   bucket precisely to price this. Those rows are labelled `safe`, so every one
   the check flags lands in the false-positive count against the 5% budget.
   Verified in the live safety-mode run before the flag flips, per environment.
3. **If the budget breaks, the prompt is wrong.** `MODERATION_CORPUS_ACCEPTANCE`
   is not widened to accommodate a chatty check. A blown FP rate is a prompt
   defect to fix.

## Consequences

- The logs and the run spine follow the same rule. The `safety_reviewed` step
  carries `cleared`, `concern`, `source` and `provider` — never the draft text,
  and never the review text. A check that excludes the review from its input has
  no business writing it to a log line.
- The decision is revisitable, but only with a structural answer to the
  injection path — not with "the prompt says to ignore instructions". That is
  already true of the draft, and it is a mitigation rather than a boundary.
- It is deliberately narrower than `moderateResponse`, which also sees only the
  output. Consistency here is a happy accident rather than the reason: that
  check fails open and runs on every draft, so its exposure was never the same.

## Alternatives considered

**Pass the review, rely on delimiters and instructions.** Rejected. It is the
same mitigation the draft already gets, applied to input with a strictly worse
threat model, guarding a strictly more consequential decision.

**Pass a sanitized or classified summary of the review** (for example the triage
severity rather than the text). Not rejected on principle — it carries signal
without carrying attacker prose — but not built: it adds a dependency between
two watchdogs that are deliberately independent today, and no G4-F1 row needs it.
Revisit if the `quoted_complaint` false-positive rate proves the cost too high in
practice rather than in theory.
