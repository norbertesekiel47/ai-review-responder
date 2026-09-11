# Security / authorization review — #1190

Pinned head: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`.
Fixed base: `8b92d85395f902879d93748b5929b0b503c0ad86`.
Independent axis: authorization provenance, source-evaluation safety, exported-data and filesystem boundaries. Source reads used immutable git objects. No tests, application imports, network calls, process signals, git mutations, or delegation were performed. No other axis reports were read. There is no committed `docs/reviews/finding-checklists/security.md` at this head.

## Actionable finding

### SEC-1 — P2: Reject a linked artifact root before regeneration deletes files

- Location: `scripts/ci/admin-contract-audit.ts:208` (root cause also at lines 37–46; writes at lines 198–199).
- Confidence: 98% by source inspection; execution/reproduction is reserved to the feature lead.
- Requirement: the explicit regeneration boundary is `docs/admin-api/`; only generated contract files inside that directory may be removed. The implementation states this boundary at line 207 and deliberately rejects artifact symlinks at line 46. ADR 0028 D2 and plan T4 make the contract artifact tree the generator's bounded output surface.
- Evidence: `listFiles(destination)` calls `readdir(root)` before inspecting any directory entry. Its `entry.isSymbolicLink()` check therefore checks children only; it never checks `destination` itself or its `docs` ancestor. `readdir` follows a directory symlink. The `--write` branch then removes every enumerated file absent from the generated map using paths under that symlink, and `writeArtifacts` also follows it.
- Concrete failure scenario: a developer links `docs/admin-api` to a separate Admin app directory while sharing the portable contract. If that target contains `package.json`, source files, or another non-contract document, `pnpm admin-contract:generate` recursively lists them as stale artifacts and deletes them from the other directory before writing the contract. The existing child-symlink guard does not prevent this; an ordinary directory target containing regular files is sufficient. This does not require a concurrent filesystem race.
- Requested correction: validate the existing output root and its ancestors within the repository with `lstat`/resolved-path containment before enumeration, deletion, or writing, rejecting symbolic links rather than traversing them. Preserve the supported missing-directory creation case. Add an isolated CLI fixture with a linked artifact root and a sentinel file in the external target; regeneration must fail and leave the sentinel unchanged. Cover a linked `docs` ancestor as well.

## Reviewed boundaries with no additional actionable finding

- Canonical gate provenance: `describeRouteHandlers` invokes the existing `scanRouteFile` first, then uses the same HTTP-method inventory, export index and `collectGateEvidence` walk. The diff only adds canonical name collection to the existing acceptance evidence; unsupported exports, unrecognized imports and owner-resolver denial remain intact. Methods are analyzed separately. This review does not claim that the inherited static audit proves runtime dominance of a gate call.
- Schema execution: constructors and methods are restricted to an explicit allowlist on a locally created Zod receiver. Plain source data are interpreted through literals/constant bindings; object getters, spreads, computed members, arbitrary factory calls and dynamic callback expressions are rejected. Refinement/normalization callback source is retained as metadata without invocation. The TypeScript response analysis reads compiler types and AST nodes and does not execute application/auth/database modules.
- Portable artifact content: current schema limitation metadata contains normalization expressions and the expected pure refinement source. Inspected output contains no runtime customer values, credentials, private repository imports or absolute local source paths. Source literal values and callback text can intentionally appear in future artifacts, so this conclusion applies to the pinned output rather than promising secret detection for arbitrary future source.
- Proxy and MFA documentation: the generated README correctly identifies cookie 401/403 refusals, the MFA refusal vocabulary and challenge/retry action, bearer selection, origin refusal, and legacy impersonation ownership. These match the pinned proxy, canonical gate and ADR 0025 D6–D10. No live auth behavior or impersonation implementation changes appear in the diff.

## Uncertainty / verification limits

The filesystem finding has not been executed because this axis is explicitly source-only. No other uncertain concern is promoted to a finding. The lead should reproduce SEC-1 in an isolated fixture and rerun the normal artifact checks after correction.

REVISE

## Lead triage after restored round 1

- SEC-1 / SEC1 — ACCEPT. An isolated CLI fixture reproduced --write succeeding through a linked output directory instead of refusing. The generator now checks both docs and docs/admin-api before generation or artifact access, and listFiles also refuses a linked root. Regression fixtures cover both root and ancestor symlinks in read-only audit and regeneration modes, verifying that an external temporary sentinel remains unchanged.

The new boundary tests pass after correction. No real external directory was used by the regression; all targets were disposable test fixtures. Independent fix verification remains pending.
