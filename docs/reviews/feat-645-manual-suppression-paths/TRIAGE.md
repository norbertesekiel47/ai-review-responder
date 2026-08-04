# Step 7 review triage — feat-645-manual-suppression-paths

Two rounds. Round 1: three parallel axes (spec, standards, adversarial approach).
Round 2: verification-only per axis. Counter in `.feature/state.json`
(`branchReviewRounds=2`). Full reports are the sibling files here.

## Round 1 — accepted and fixed

| Axis | Finding | Verdict | Landed in |
|---|---|---|---|
| spec + standards (both, independently) | `not_found` correction rendered "the suppression is still in place" — false; a 404 means another admin already removed the row, so the recipient IS mailable | **ACCEPT** | `a0674ed6` |
| spec + standards (both, independently) | Raw recipient email in a `GET` query string → access logs, log drains, browser history; violates §9.5, which every other path honours | **ACCEPT** — lookup moved to `POST /api/admin/suppressions/lookup`, old GET deleted not shimmed | `a0674ed6` |
| spec | Contract title `global wins the display state…` sat on a body that constructed no double match — would have passed with G3's ordering deleted | **ACCEPT** — title moved to the integration test that seeds a real double match | `4c157435` |
| standards | `LEFT JOIN LATERAL` pre-aggregation: ledger probe driven by `contacts × visits` for the whole business, not the ≤100-row page | **ACCEPT** — page + count first, then one probe over `unnest(distinct handles)`, still composing `suppressionMatchSql` (G7) | `4c157435` |
| standards | Suppression flow duplicated the delete flow in `ContactList.tsx` | **ACCEPT** — one `useRowConfirmAction` + one `RowConfirmBanner`; mark/clear keep distinct copy (§7.6), delete keeps the danger wash | `4c157435` |
| standards | Owner route duplicated a 12-line auth/scope preamble three times | **ACCEPT** — `withScopedContact` in `location-scope.ts`, the module that already declares itself that policy's owner | `4c157435` |
| standards | Badge washes reimplemented existing CSS variants inline | **ACCEPT** — named classes in a route-colocated `contacts.css` | `4c157435` |
| standards | Internal result union serialised as the wire contract | **ACCEPT** — mapped at the route boundary; a new failure variant now fails typecheck | `a0674ed6` |
| **adversarial** | **HIGH — P-2 let detector avoidance drive the schema; account-scoped corrections lose their originating account** | **ACCEPT — my design error.** See deviations D-A11 | `8361ad42` |
| **adversarial** | **HIGH — the schema test enshrined detector-evading naming** | **ACCEPT** — that test deleted, replaced with one asserting the table IS classified | `8361ad42` |
| **adversarial** | **MEDIUM — correction snapshot omits the original creator and the required §7.3 note, destroying the evidence behind the corrected assertion** | **ACCEPT** | `8361ad42` |

## Round 1 — rejected, with reasoning

| Axis | Finding | Verdict |
|---|---|---|
| standards | `PRIMARY_BUTTON` is a fifth copy of the admin primary-button recipe; extract to `src/components/admin/ui/` | **REJECT** — that directory is owned by the concurrent `admin-console-phase3` worktree and is outside this branch's surface, which is at 2/2 amendments. Extracting there would conflict on shared infrastructure for a styling constant, and a third amendment is teardown. Logged as a follow-up. Round 2 agreed the reasoning holds and noted the constraint is stronger than first stated |
| adversarial | LOW — the display seam has one caller and may not cover #629's contract | **REJECT/DEFER** — #629 is not built; shaping a seam around an unbuilt consumer is speculative generality. #629 will widen it if needed |
| adversarial | LOW — D-A8 should be PARTIAL: drop the confirm from the safe mark action | **REJECT** — a UX preference, not a defect. Symmetric confirms with *different* copy are what §7.6 asks for |

## Round 2 — verification

| Axis | Result |
|---|---|
| spec | All three ADDRESSED; D-A11 re-checked against the contract and HOLDS (new columns reach no owner surface, 18/18 titles verbatim, §8.2 still one CTE). No new defect at the reporting bar |
| standards | Seven ADDRESSED, one PARTIALLY (a secondary feature-envy sub-point left alone — **REJECTED**, the primary duplication is gone and further churn there is not worth the regression risk), rejection of #7 upheld. One new LOW: comment drift on a hoisted SQL constant |
| adversarial | **REVISE** — one residual: owner clearing still lost the original marker. `MEDIUM-1`'s snapshot closed the admin path but not the owner path. **ACCEPTED and fixed** in `0aead24b` — the DELETE now returns `created_by_user_id` + `suppressed_at` into the audit payload, still with no Normalized handle (§9.5) |

Also fixed in `0aead24b`: the comment drift above, and an `ERROR_COPY[code]`
prototype lookup that could render a function as user copy (unreachable today —
every code comes from a closed server-side set — fixed anyway, one line).

## Not re-reviewed in a third round

`0aead24b` is three small changes: a widened `RETURNING` plus audit payload
fields, a comment/inlining cleanup, and an object-to-`Map` swap. Verified
directly instead — the audit payload was read to confirm it carries no handle,
and the full gate is green including the live-DB suite that asserts the marker
is named and differs from the clearing actor. Spending round 3 of 3 on that
would have bought less than the reading did.
