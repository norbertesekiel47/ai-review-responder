import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #590. `package.json`, `.github/workflows/*`, and `lefthook.yml` each spell the
// set of `ci:*` audits by hand, and nothing forced the three to agree — so
// `ci:live-db-suites` shipped present in package.json and absent from every
// gate, while CLAUDE.md claimed CI enforced it. A green run could not see it:
// an audit wired into nothing simply never runs.
//
// This is a guard TEST rather than another `ci:*` script on purpose. An audit
// that checks whether audits are wired has to be wired itself, and removing its
// step would silence it — the exact failure it exists to catch. `pnpm test` is
// a required CI job and lefthook runs `src/__tests__` unconditionally, so there
// is no step to remove here.

const ROOT = resolve(process.cwd());
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

/**
 * Scripts that deliberately gate nothing. Each needs a reason, because the
 * default reading of an unwired audit is "someone forgot".
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // The developer-facing sweep. Its PR gate is the sibling `ci:fallow:coverage`
  // (fallow.yml), which feeds fallow real coverage; running both would double
  // the suite per PR for a strictly weaker signal. Reading a local `ci:fallow`
  // pass as "the PR gate is green" is how §2's second instance happened.
  'ci:fallow': 'superseded as a gate by ci:fallow:coverage in fallow.yml',
};

/** Every `pnpm ci:<name>` invocation in a file, whatever the surrounding YAML. */
function ciScriptsInvokedIn(path: string): Set<string> {
  const text = readFileSync(path, 'utf-8');
  const invocations = text.matchAll(/\bpnpm\s+(?:-s\s+)?(ci:[a-z0-9:-]+)/g);
  return new Set([...invocations].map((match) => match[1]!));
}

function declaredCiScripts(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  return Object.keys(pkg.scripts).filter((name) => name.startsWith('ci:'));
}

const declared = declaredCiScripts();
const inCi = ciScriptsInvokedIn(join(WORKFLOWS_DIR, 'ci.yml'));
const inLefthook = ciScriptsInvokedIn(join(ROOT, 'lefthook.yml'));
const inAnyWorkflow = new Set(
  readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .flatMap((file) => [...ciScriptsInvokedIn(join(WORKFLOWS_DIR, file))]),
);

describe('ci:* audit wiring', () => {
  it('finds the audits it is meant to check', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(inCi.size).toBeGreaterThan(10);
  });

  it.each(declared)('%s runs in some workflow, or is ungated with a reason', (script) => {
    const wired = inAnyWorkflow.has(script);
    const excused = script in UNGATED_BY_DESIGN;
    // An audit in neither column gates nothing at all — add it to a workflow,
    // or record in UNGATED_BY_DESIGN why it is not a gate.
    expect({ script, wired, excused }).toEqual({ script, wired: !excused, excused });
  });

  it.each([...inCi])('%s also runs in lefthook.yml', (script) => {
    // lefthook.yml's own header: "Every command here mirrors a step in
    // .github/workflows/ci.yml so the local loop and CI never diverge."
    expect(inLefthook.has(script)).toBe(true);
  });

  it.each([...new Set([...inCi, ...inLefthook, ...inAnyWorkflow])])(
    '%s is a real package.json script',
    (script) => {
      expect(declared).toContain(script);
    },
  );

  it('excuses only scripts that exist', () => {
    expect(declared).toEqual(expect.arrayContaining(Object.keys(UNGATED_BY_DESIGN)));
  });
});
