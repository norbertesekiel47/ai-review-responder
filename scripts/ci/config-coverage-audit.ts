// scripts/ci/config-coverage-audit.ts
//
// Proves "validate-all" without one global parse: every UNCONDITIONALLY
// boot-required env var (declared in config-coverage-baseline.ts) is asserted by
// at least one lane's boot assert, and no lane asserts a var it isn't declared to
// own. Pure auditConfigCoverage() is unit-tested; main() runs it for CI.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CLIENT_REQUIRED_VARS } from '../../src/lib/config/client';
import { CORE_APP_REQUIRED_VARS } from '../../src/lib/config/server';
import { WORKER_REQUIRED_VARS } from '../../src/lib/config/worker';
import {
  CONFIG_COVERAGE_BASELINE,
  REQUIRED_VAR_DECLARATIONS,
  type ConfigLane,
  type RequiredVarDeclaration,
} from './config-coverage-baseline';

interface AuditInput {
  declarations?: readonly RequiredVarDeclaration[];
  clientRequired?: readonly string[];
  coreAppRequired?: readonly string[];
  workerRequired?: readonly string[];
  baseline?: number;
}

export function auditConfigCoverage(input: AuditInput = {}): string[] {
  const declarations = input.declarations ?? REQUIRED_VAR_DECLARATIONS;
  const baseline = input.baseline ?? CONFIG_COVERAGE_BASELINE;
  const laneVars: Record<ConfigLane, ReadonlySet<string>> = {
    client: new Set(input.clientRequired ?? CLIENT_REQUIRED_VARS),
    server: new Set(input.coreAppRequired ?? CORE_APP_REQUIRED_VARS),
    worker: new Set(input.workerRequired ?? WORKER_REQUIRED_VARS),
  };
  const findings: string[] = [];

  if (declarations.length !== baseline) {
    findings.push(
      `declarations count ${declarations.length} != CONFIG_COVERAGE_BASELINE ${baseline} — bump the baseline in the same PR`,
    );
  }

  // (1) every declared required var is asserted by each lane it is declared for.
  const declaredByLane: Record<ConfigLane, Set<string>> = {
    client: new Set(),
    server: new Set(),
    worker: new Set(),
  };
  for (const decl of declarations) {
    for (const lane of decl.lanes) {
      declaredByLane[lane].add(decl.var);
      if (!laneVars[lane].has(decl.var)) {
        findings.push(
          `${decl.var} is declared for lane '${lane}' but ${lane}'s required-var list does not assert it`,
        );
      }
    }
  }

  // (2) no lane asserts a var it isn't declared to own.
  (Object.keys(laneVars) as ConfigLane[]).forEach((lane) => {
    for (const name of laneVars[lane]) {
      if (!declaredByLane[lane].has(name)) {
        findings.push(
          `lane '${lane}' asserts ${name} but it is not declared for that lane in config-coverage-baseline.ts`,
        );
      }
    }
  });

  return findings;
}

function main(): void {
  const findings = auditConfigCoverage();
  if (findings.length > 0) {
    console.error('config-coverage-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `config-coverage-audit: passed (${REQUIRED_VAR_DECLARATIONS.length} required vars, baseline ${CONFIG_COVERAGE_BASELINE})`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
