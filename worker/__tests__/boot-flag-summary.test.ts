import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBootFlagSummary, logBootFlagSummary } from '../boot-flag-summary';

/** The eleven env var names the boot summary is contracted to report, in order. */
const DECLARED_FLAG_KEYS = [
  'CHANNELS_TELEGRAM_ENABLED',
  'CHANNELS_WHATSAPP_ENABLED',
  'SELF_SERVE_SIGNUP_ENABLED',
  'ZERNIO_PUBLISHING_ENABLED',
  'TRIAGE_ENABLED',
  'ESCALATION_ENABLED',
  'JUDGE_ENABLED',
  'GOVERNOR_ENABLED',
  'AUTO_APPROVAL_ENABLED',
  'SOLICITATION_SEND_ENABLED',
  'SOLICITATION_AUTO_APPROVAL_ENABLED',
] as const;

/** Clears every declared flag so each case starts from a known-off environment. */
function clearAllFlags(): void {
  for (const key of DECLARED_FLAG_KEYS) vi.stubEnv(key, undefined as unknown as string);
}

describe('buildBootFlagSummary', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearAllFlags();
  });

  it('boot flag summary contains exactly the eleven declared flag keys including all four existing boot flags', () => {
    expect(Object.keys(buildBootFlagSummary()).sort()).toEqual([...DECLARED_FLAG_KEYS].sort());
  });

  it('boot flag summary names all five autonomy flags', () => {
    expect(Object.keys(buildBootFlagSummary())).toEqual(
      expect.arrayContaining([
        'TRIAGE_ENABLED',
        'ESCALATION_ENABLED',
        'JUDGE_ENABLED',
        'GOVERNOR_ENABLED',
        'AUTO_APPROVAL_ENABLED',
      ]),
    );
  });

  it('boot flag summary names both solicitation flags', () => {
    expect(Object.keys(buildBootFlagSummary())).toEqual(
      expect.arrayContaining(['SOLICITATION_SEND_ENABLED', 'SOLICITATION_AUTO_APPROVAL_ENABLED']),
    );
  });

  it('boot flag summary maps each key to its own accessor when exactly one flag at a time is true', () => {
    for (const onKey of DECLARED_FLAG_KEYS) {
      clearAllFlags();
      vi.stubEnv(onKey, 'true');

      const summary = buildBootFlagSummary();
      const expected = Object.fromEntries(DECLARED_FLAG_KEYS.map((key) => [key, key === onKey]));

      expect(summary, `exactly ${onKey} is true`).toEqual(expected);
    }
  });

  it('boot flag summary reports false for a flag set to a value other than true', () => {
    for (const looseValue of ['1', 'yes', 'on', 'enabled', 'false', '']) {
      clearAllFlags();
      for (const key of DECLARED_FLAG_KEYS) vi.stubEnv(key, looseValue);

      expect(Object.values(buildBootFlagSummary()), `every flag set to "${looseValue}"`).toEqual(
        DECLARED_FLAG_KEYS.map(() => false),
      );
    }
  });

  it('boot flag summary reports true only for the literal string true', () => {
    for (const key of DECLARED_FLAG_KEYS) {
      for (const nearMiss of ['True', 'TRUE', ' true', 'true ']) {
        clearAllFlags();
        vi.stubEnv(key, nearMiss);
        expect(buildBootFlagSummary()[key], `${key}="${nearMiss}"`).toBe(false);
      }

      clearAllFlags();
      vi.stubEnv(key, 'true');
      expect(buildBootFlagSummary()[key], `${key}="true"`).toBe(true);
    }
  });
});

describe('logBootFlagSummary', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    clearAllFlags();
  });

  it('logBootFlagSummary calls the supplied logger once with Feature flags and all eleven flag booleans', () => {
    vi.stubEnv('CHANNELS_WHATSAPP_ENABLED', 'true');
    vi.stubEnv('TRIAGE_ENABLED', 'true');
    vi.stubEnv('JUDGE_ENABLED', 'true');
    const logger = { log: vi.fn() };

    logBootFlagSummary(logger);

    // Built by hand, not from buildBootFlagSummary: an emit that logs the wrong
    // record must not be able to agree with the builder's own bug.
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('Feature flags', {
      flags: {
        CHANNELS_TELEGRAM_ENABLED: false,
        CHANNELS_WHATSAPP_ENABLED: true,
        SELF_SERVE_SIGNUP_ENABLED: false,
        ZERNIO_PUBLISHING_ENABLED: false,
        TRIAGE_ENABLED: true,
        ESCALATION_ENABLED: false,
        JUDGE_ENABLED: true,
        GOVERNOR_ENABLED: false,
        AUTO_APPROVAL_ENABLED: false,
        SOLICITATION_SEND_ENABLED: false,
        SOLICITATION_AUTO_APPROVAL_ENABLED: false,
      },
    });
  });
});

/**
 * `worker/index.ts` cannot be imported in a test — importing it boots Fastify —
 * so the wiring is asserted against its SOURCE. A substring check is too weak:
 * `// logBootFlagSummary(…)`, `if (false) logBootFlagSummary(…)` and a call
 * inside a never-invoked helper all satisfy one. Parsing drops comments for
 * free, and the ancestor rule kills the dead-branch and dead-function cases.
 * Precedent for a source-level wiring assertion: `src/__tests__/ci-audit-wiring.test.ts`.
 */
describe('worker startup wiring', () => {
  const WORKER_INDEX = resolve(process.cwd(), 'worker/index.ts');
  const source = readFileSync(WORKER_INDEX, 'utf8');

  /** Every node from `node` up to (excluding) the source file. */
  function ancestors(node: ts.Node): ts.Node[] {
    const chain: ts.Node[] = [];
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      chain.push(current);
    }
    return chain;
  }

  it('worker startup calls the boot flag summary logger unconditionally inside the startup try block', () => {
    const sourceFile = ts.createSourceFile(
      WORKER_INDEX,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );

    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'logBootFlagSummary'
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;

    // The call is a statement in its own right, not an operand of a condition.
    expect(ts.isExpressionStatement(call.parent)).toBe(true);

    const chain = ancestors(call.parent);

    // Nearest enclosing function is `main` — not a helper that nothing invokes.
    const enclosingFunction = chain.find(
      (node) =>
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node),
    );
    expect(enclosingFunction && ts.isFunctionDeclaration(enclosingFunction)).toBe(true);
    expect((enclosingFunction as ts.FunctionDeclaration).name?.text).toBe('main');

    // Everything between the statement and `main` is a plain block or the
    // startup `try` — so no `if`, no `catch`, no loop, no nested callback.
    const between = chain.slice(0, chain.indexOf(enclosingFunction as ts.Node));
    expect(between.length).toBeGreaterThan(0);
    for (const node of between) {
      expect(
        ts.isBlock(node) || ts.isTryStatement(node),
        `${ts.SyntaxKind[node.kind]} between the call and main()`,
      ).toBe(true);
    }
    // It really is inside a `try`, so a throwing accessor still exits 1 through
    // the existing startup-assertion handler.
    expect(between.some((node) => ts.isTryStatement(node))).toBe(true);
  });

  it('worker startup no longer prints the prose feature flag line', () => {
    expect(source).not.toContain('[worker] Feature flags:');
  });
});
