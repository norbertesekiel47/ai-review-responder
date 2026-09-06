# Plan skeptic — round 1

Reviewer: /root/plan_skeptic. Base: 249389c7e16aa9b2efb0646f0f1b6b88410b017a.

| ID | Severity | Finding | Evidence | Root triage |
| --- | --- | --- | --- | --- |
| P1 | P2 | T3's extant-review join must exclude soft deletion, not only physical deletion. Otherwise dated soft-deleted evidence still withholds a contact. | worker/background/pollers/ZernioRecentReviewPoller.ts:217; src/lib/solicitation/attribution.ts:466 | ACCEPT. Add REVIEW_STATUS.DELETED exclusion and both deletion cases under the existing test title. |

Reviewer verdict: REVISE. Root correction verified against source and included
in the plan. This clarifies the approved deleted-evidence rule; no behavior
choice or intake surface changed. Verification-round decision is recorded in
the workflow transcript after the mechanical contract comparison.
