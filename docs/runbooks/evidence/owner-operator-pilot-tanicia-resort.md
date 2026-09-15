# Owner Operator pilot — Tanicia Resort (production)

**Status: PILOT OWNER NAMED, ONBOARDING PENDING.** Named by the founder on
2026-09-15. Production flag flipped the same day (record below). The
observation window starts when the owner's first eligible review arrives
after setup. This file is the founder-facing reference for the pilot; the
private COO customer record keeps contact permission, commercial promises,
and the decision-maker's details. Spec: `docs/roadmap/2026-09-11-owner-operator/README.md`
§12.1 item 9 and §12.3. Template: `docs/runbooks/owner-operator-pilot-observation-template.md`.

## Production flip record (flag-flip skill step 7)

| Field | Value |
|---|---|
| Flag | `OWNER_OPERATOR_ENABLED` |
| Environment | production, both lanes |
| Railway worker | set 2026-09-15T18:12:26Z (service `repworth-worker`, env `production`); deployment `11858d51-1a0b-4bd6-a6c2-79fd27709d35` SUCCESS 18:15:00Z; startup assert accepted the exact value |
| Vercel production | `vercel env add` 2026-09-15T18:12:27Z; redeploy `rep-worth-9bhzvvxm5` aliased to `repworth.net` |
| Smoke | `GET /api/operator/conversation` and `POST /api/operator/turns` on `repworth.net` answer `401 Unauthorized` (auth gate), no longer `404 operator_disabled`; staging answers the same |
| Preconditions checked | migration 120 present on the production database (introspected 2026-09-15); Sentry rule 11 production `3984518` |
| Why | pilot owner named (Tanicia Resort); production had zero accounts at flip time, so the flip exposed the surface to nobody until onboarding |
| Authorized by | founder, in session, 2026-09-15 |

## Human decisions and existing record links

| Field | Entry |
|---|---|
| Existing COO customer record / account alias | Tanicia Resort (private record; alias to add at onboarding) |
| Pilot owner / decision-maker | Tanicia Resort owner — name and role in the private record |
| Location and recurring reputation job | One Google Business Profile location; job stated by the owner in their words at the first Operator turn |
| Observation start / end / timezone | Start: first eligible review after setup. End and timezone: set at onboarding |
| Eligible review activity and evidence for sufficient volume | Unmeasured until connection; record reviews in the last 30 days at onboarding |
| Observer / relationship owner | To assign at onboarding (default: COO) |
| Existing permission and agreed scope reference | Link in private customer record |
| Missing decisions / next action / owner / due date | Next action: onboard in production (checklist below) |

## Onboarding checklist (production, do in this order)

1. Owner signs up on `repworth.net`, chooses a tier, and connects the Google location. Confirm the Reviews list fills.
2. Record the baseline: reviews in the last 30 days, how the owner handles replies today, and their recalled minutes per week (label as recalled).
3. Owner opens `/dashboard/operator` and states the job in their own words. Do not script it.
4. Record the first turn id, the proposal cards shown, and which were applied. Note owner minutes and any founder help, separately.
5. Wait for the first eligible review. Record whether the next draft reflects the applied settings.
6. Ask the owner to change one instruction. Record the correction turn and whether the next comparable draft follows it.
7. Fill the scorecard sections below weekly. Keep raw counts.

## Baseline and setup, recorded separately

| Field | Observation |
|---|---|
| First observation timestamp and comparable work definition | Unobserved |
| Previously performed owner work / comparable baseline minutes | Unmeasured; label recalled estimates |
| Owner's requested job and instructions | Private record reference |
| Accepted plan, proposal/receipt reference and rule version | Unobserved |
| Missing decisions and next eligible task | Unobserved |
| Setup effort: owner minutes / founder minutes | Unmeasured, separate from ongoing effort |
| Setup completion and observed settings | Unverified |

## Eligible task observations

One row per actual eligible task. Label execution as simulation, manual founder service, automated execution, or verified external completion.

| Timestamp / task reference | Accepted rule version | Eligible? / reason | Expected result | Observed result / evidence | Execution category | Owner minutes | Founder minutes | Unresolved? |
|---|---|---|---|---|---|---|---|---|
| Unobserved | — | — | — | — | — | — | — | — |

## Instruction change and next comparable work

| Field | Observation |
|---|---|
| Owner's changed instruction / accepted replacement rule version | Unobserved |
| Correction timestamp / proposal and receipt references | Unobserved |
| Next comparable eligible task / expected behavior | Unobserved |
| Observed behavior / evidence / founder rescue needed | Unobserved |
| Repeated corrections, factual errors and unresolved work | Unmeasured |

## Shared scorecard and owner's decision

| Measure | Result and evidence |
|---|---|
| Activation: first eligible real workflow completed correctly | Unverified; setup or a demo alone does not qualify |
| Coverage and quality | Correctly completed eligible work / eligible work: unmeasured raw counts |
| Ongoing owner value | Comparable baseline effort minus ongoing owner effort: unmeasured; setup shown separately |
| Founder/support effort and delivery costs | Unmeasured; actual cash costs separate from imputed labor |
| Continued delegation | Numerator / denominator / observation age: unmeasured |
| Paid decision | Unrecorded; an explicit yes is not a paying account until payment clears |
| Latency | Re-read p50/p95 after the first week of real turns (staging baseline: p50 8.4 s, p95 9.5 s over five turns) |
