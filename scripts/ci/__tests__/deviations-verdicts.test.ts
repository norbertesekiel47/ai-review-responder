import { describe, expect, it } from 'vitest';

// Pins the deviations read-back contract the `reviewed` transition enforces:
// feature 719 reached its branch review with deviation verdicts still marked
// "pending" despite the file's promise to resolve them. The parser lives in
// its own lib module so this suite can exercise it without a git worktree.
//
// Lives here, not beside the script: vitest's include roots are scripts/ci/**,
// src/**, worker/**, tests/** and e2e/** — a test under .agents/ never runs.

import { auditDeviationVerdicts } from '../../../.agents/skills/feature/scripts/lib/deviations-verdicts.mjs';

const TEMPLATE = `# Deviations — feat-x

## <task id> — <one-line title>

**Found:** _(template — not a real entry)_
**Verdict:** _(template — not a real entry)_

## Surface amendment log

| n | file | why |
`;

function audit(markdown: string) {
  return auditDeviationVerdicts(markdown) as {
    sectionCount: number;
    problems: string[];
  };
}

describe('auditDeviationVerdicts', () => {
  it('passes a file where every entry carries an ACCEPT verdict', () => {
    const result = audit(`${TEMPLATE}
## T1 — helper signature drifted

**Found:** plan cited a helper that does not exist.
**Verdict:** ACCEPT — tests are authoritative; briefs corrected.

## SURFACE AMENDMENT 1 of 2 — schema-ready.ts

**Verdict:** ACCEPT (owner sign-off recorded).
`);
    expect(result.problems).toEqual([]);
  });

  it('skips the template entry and the surface amendment log index', () => {
    expect(audit(TEMPLATE).problems).toEqual([]);
  });

  it('flags an entry with no Verdict line', () => {
    const result = audit(`${TEMPLATE}
## T2 — undocumented adaptation

**Found:** something changed.
`);
    expect(result.problems).toEqual(['no **Verdict:** line: "T2 — undocumented adaptation"']);
  });

  it('flags a pending verdict as unresolved', () => {
    const result = audit(`${TEMPLATE}
## T3 — still open

**Found:** x.
**Verdict:** pending
`);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('unresolved verdict "pending"');
  });

  it('flags the real feat-898 open-verdict spelling', () => {
    const result = audit(`${TEMPLATE}
## B1.4-tests — two pre-existing gate rows were already RED on HEAD

**Verdict:** _(open — for the orchestrator)_
`);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('unresolved verdict');
  });

  it('flags RE-PLAN as abort criteria, not review-ready', () => {
    const result = audit(`${TEMPLATE}
## T4 — invalidates a locked decision

**Verdict:** RE-PLAN — the intake locked the wrong key.
`);
    expect(result.problems).toEqual([
      'RE-PLAN verdict (abort criteria apply): "T4 — invalidates a locked decision"',
    ]);
  });

  it('requires every verdict in a multi-verdict entry to resolve', () => {
    const result = audit(`${TEMPLATE}
## T5 — superseded once

**Verdict:** ACCEPT — first pass.
**Verdict:** TBD
`);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('unresolved verdict "TBD"');
  });

  it('ignores verdict-shaped prose outside any section', () => {
    const result = audit(`# Deviations — feat-x

Log a one-line **ACCEPT** or **RE-PLAN** verdict for every entry.
`);
    expect(result.problems).toEqual([]);
    expect(result.sectionCount).toBe(0);
  });
});
