import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deploymentLane,
  deploymentLaneFields,
  requiresProductionConfig,
  type DeploymentLaneEnv,
} from '../deployment-lane';

/**
 * Environment fixture for the safety-property tests. Wider than
 * `DeploymentLaneEnv` because two of the encoded sites read variables the lane
 * module deliberately does NOT model (`VERCEL_ENV`, `MOCK_EXTERNAL_APIS`).
 */
interface SiteEnv extends DeploymentLaneEnv {
  VERCEL_ENV?: string | undefined;
  MOCK_EXTERNAL_APIS?: string | undefined;
}

/** The lane-relevant environments. Railway values verified live on 2026-07-28. */
const BASE_ENVIRONMENTS: ReadonlyArray<{ label: string; env: SiteEnv }> = [
  {
    label: 'production Railway lane (NODE_ENV unset)',
    env: { RAILWAY_ENVIRONMENT_NAME: 'production' },
  },
  {
    label: 'staging Railway lane (NODE_ENV=production)',
    env: { RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production' },
  },
  {
    label: 'local NODE_ENV=production, no Railway variable',
    env: { NODE_ENV: 'production' },
  },
  {
    label: 'local NODE_ENV=test, no Railway variable',
    env: { NODE_ENV: 'test' },
  },
  { label: 'nothing set', env: {} },
  { label: 'VERCEL_ENV=production only', env: { VERCEL_ENV: 'production' } },
  {
    label: 'blank RAILWAY_ENVIRONMENT_NAME with NODE_ENV=test',
    env: { RAILWAY_ENVIRONMENT_NAME: '   ', NODE_ENV: 'test' },
  },
];

/** Each base environment crossed with the mock-mode variable the sites also read. */
const ENVIRONMENT_MATRIX: ReadonlyArray<{ label: string; env: SiteEnv }> =
  BASE_ENVIRONMENTS.flatMap(({ label, env }) => [
    { label: `${label} / MOCK_EXTERNAL_APIS unset`, env },
    {
      label: `${label} / MOCK_EXTERNAL_APIS=true`,
      env: { ...env, MOCK_EXTERNAL_APIS: 'true' },
    },
  ]);

/**
 * One call site, encoded twice: `original` is the expression in the tree today,
 * `migrated` is that same expression with its NODE_ENV term swapped for
 * `requiresProductionConfig`. The sites themselves are migrated in later
 * tickets, so they are encoded here rather than imported.
 */
interface Site {
  name: string;
  original: (env: SiteEnv) => boolean;
  migrated: (env: SiteEnv) => boolean;
}

// Sites are named by file + enclosing function, never by line number: these
// names are the map T2/T3 navigate by, nothing can catch drift in a string, and
// migrating these very files moves every line below the edit.

/** Sites where the predicate being true means a restriction APPLIES. */
const ENFORCEMENT_SITES: readonly Site[] = [
  {
    name: 'worker/config/startup-assert.ts assertProductionMockModeEnv',
    original: (env) => env.NODE_ENV === 'production' && env.MOCK_EXTERNAL_APIS === 'true',
    migrated: (env) => requiresProductionConfig(env) && env.MOCK_EXTERNAL_APIS === 'true',
  },
  {
    name: 'worker/config/startup-assert.ts assertWorkerPublicUrlFormat',
    original: (env) => env.NODE_ENV === 'production',
    migrated: (env) => requiresProductionConfig(env),
  },
  {
    // Receives nodeEnv from worker/index.ts:177 — migrating this site changes
    // the caller, not an in-place process.env read.
    name: 'worker/config/fastify-options.ts buildFastifyOptions log level',
    original: (env) => env.NODE_ENV === 'production',
    migrated: (env) => requiresProductionConfig(env),
  },
  {
    name: 'worker/jobs/OnboardingDemoWorker.ts handleOnboardingDemo mock leak guard',
    original: (env) => env.MOCK_EXTERNAL_APIS === 'true' && env.NODE_ENV === 'production',
    migrated: (env) => env.MOCK_EXTERNAL_APIS === 'true' && requiresProductionConfig(env),
  },
];

/** Sites where the predicate being true means enforcement is SKIPPED. */
const SKIP_SITES: readonly Site[] = [
  {
    name: 'worker/config/startup-assert.ts assertStripeWorkerEnv mockSkip',
    original: (env) => env.NODE_ENV !== 'production' && env.MOCK_EXTERNAL_APIS === 'true',
    migrated: (env) => !requiresProductionConfig(env) && env.MOCK_EXTERNAL_APIS === 'true',
  },
  {
    name: 'worker/config/startup-assert.ts assertCoreInfraEnv mockSkip',
    original: (env) => env.NODE_ENV !== 'production' && env.MOCK_EXTERNAL_APIS === 'true',
    migrated: (env) => !requiresProductionConfig(env) && env.MOCK_EXTERNAL_APIS === 'true',
  },
  {
    name: 'worker/config/startup-assert.ts assertAdminNotificationEmail',
    original: (env) => env.NODE_ENV !== 'production',
    migrated: (env) => !requiresProductionConfig(env),
  },
  {
    name: 'worker/config/startup-assert.ts assertAlertSinkEnv',
    original: (env) => env.NODE_ENV !== 'production',
    migrated: (env) => !requiresProductionConfig(env),
  },
  {
    name: 'worker/config/startup-assert.ts warnMissingProductionEnv',
    original: (env) => env.NODE_ENV !== 'production',
    migrated: (env) => !requiresProductionConfig(env),
  },
  {
    name: 'src/lib/config/worker.ts mockSkip',
    original: (env) => env.NODE_ENV !== 'production' && env.MOCK_EXTERNAL_APIS === 'true',
    migrated: (env) => !requiresProductionConfig(env) && env.MOCK_EXTERNAL_APIS === 'true',
  },
  {
    name: 'src/lib/shared/logger.ts serializeError error_stack gate',
    original: (env) => env.NODE_ENV !== 'production',
    migrated: (env) => !requiresProductionConfig(env),
  },
];

describe('deploymentLane', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('deploymentLane() prefers RAILWAY_ENVIRONMENT_NAME over NODE_ENV so staging is never reported as production', () => {
    expect(
      deploymentLane({ RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production' }),
    ).toBe('staging');

    // Same assertion through the zero-argument form production actually calls,
    // so the default env reader is pinned to the real variable NAMES. Injected
    // fixtures cannot catch a typo there, and a typo leaves #610 unfixed.
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'staging');
    vi.stubEnv('NODE_ENV', 'production');
    expect(deploymentLane()).toBe('staging');
  });

  it('deploymentLane() falls back to NODE_ENV when no Railway variable is present', () => {
    expect(deploymentLane({ NODE_ENV: 'production' })).toBe('production');
    expect(deploymentLane({ NODE_ENV: 'test' })).toBe('test');

    // Through the zero-argument form too, so the default reader's NODE_ENV name
    // is pinned the way title 1 pins its RAILWAY_ENVIRONMENT_NAME name.
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', undefined);
    vi.stubEnv('NODE_ENV', 'production');
    expect(deploymentLane()).toBe('production');
  });

  it('deploymentLane() returns development when neither RAILWAY_ENVIRONMENT_NAME nor NODE_ENV is set', () => {
    expect(deploymentLane({})).toBe('development');

    // Also through the zero-argument form: vitest sets NODE_ENV=test, so this
    // only reaches the default when the reader really is reading process.env.
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', undefined);
    vi.stubEnv('NODE_ENV', undefined);
    expect(deploymentLane()).toBe('development');
  });

  it('deploymentLane() treats a blank RAILWAY_ENVIRONMENT_NAME as absent and falls through to NODE_ENV', () => {
    expect(deploymentLane({ RAILWAY_ENVIRONMENT_NAME: '', NODE_ENV: 'test' })).toBe('test');
    expect(deploymentLane({ RAILWAY_ENVIRONMENT_NAME: '   ', NODE_ENV: 'test' })).toBe('test');
    expect(deploymentLane({ RAILWAY_ENVIRONMENT_NAME: '  ' })).toBe('development');
  });

  it('deploymentLane() passes an unrecognised Railway environment name through unchanged', () => {
    expect(deploymentLane({ RAILWAY_ENVIRONMENT_NAME: 'pr-1234', NODE_ENV: 'production' })).toBe(
      'pr-1234',
    );
    // Unchanged EXCEPT for surrounding whitespace, which is stripped rather
    // than passed through: '  pr-1234  ' would otherwise be a Sentry
    // environment distinct from 'pr-1234'. Pins trimming's return value, not
    // just its blank-detection.
    expect(deploymentLane({ RAILWAY_ENVIRONMENT_NAME: '  pr-1234  ' })).toBe('pr-1234');
  });
});

describe('requiresProductionConfig', () => {
  it('requiresProductionConfig() is true on the production Railway lane when NODE_ENV is unset', () => {
    expect(requiresProductionConfig({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
  });

  it('requiresProductionConfig() is true on staging so staging keeps the enforcement it has today', () => {
    expect(
      requiresProductionConfig({ RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production' }),
    ).toBe(true);
  });

  it('requiresProductionConfig() is true for a local NODE_ENV=production run with no Railway variable', () => {
    expect(requiresProductionConfig({ NODE_ENV: 'production' })).toBe(true);
  });

  it('requiresProductionConfig() is true on a deployed Vercel build where NODE_ENV is production and no Railway variable exists', () => {
    const vercelBuild: SiteEnv = { NODE_ENV: 'production', VERCEL_ENV: 'production' };
    expect(requiresProductionConfig(vercelBuild)).toBe(true);
  });

  it('requiresProductionConfig() is false for a local run with NODE_ENV=test and no Railway variable', () => {
    expect(requiresProductionConfig({ NODE_ENV: 'test' })).toBe(false);
    expect(requiresProductionConfig({})).toBe(false);
  });

  it('requiresProductionConfig() treats a blank RAILWAY_ENVIRONMENT_NAME as absent', () => {
    expect(requiresProductionConfig({ RAILWAY_ENVIRONMENT_NAME: '   ', NODE_ENV: 'test' })).toBe(
      false,
    );
    expect(requiresProductionConfig({ RAILWAY_ENVIRONMENT_NAME: '' })).toBe(false);
  });

  it('requiresProductionConfig() is false when only VERCEL_ENV is production, which is why the purge poller is not migrated to it', () => {
    const vercelOnly: SiteEnv = { VERCEL_ENV: 'production' };
    // AccountOffboardingPurgePoller.ts — the one site whose original expression
    // carries a VERCEL_ENV term the union does not model.
    const purgePollerOriginal = (env: SiteEnv) =>
      env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';

    expect(purgePollerOriginal(vercelOnly)).toBe(true);
    expect(requiresProductionConfig(vercelOnly)).toBe(false);
  });
});

// Both property tests below also assert NON-VACUITY: the migrated set must
// actually differ from the original somewhere in the matrix. The production
// Railway lane (NODE_ENV unset) is exactly the case #611 reports as inert, so a
// migration that changed nothing would satisfy the property while fixing
// nothing — the assertion is what makes each test able to fail.
// These two titles are double-quoted so their apostrophe stays UNESCAPED. The
// promised-test gate matches each locked title with a fixed-string grep against
// the file, so a `\'` here reads as a missing test even though the runtime name
// is correct.
describe('migration safety property', () => {
  it("for every enforcement site the set of environments where the gate applies only grows, checked per site against that site's original expression", () => {
    let grewSomewhere = false;
    for (const site of ENFORCEMENT_SITES) {
      for (const { label, env } of ENVIRONMENT_MATRIX) {
        if (site.original(env)) {
          expect(site.migrated(env), `${site.name} @ ${label}`).toBe(true);
        }
        if (site.migrated(env) && !site.original(env)) grewSomewhere = true;
      }
    }
    expect(grewSomewhere).toBe(true);
  });

  it("for every skip site the set of environments where enforcement is skipped only shrinks, checked per site against that site's original expression", () => {
    let shrankSomewhere = false;
    for (const site of SKIP_SITES) {
      for (const { label, env } of ENVIRONMENT_MATRIX) {
        if (site.migrated(env)) {
          expect(site.original(env), `${site.name} @ ${label}`).toBe(true);
        }
        if (site.original(env) && !site.migrated(env)) shrankSomewhere = true;
      }
    }
    expect(shrankSomewhere).toBe(true);
  });

  it('deploymentLane maps each environment to the lane name Sentry should report, verified as a value mapping rather than as a predicate', () => {
    const reported = BASE_ENVIRONMENTS.map(({ label, env }) => [label, deploymentLane(env)]);
    expect(reported).toEqual([
      ['production Railway lane (NODE_ENV unset)', 'production'],
      ['staging Railway lane (NODE_ENV=production)', 'staging'],
      ['local NODE_ENV=production, no Railway variable', 'production'],
      ['local NODE_ENV=test, no Railway variable', 'test'],
      ['nothing set', 'development'],
      ['VERCEL_ENV=production only', 'development'],
      ['blank RAILWAY_ENVIRONMENT_NAME with NODE_ENV=test', 'test'],
    ]);
  });
});

describe('deploymentLaneFields', () => {
  it('deploymentLaneFields() reports the resolved lane and names RAILWAY_ENVIRONMENT_NAME as the source when the Railway variable wins', () => {
    expect(
      deploymentLaneFields({ RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production' }),
    ).toEqual({ deployment_lane: 'staging', lane_source: 'RAILWAY_ENVIRONMENT_NAME' });
  });

  it('deploymentLaneFields() names NODE_ENV as the source when no Railway variable is present', () => {
    expect(deploymentLaneFields({ NODE_ENV: 'production' })).toEqual({
      deployment_lane: 'production',
      lane_source: 'NODE_ENV',
    });
    // Neither variable set: the lane is a default, not a reading, so there is
    // no honest source to name and the key is omitted (replicaIdentityFields'
    // "only defined values" convention).
    expect(deploymentLaneFields({})).toEqual({ deployment_lane: 'development' });
  });
});
