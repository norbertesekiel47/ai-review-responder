# Evidence — Run C browser verification

Runbook: [E2E local setup](../../../runbooks/e2e-local-setup.md). Campaign started 2026-09-13 11:28 UTC. Local-candidate UI/Apply checks PASS; fixture teardown verified 11:53 UTC. Deployed worker/provider verification remains open.

Environment: local candidate UI at http://localhost:3000, current uncommitted Run C tree based on HEAD 72663b559742e4f320fcd3a15db15e95d71a7a1c. Staging Supabase project kubdiqdhqbhwmqfditeg (RepWorth-staging); production udeyaqnvpojbwgoaxwdg is NEVER a fixture target. No Stripe operations or Google connection/posting. No production flags change. Chrome DevTools is the owner-approved replacement for unavailable Computer Use.

Preflight: staging identity verified with Supabase list_projects; agent_proposals/agent_turns tables confirmed by read-only SQL. Local build and TypeScript passed before this campaign. Prepared synthetic proposals used the production catalog, snapshot reader and proposal builders. No turn was dispatched to the deployed worker; actual worker/provider behavior remains a separate staging obligation.

## Teardown ledger

| Fixture | Identifier | Removal | State |
|---|---|---|---|
| Staging Auth test identity | email run-c-766dbc45@e2e.repworth.net; Auth id dae5fb80-e57c-4194-bfa0-945a8291ee91 | Signed out through UI, deleted exact identity with Admin SDK | [x] auth.users and auth.sessions both zero |
| Account and owner | account 766dbc45-f38a-4e26-8063-faeddf77e7bb; user 7bdde43c-60cc-4c3f-9b49-8b6fbf1e5798 | Deleted fixture children, account and user with FK ordering | [x] zero residue |
| Two synthetic locations | d6dcc722-e960-4114-bc10-213ef3da5530, c572bea9-a7ad-472c-9798-61824adc3084 | Deleted only account-scoped fixture locations | [x] zero residue |
| Prepared conversation/turns, six proposals, five reviews and markers, three policy rows and four audits | conversation d64b5819-155d-4d5c-a1d1-259da55eaf4a; all under fixture account | Deleted account-scoped Operator/run-spine/policy/audit/review rows before tenant | [x] proposals, turns, conversations, runs, policies, audits and reviews all zero |
| Local dev process and temporary auth link | localhost:3000; private scratch only | Stopped campaign process, signed out browser, removed consumed temporary link | [x] lsof confirms no listener on3000 |

## Observed results

| Journey | Expected and observed |
|---|---|
| Account expansion | Card remains Account default, affects two inheriting locations, after selector moves from All Locations to Cafe. No plain Apply. Wrong phrase with trailing space keeps button disabled and same-origin POST returns 400 confirmation_mismatch, still pending, no receipt. Exact all locations activates the rendered control and applies once. |
| Consequences and receipt | Three confirmed-live Salon reviews (5, 4, 3 stars), one imported and one unknown. Preview eligible2/total3, held1. Receipt recomputed old0/3, new2/3, exclusions1+1, retained-veto0, affected locations2. SQL: one policy and one audit; replay200 returns the original receipt unchanged. |
| Veto | Salon inherited threshold4/veto15/default cap10. Veto30 creates its own manual rule while retaining cap10; card explains loss of inheritance, full states, eligible0/3, held3 and fixed 30-minute phrase. One-click Apply succeeds; receipt old2/3→new0/3. |
| Cap | Cafe inherited threshold4/veto15/default cap10. Cap1 creates its own manual rule retaining veto15. Card explains the new row, reports empty cohort0/0 and busiest day0. One-click Apply succeeds; receipt0/0→0/0. |
| Contraction | Account default threshold4→off has no typed field and one-click Apply; affected inheritors0 because both locations now have their own manual rows. Receipt persists. |
| Readiness | Only the synthetic account policy is marked suspended. New expansion card explains pause and disables confirmation. Same-origin direct POST with exact phrase returns409 expansion_blocked/policy_suspended. Reload shows rejected with the reason, no receipt. |
| Stale | Prepare another card, then change the synthetic account policy's veto and version. POST returns409 proposal_stale/version_mismatch, no receipt. Reload explains changed settings and offers Refresh plan. |
| Backend outcome | Before teardown: policies3, audits4, applied proposals4, rejected1, stale1, responses0, api_costs0. No generated/posting work or external provider calls occurred in this campaign. |
| Responsive rendering | Browser innerWidth/scrollWidth both390 and both1440. Full policy fields and receipts remain within the viewport. Mobile confirmation input16px and action buttons44px. All three card types and refusal/stale states inspected at both widths. |

Screenshots: [scope mobile](scope-mobile.jpg), [scope receipt desktop](scope-receipt-desktop.jpg), [scope receipt mobile](scope-receipt-mobile.jpg), [veto desktop](veto-desktop.jpg), [veto mobile](veto-mobile.jpg), [cap desktop](cap-desktop.jpg), [cap mobile](cap-mobile.jpg), [blocked desktop](blocked-desktop.jpg), [blocked mobile](blocked-mobile.jpg), [stale desktop](stale-desktop.jpg), [stale mobile](stale-mobile.jpg). Element captures preserve full card content; page captures show Console context. All data is synthetic.

## Remaining deployed verification

Deploy reviewed candidate to staging, send a real worker/provider turn, verify its schema-constrained proposal and backend outcome, and repeat a scope card after merge. These obligations are not satisfied by this prepared-proposal campaign.

## Deviations

Local UI with staging Auth/database is the documented deep-tier topology. No claims about production behavior or a deployed Run C build. Chrome's pre-existing75% zoom distorted desktop emulation; evidence uses mobile-metrics mode at1440 without touch so actual CSS layout width is exactly1440 (verified by innerWidth), and390 mobile/touch mode. Initial1920-width screenshot scope-desktop.jpg is diagnostic only, not1440 evidence. DevTools coordinate clicks did not dispatch Apply; final activations used DOM click on the rendered enabled controls via the approved DevTools evaluate tool. Direct API calls were limited to server-error/replay checks and are explicitly identified above. Screenshot tool could not save requested filesystem paths, so its returned image bytes were persisted in this evidence directory. Local SUPABASE_URL mapping was corrected in the private launch helper after an initial Auth500; no application source or production environment was changed for that setup correction.
