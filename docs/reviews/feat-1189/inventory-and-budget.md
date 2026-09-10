# #1189 adversarial inventory and capacity review

Independent read-only audit: `/root/feature_1189/plan_skeptic`.
There are 16 in-scope candidate cases before mutation execution. This is a
preflight inventory, not a claim of completed adversarial verification.

| Test file | Cases |
| --- | --- |
| `src/app/api/admin/businesses/[id]/__tests__/route.test.ts` | Five GET cases: cookie AAL2, AAL1 refusal, non-admin refusal, unauthenticated refusal, bearer AAL2 |
| `src/app/api/admin/businesses/[id]/__tests__/read-gaps.test.ts` | Five: sequential detail plus complete response, wrong account, wrong business, missing business, batch read failure |
| `src/app/api/admin/businesses/options/__tests__/route.test.ts` | Six: armed, unarmed, bearer AAL2, AAL1 refusal, non-admin refusal, unauthenticated refusal |

Exclusions were independently checked in both inventory directions:

- Five PATCH cases in the existing detail test file neither consume the changed
  GET-scoped DETAIL fixture nor execute the changed GET body. PATCH is unchanged.
- The two detail-suite instances and aggregate source check in
  `src/lib/auth/__tests__/admin-gate-mocks.test.ts` inspect unchanged gate mock
  import syntax, not the changed fixture or route behavior.
- The detail GET refusal in `e2e/admin-14c-runtime.spec.ts` is a Playwright test:
  retain fragile-assertion inspection; the red-team protocol excludes mutation
  execution of E2E tests.
- Existing batch-view integration tests exercise the unchanged reader directly;
  page tests use the unchanged page, client hook tests mock HTTP, and proxy and
  gate audit tests cover unchanged policies or synthetic fixtures. Reverse
  searches found no additional direct importers executing the changed behavior.

## Proposed temporary supervisor — owner approval pending

Sixteen baseline/mutant pairs need at least 32 launches. The checked-in runner
caps round 1 at 30. The prepared temporary copy at
`/private/tmp/1189-mutation-runner.mjs` changes only
`MAX_RUNS_PER_ROUND = 30` to `40`; it has not been executed.

- Original SHA-256: `159fc7b5f2b8b3e93308ae1ecb5c64f5e08c94d148ff8d20b77b4ed1e70347f5`
- Copy SHA-256: `de66427e45985e0b987b7e85c55817a45db7ca0573bc4d87947917fc9cb62d6f`

The independent reviewer verified relocation (Node built-in imports and Git
root from cwd), shared journal paths, unchanged environment/dotenv isolation,
and compatibility with the original finalizer and status checker. No repository
tooling edit is proposed. Use the copy only for supervised `run`; original
runner owns lifecycle and finalization. Explicit timeout stays 120000ms and at
most two mutations per case. No reset of a spent counter.

The copy is not mechanically ticket- or round-scoped. Any owner approval must
bind its use to #1189, the reviewed commit, round 1, and 40 total launches
including baselines and retries. It grants neither a new round nor acceptance
of unmeasured candidates. The existing runner remains the default elsewhere.

Approval, if granted, and the pinned runtime commit will be recorded in the
final findings evidence. No empty or fabricated finding authorization will be
added to the strict JSON sidecar merely to satisfy its schema.
