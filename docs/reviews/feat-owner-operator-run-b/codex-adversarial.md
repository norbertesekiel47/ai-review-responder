# Codex adversarial review — feat/owner-operator-run-b (round 1)

Session (thread) id: 01a0968b-6f4e-7443-8f54-532becd3ffe3 · base 6edacd0b094e47a1f72008ce75b126a4eead87ed · head dba7af671f8dcba589dc482e0a3ba86d8324fb07 · dispatched via /codex:adversarial-review --background

# Codex Adversarial Review

Target: branch diff against 6edacd0b094e47a1f72008ce75b126a4eead87ed
Verdict: needs-attention

Do not ship yet: the widened read bypasses subscription entitlement, recovery excludes stalled submissions, and summary actions can target the wrong location. Reviewed committed dba7af671.

Findings:
- [medium] The empty-view read bypasses dashboard entitlement (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b/src/lib/agents/operator/reads.ts:225-235)
  A first-time owner can now request ?locationId= and receive live dashboard counts without ever passing the writable gate required to create a conversation. The GET checks only role/account; proxy branch 7 and the new page likewise omit subscription entitlement. Pending-payment or cancelled accounts with an active location therefore receive KPIs that /api/dashboard withholds (route.ts:264–270). The repository explicitly requires subscriptionAllowsDashboardRead for customer KPI reads.
  Recommendation: Apply the shared dashboard-read entitlement check before returning a summary; use requireOwnerAccess on the page for matching navigation behavior.
- [medium] Recovery starts too late to cover a stranded submission (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b/src/app/(authenticated)/dashboard/operator/OperatorClient.tsx:400-410)
  The independent deadline runs only after a turn ID exists (lines 329–330). This POST and its response-body read have no deadline or abort signal. If either stalls on the first submission, sending remains true, polling never starts, and neither retry nor Start a new conversation appears. The recovery model therefore still has an indefinite waiting state before acceptance becomes known; the existing lost-response test covers an immediate rejection instead.
  Recommendation: Bound submission and response-body reads with an independent deadline, release the busy state, and offer retry using the identical retained submission key and payload.
- [medium] Carry summary scope through its labels and Connect action (/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b/src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx:41-48)
  The accepted contract deliberately scopes the summary to the latest turn, even after the selector moves (reads.ts:298–302). But its DTO carries no location identity, this panel says 'this location', and Connect drops the scope. After a Salon turn followed by selecting Cafe, the panel shows Salon's rules and connection warning while Connect opens Cafe: the destination uses currentScope unless ?locationId= is supplied (connect/page.tsx:54–64). This already misdirects connection recovery and makes the scope contract unsafe to reuse for slice 2.
  Recommendation: Return summary.locationId, label the panel with that location, and include it in the existing Connect URL's locationId parameter.

Next steps:
- Add regression coverage for unpaid empty-view reads, stalled POSTs, and Connect after a location-selector change.
- VERDICT: REVISE

