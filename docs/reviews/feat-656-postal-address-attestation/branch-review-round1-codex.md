# Branch review round 1 — codex reports (#656)

Dual-axis, both `codex exec` --sandbox read-only against `git diff 4a16bcfd..HEAD`.
Raw transcripts trimmed to the final reports.

## Axis 1 — STANDARDS (repo invariants, CLAUDE.md)

## Standards findings
| # | Severity | File:line | Finding | Why it violates the stated rule | Suggested fix |
|---|---|---|---|---|---|

## Weak tests
| Test title | File:line | Why it would pass with the behaviour broken |
|---|---|---|
| every #656 promised test is executable with zero pending cases | `src/lib/solicitation/__tests__/postal-address.test.ts:52` | It only scans for literal `it`/`describe` todo/skip markers. Empty or assertion-free tests—and completely broken feature behavior—still pass. |
| PUT /api/settings/postal-address rejects an address that fails the lint | `src/app/api/settings/postal-address/__tests__/route.test.ts:351` | `attestPostalAddress` is mocked, and that mock invokes `lintPostalAddress` itself. It remains green if the real attestation function stops linting and writes invalid input. |
| ask generation reads solicitation_postal_address directly without the to_jsonb shim | `src/lib/solicitation/__tests__/ask-generation.integration.test.ts:463` | It asserts only the rendered bytes. The former `to_jsonb(b) ->>` projection returns identical bytes once migration 099 exists, so retaining the shim would still pass. |

VERDICT: REVISE

## Axis 2 — SPEC (intake contract, locked spec)

## Contract coverage
| Contract item | Source | Delivered? | Evidence |
|---|---|---|---|
| Add per-location attested postal address, profile surface, and send-handoff withholding | goal | Yes | Columns: `supabase/migrations/099_solicitation_postal_address.sql:51-56`; profile: `src/app/(authenticated)/settings/profile/page.tsx:17-30`; handoff: `src/lib/solicitation/batch-builder.ts:807-824` |
| Show the cookie-resolved location’s editable Google-address suggestion on `settings/profile` | user_visible_behavior | Yes | `src/app/(authenticated)/settings/profile/page.tsx:17-21`; `src/lib/solicitation/postal-address.ts:211-232`; `src/components/dashboard/settings/SolicitationAddressPanel.tsx:95-115` |
| Require the explicit, verbatim attestation checkbox | user_visible_behavior | Yes | `src/components/dashboard/settings/SolicitationAddressPanel.tsx:212-226`; server enforcement at `src/app/api/settings/postal-address/route.ts:66-70` |
| Require fresh attestation after editing | user_visible_behavior | Yes | Every edit clears the checkbox at `src/components/dashboard/settings/SolicitationAddressPanel.tsx:110-115`; successful submission consumes it at `:137-141` |
| Reject blank, single-line, or postal-code-free addresses with a reason before storage | user_visible_behavior | Yes | `src/lib/solicitation/postal-address.ts:79-95`; response mapping at `src/app/api/settings/postal-address/route.ts:125-134` |
| Build the watch-mode batch but enqueue no asks when address is missing or owner email bounced | user_visible_behavior | Yes | `src/lib/solicitation/batch-builder.ts:750-824` |
| Scope every read/write by account and cookie-resolved location | invariant | Yes | Write: `src/app/api/settings/postal-address/route.ts:100-109`; domain predicates: `src/lib/solicitation/postal-address.ts:148-154,218-220` |
| Enforce tuple completeness and current-address digest matching | invariant | Yes, at the owner-approved narrowed width | Tuple CHECK: `supabase/migrations/099_solicitation_postal_address.sql:71-87`; digest CHECK: `:109-117`; residual accurately documented at `:94-100` |
| Store attester as a no-FK UUID and verify account membership in the writer | invariant | Yes | Plain UUID: `supabase/migrations/099_solicitation_postal_address.sql:54`; membership predicate: `src/lib/solicitation/postal-address.ts:148-154` |
| Keep the postal precondition off `closedGateReason` and on the send-only seam | invariant | Yes | Candidate evaluation and persistence occur at `src/lib/solicitation/batch-builder.ts:750-793`; handoff check begins at `:807` |
| Withholding changes no candidate decision/count and writes no generation outbox row | invariant | Yes | Summary is finalized before the handoff at `src/lib/solicitation/batch-builder.ts:760-778`; enqueue exists only in the non-withheld branch at `:811-820` |
| Domain modules receive an explicit DB client | invariant | Yes | `src/lib/solicitation/postal-address.ts:131-134,199-202`; `src/lib/solicitation/batch-builder.ts:832-838` |
| Attester and flags remain server-authoritative | invariant | Yes | Actor comes from authenticated scope at `src/app/api/settings/postal-address/route.ts:100-108`; client submits no actor/location at `src/components/dashboard/settings/SolicitationAddressPanel.tsx:123-130` |
| Next.js route remains UI-only | invariant | Yes | Route only authenticates, validates, calls the injected domain write, and maps its result at `src/app/api/settings/postal-address/route.ts:72-138` |
| Service-area Google value is suggested but rejected on save | edge_case | Yes | Suggestion: `src/lib/solicitation/postal-address.ts:224-232`; one-line rejection: `:87-93` |
| Five-digit street number is not a ZIP; only non-empty lines count | edge_case | Yes | `src/lib/solicitation/postal-address.ts:87-93`; exact regression case at `src/lib/solicitation/__tests__/postal-address.test.ts:80-101` |
| Purge clears all five columns together for every account location only | edge_case | Yes | One account-scoped statement at `worker/jobs/account-offboarding/purge-stages.ts:655-693` |
| Attestation survives later user deletion | edge_case | Yes | No FK at `supabase/migrations/099_solicitation_postal_address.sql:54`; behavioral test at `src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts:391-416` |
| Failed re-attestation leaves the previous tuple intact | edge_case | Yes | Lint returns before SQL at `src/lib/solicitation/postal-address.ts:135-137`; all tuple fields share one UPDATE at `:139-156`; regression test at `src/lib/solicitation/__tests__/postal-address.integration.test.ts:329-360` |
| Re-attestation records the new actor | edge_case | Yes | Each write assigns `params.userId` at `src/lib/solicitation/postal-address.ts:141-146` |
| Reject unknown or stale attestation versions | edge_case | Yes | `z.literal(POSTAL_ADDRESS_ATTESTATION_VERSION)` at `src/app/api/settings/postal-address/route.ts:66-70` |
| Missing address precedes bounced owner email | edge_case | Yes | `src/lib/solicitation/postal-address.ts:252-259` |
| Send-disabled batches return exactly `not_applicable` and enqueue nothing | edge_case | Yes | Default status and gated enqueue at `src/lib/solicitation/batch-builder.ts:807-822` |
| Enqueue failure rolls back the whole batch construction | edge_case | Yes | Construction transaction begins at `src/lib/solicitation/batch-builder.ts:681`; enqueue remains inside it at `:815-819` |
| Ask generation directly reads the postal column without the shim | edge_case | Yes | `src/lib/solicitation/ask-generation.ts:179-200` |

## Spec findings
| # | Severity | Finding | Which contract item or spec section it breaks | Suggested fix |
|---|---|---|---|---|
| 1 | Medium | Migration column metadata overclaims the schema guarantee: `_attested_at` says the owner attested the “CURRENT bytes,” and `_attested_digest` calls them “attested address bytes.” The migration’s own later caveat correctly says stale timestamp/actor/version metadata can survive an address-plus-digest rewrite. | Claims-that-outrun-code review requirement; invariant covering current bytes at its deliberately narrowed width | Narrow both `COMMENT ON COLUMN` strings to say the timestamp is writer-recorded attestation metadata and the digest hashes the current stored address; retain the explicit residual caveat and add no trigger. |

## Overclaimed guarantees
| Where | What it claims | What the code actually delivers |
|---|---|---|
| `supabase/migrations/099_solicitation_postal_address.sql:60-67` | `_attested_at` proves when the owner attested the current bytes; the digest represents attested bytes. | The CHECK proves only that the digest equals the current stored address. It does not prove the preserved timestamp, actor, or version ever covered those bytes (`supabase/migrations/099_solicitation_postal_address.sql:94-117`). |

VERDICT: REVISE
