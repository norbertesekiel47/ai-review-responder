# Standards / maintainability — #1190

Reviewed immutable base `8b92d85395f902879d93748b5929b0b503c0ad86` → head `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`. Static inspection only; no tests, imports, runtime execution, network, source edits, or other review reports.

## Actionable findings

1. **Medium — Duplicated Code: object renderers already disagree on dictionary fields.** `scripts/ci/admin-contract-types.ts:218` creates a second object renderer, ending at line 232. Unlike the general renderer’s lines 92–95, it never reads `checker.getIndexInfosOfType`. For `declare const key: string; ... NextResponse.json({ [key]: 'ok' })`, the literal has a string index signature but no named properties, so this path emits `{ }`; passing the equivalent object through a local identifier reaches the general renderer and retains the index signature. A routine inline/extract refactor therefore changes the contract’s meaning. This violates ADR 0028’s truthful wire projection and the single-owner principle; it is a concrete divergence, not merely similar syntax. **Correction:** share object-property/index rendering, allowing the literal path to override parameter-bound property values only; add equivalent inline/local dictionary fixtures. **Confidence: 95%, static code-path evidence.**

2. **Medium — False coverage: normalization witnesses never inspect emitted constraints.** `scripts/ci/__tests__/admin-contract-schemas.test.ts:51` through line 55 constructs an independent runtime schema and checks handwritten `1`/`3` arithmetic. The generated `entry.schema` is never used; only approximation metadata is asserted. If the emitter drops or changes `minLength`/`maxLength`, the alleged two-direction disagreement proof remains green. This is the accepted checklist’s handwritten-arithmetic oracle defect and `.claude/reference/lab-notes/false-coverage-mutation.md`’s requirement that the fixture actually distinguish the defect. **Correction:** extract and assert the generated keyword-item constraints, then evaluate both witnesses against those actual constraints and the runtime parser. No new validator dependency is necessary for these two length checks. **Confidence: 99%, assertion-dependency inspection; no mutation executed.**

## Coverage and non-actionable appendix

Checked every standards-maintainability checklist entry: provenance/count/comment claims, duplicate and vacuous tests, naming/locality, and inventory identity; UI-specific hover, focus, pointer, layout, and animation cases do not apply. Read AGENTS/CLAUDE context, CI rules and lab notes, ADR 0028/amendment, intake/plan, and admin-aal2/directory-map precedents. Gate ownership, module seams, error propagation, barrel scope, and dependency growth otherwise fit the approved design. Mechanical green-tool concerns were excluded. Broader compiler completeness and runtime safety are outside this verdict; no unexecuted sensitivity claim is presented as measured evidence.

REVISE
