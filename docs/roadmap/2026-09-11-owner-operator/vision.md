# Owner Operator: stages beyond version 1

_Written 2026-09-11. Aspiration, not a plan. Each stage is gated by evidence from the one before. The v1 spec is [README.md](README.md)._

**The vision in one line.** RepWorth becomes the reputation department a
small business cannot afford to hire. The owner talks to it like a trusted
manager. It does the work, shows the results, and earns more autonomy over
time.

## Stage 1 (v1): set up, adjust, and check on review replies by talking

The owner explains the job and the rules. RepWorth proposes cards. The owner
applies them. The existing engine runs. Unsupported requests are named and
recorded. Full scope: README.md.

## Stage 2: the operator runs the whole job

- The model reads live state through tools and works in bounded steps.
- It covers three jobs: reply to reviews and ask happy customers for reviews (both exist in the engine), and follow up with unhappy ones (the recovery lifecycle is future P2 work in the forward roadmap, not an existing job).
- It comes to the owner instead of waiting: a short morning message with what was done, what needs one decision, and what is still open.
- Corrections carry forward. "Never mention pricing" changes every later draft. Facts and rules become a versioned business memory.

Gate: v1 owner pilot shows continued use and fewer repeated corrections.
Architecture: a bounded loop and the tool-call seam (architecture.md §4–§5).

## Stage 3: the operator in the owner's pocket

- Telegram and WhatsApp already terminate on the worker. The owner approves, corrects, and asks from their phone.
- Requires: conversation delivery, sender-to-scope resolution, channel-appropriate confirmation. Sharing the turn handler is not enough.

Gate: owners ask for it, and the in-app operator has proven approval and receipt behavior.

## Stage 4: the operator understands the business, not only its reviews

- Connects to booking, point of sale, and the customer list. A complaint links to a customer, a visit, and an outcome.
- Spots repetition: "Scheduling complaints doubled on Tuesdays this month. Want me to flag it to your manager and follow up with the three customers?"
- Proposes fixes outside reputation.

Gate: a connector justified by observed owner burden and real access (forward roadmap P1/P3 tests).

## Stage 5: RepWorth among other agents

- An MCP surface lets the owner's other tools and agents ask RepWorth questions and hand it work, under scoped permissions and its own identity model.
- Agency mode: one operator manages many client businesses, each with its own rules and approvals.
- New platforms and markets slot in as adapters. Same job, different channel or country (verticals: market capability evidence).

Gate: a named external user for MCP; agency demand with paid continuation.

## The sky: earned autonomy

- Autopilot today is bounded: rating band, daily cap, veto window, Judge on every auto-post, Governor per account. That structure is the ladder, not the limit.
- As an account builds a track record, its trust dial widens. More work runs without a click. The owner sets the ceiling and can pull it back in one sentence.
- With permission, what works for one salon informs the next. Cross-business learning is the moat a single feature never is.
- Pricing follows outcomes: recovered customers, reviews earned, hours returned. Design of record §8.5 reserves this and parks it until attribution is proven.

## What never moves, at any stage

- No public action without a recorded approval method: owner, or a server-owned policy. Never a conversation.
- Moderation stays an absolute veto. The Judge stays a posting precondition.
- Every read and write stays scoped to one account.
- The model proposes and interprets. The server authorizes and executes. The owner holds the ceiling.

## Why the ceiling is high

The claim to test: incumbents sell a dashboard with AI features inside it,
and this path sells a colleague. The competitor evidence
(`docs/plans/2026-09-11-reputation-competitor-landscape.md`) shows the
incumbents already automate replies and offer self-serve setup, so the
difference must be proven on the complete delegated job, not asserted. The dashboard becomes the receipt, not the product. The
engine, the approval gates, and the watchdogs already built are what make
the colleague safe to trust. v1 is the first rung, and it is the rung that
tests whether owners want to climb.
