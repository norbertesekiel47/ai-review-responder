import { includeIgnoreFile } from '@eslint/compat';
import { fileURLToPath } from 'node:url';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Make ESLint's lint surface match git's tracked surface (== what CI lints).
// eslint-config-next 16 + ESLint 10 HARD-CRASH on any non-TS source file
// (`scopeManager.addGlobals is not a function`; see the `**/*.mjs` ignore note
// below), and the tracked tree is 100% TS so CI never trips it. But flat config
// does NOT honour .gitignore by default, so locally `eslint .` reaches gitignored
// scratch/tool artifacts (.understand-anything/**, .tmp-design/**, stray scripts)
// — .js/.jsx ones crash, others diverge from CI. Deriving ignores from the one
// authoritative source (.gitignore) keeps local == CI and is future-proof.
const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

// --- Reusable no-restricted-imports patterns (single source of truth) -------
// no-restricted-imports does NOT merge `patterns` across flat-config objects;
// each zone restates the bans it wants. Defining the patterns once here keeps
// the restatements honest. The guard test (src/__tests__/eslint-boundaries.test.ts)
// proves the *resolved* bans fire and don't over-fire.
const PARENT_TRAVERSAL_BAN = {
  regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
  message: 'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
};

const APP_LEAF_IMPORT_BAN = {
  group: ['@/app/*', '@/app/**'],
  message:
    'Route leaves (app/**) are terminal — non-route code must not import from app/. ' +
    'Move shared code into components/<domain> or lib/<domain>.',
};

// Invariant #1 (Vercel = UI only): the entry surface (app/**, components/**,
// instrumentation) must never RUNTIME-import worker-only modules. `import type`
// stays allowed (allowTypeImports) so shared DTOs are unaffected.
const invariantOne = (subject) =>
  `Invariant #1 (Vercel = UI only): ${subject} is worker-only — Next.js routes/` +
  'components must not runtime-import it. Move LLM/queue/DB work to a Railway ' +
  'worker; a type-only `import type` is allowed. See .claude/CLAUDE.md invariant #1.';

const VERCEL_FORBIDDEN_RUNTIME_IMPORTS = [
  { group: ['openai', 'openai/*'], allowTypeImports: true, message: invariantOne('the OpenAI SDK') },
  { group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'], allowTypeImports: true, message: invariantOne('the Anthropic SDK') },
  { group: ['bullmq', 'bullmq/*'], allowTypeImports: true, message: invariantOne('BullMQ') },
  { group: ['postgres', 'postgres/*'], allowTypeImports: true, message: invariantOne('the Postgres.js client') },
  {
    group: ['**/responses/generator', '**/responses/generator*', '@/lib/responses/generator', '@/lib/responses/generator*'],
    allowTypeImports: true,
    message: invariantOne('the LLM response generator'),
  },
  { group: ['**/worker/queues', '**/worker/queues*'], allowTypeImports: true, message: invariantOne('the worker queue registry') },
];

// no-restricted-imports is BLIND to dynamic import() — `await import('openai')`
// slips past the static bans above. These no-restricted-syntax selectors close
// that hole for the same modules. Dynamic import() is always runtime, so there
// is no allowTypeImports concern. Like no-restricted-imports, no-restricted-syntax
// does NOT merge across flat-config objects — each entry-surface zone restates
// what it wants (the guard test proves the resolved bans fire).
const VERCEL_FORBIDDEN_DYNAMIC_IMPORTS = [
  { selector: "ImportExpression[source.value=/^openai(\\/|$)/]", message: invariantOne('the OpenAI SDK') },
  { selector: "ImportExpression[source.value=/^@anthropic-ai\\/sdk(\\/|$)/]", message: invariantOne('the Anthropic SDK') },
  { selector: "ImportExpression[source.value=/^bullmq(\\/|$)/]", message: invariantOne('BullMQ') },
  { selector: "ImportExpression[source.value=/^postgres(\\/|$)/]", message: invariantOne('the Postgres.js client') },
  { selector: "ImportExpression[source.value=/(^|\\/)responses\\/generator/]", message: invariantOne('the LLM response generator') },
  { selector: "ImportExpression[source.value=/(^|\\/)worker\\/queues/]", message: invariantOne('the worker queue registry') },
];

// The existing dynamic @/app ban, extracted so the entry-surface zones that set
// their own no-restricted-syntax can RESTATE it (otherwise the no-merge footgun
// would silently drop the non-route zone's dynamic @/app ban for those files).
const APP_LEAF_DYNAMIC_IMPORT_BAN = {
  selector: "ImportExpression[source.value=/^@\\/app\\//]",
  message:
    'Route leaves (app/**) are terminal — non-route code must not dynamically import from app/. ' +
    'Move shared code into components/<domain> or lib/<domain>.',
};

/**
 * Flat-config replacement for the legacy `.eslintrc.json` (`extends:
 * next/core-web-vitals`). ESLint 10 dropped eslintrc support and Next 16
 * removed the `next lint` command, so linting now runs through the ESLint
 * CLI (`eslint src`) against this config. `eslint-config-next/core-web-vitals`
 * ships a ready-made flat-config array, so we just spread it.
 */
const config = [
  // Derived ignores: everything in .gitignore (node_modules, build output, and
  // local-only scratch/tool artifacts). Single source of truth — see header.
  includeIgnoreFile(gitignorePath, 'Imported .gitignore patterns'),
  {
    // `**/*.mjs` is excluded: eslint-config-next's globals handling calls
    // `scopeManager.addGlobals`, which ESLint 10 removed, so it hard-crashes on
    // ANY `.mjs` source (verified — even a one-line probe crashes). Our only
    // such file under src/ is the config helper src/lib/security/csp.mjs, which
    // stays covered by tsc (allowJs) + its vitest unit test. Revisit when
    // eslint-config-next ships ESLint 10 support.
    ignores: ['.next/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts', '**/*.mjs'],
  },
  ...nextCoreWebVitals,
  {
    // #269: dead imports/vars survived CI because no unused rule existed
    // anywhere (only react/jsx-no-undef). Enable the @typescript-eslint rule
    // (resolves via eslint-config-next — no new dependency). `^_` opts a binding
    // out (args, locals, caught errors) when it is intentionally unused.
    //
    // `files` is load-bearing, not cosmetic: eslint-config-next registers the
    // `@typescript-eslint` plugin ONLY for `**/*.{ts,tsx}`. A flat-config object
    // that references a plugin rule must be scoped to files where that plugin is
    // registered — otherwise ESLint hits a `.js/.jsx` file (e.g. a gitignored
    // scratch file locally), finds the rule but not the plugin, and HARD-CRASHES
    // config resolution ("could not find plugin @typescript-eslint"). CI never
    // tripped this only because the tracked tree is 100% TS. Keep this scope in
    // lockstep with config-next's TS plugin registration.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // Pin the React version so eslint-plugin-react skips runtime detection,
    // which calls the `context.getFilename()` API that ESLint 10 removed.
    settings: { react: { version: '19.2.6' } },
    rules: {
      // eslint-config-next 16 newly enables the React-Compiler-era hook rules,
      // which flagged existing, working patterns that predated the config bump.
      // All four are now adopted. Most violations were fixed idiomatically
      // (lazy state init, latest-ref writes moved into effects, prev-prop tracked
      // in state, list rows keyed by position); genuine framework-level cases
      // (cross-origin/hard navigation, SSR-only sessionStorage reads,
      // server-component Date.now(), fetch-on-mount) carry scoped per-line
      // disables with rationale.
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/refs': 'error',
    },
  },
  // ---------------------------------------------------------------------------
  // Structural boundaries — enforce docs/src-structure-preferences.md.
  // `no-restricted-imports` does NOT merge across flat-config objects: for a
  // given file the LAST matching object wins, so each more-specific zone below
  // RESTATES the bans it inherits. Order: least- to most-specific.
  // ---------------------------------------------------------------------------
  {
    // Base — all src: ban src-internal ../.. parent traversal. Cross-tree
    // imports into worker//scripts/ are exempt (they have no @/ alias).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PARENT_TRAVERSAL_BAN] }],
    },
  },
  {
    // Non-route code may not import @/app/** — STATIC or dynamic import().
    // Route leaves are terminal. app/** is exempt (co-located siblings import each
    // other); test files are exempt because they legitimately import route
    // handlers under test (e.g. `await import('@/app/api/.../route')` to exercise
    // a GET handler). The base zone above still applies the ../.. ban to tests.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/**', '**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PARENT_TRAVERSAL_BAN, APP_LEAF_IMPORT_BAN] }],
      // no-restricted-imports does NOT see import() — cover dynamic imports here.
      'no-restricted-syntax': ['error', APP_LEAF_DYNAMIC_IMPORT_BAN],
    },
  },
  {
    // components/ui/** are domain-agnostic primitives: no lib/<domain> (lib/ui +
    // lib/shared allowed), no app/**, no domain components — AND (invariant #1)
    // no worker-only runtime imports. Switched to @typescript-eslint/no-restricted-imports
    // for allowTypeImports; base rule off so there is exactly one restricted-imports
    // rule for these files. Restates inherited bans (no-merge footgun). Tests are
    // exempt (they don't ship to Vercel) — matching the other entry-surface zones.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [
          PARENT_TRAVERSAL_BAN,
          {
            regex: '^@/lib/(?!ui/|shared/)',
            message:
              'components/ui must stay domain-agnostic — no imports from lib/<domain>. ' +
              '(lib/ui and lib/shared utilities like cn() are allowed.)',
          },
          {
            regex: '^@/app/',
            message: 'components/ui must not import from app/** (route leaves are terminal).',
          },
          {
            regex: '^@/components/(?!ui/)',
            message:
              'components/ui must not import domain components — only other components/ui primitives.',
          },
          ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS,
        ],
      }],
      // This zone is the last matcher of no-restricted-syntax for ui source files,
      // so restate the dynamic @/app ban (else it is dropped) + the dynamic SDK bans.
      'no-restricted-syntax': ['error', APP_LEAF_DYNAMIC_IMPORT_BAN, ...VERCEL_FORBIDDEN_DYNAMIC_IMPORTS],
    },
  },
  {
    // Invariant #1 entry surface — app routes + instrumentation (run on Vercel).
    // No @/app ban here: app/** siblings may import each other (preserved from
    // the non-route zone, which ignores app/**). Base rule off; restate the
    // parent-traversal ban (no-merge footgun) so it is not dropped. Tests are
    // exempt (they don't ship to Vercel and legitimately import route handlers /
    // worker helpers under test) — matching the non-route zone's exemption; the
    // ../.. ban still reaches them via the base src/** zone.
    files: ['src/app/**/*.{ts,tsx}', 'src/instrumentation.ts'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [PARENT_TRAVERSAL_BAN, ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS],
      }],
      // Dynamic SDK bans only — NO dynamic @/app ban (app/** siblings may import
      // each other, consistent with the static side). app/** is exempt from the
      // non-route zone, so this zone is the sole no-restricted-syntax setter here.
      'no-restricted-syntax': ['error', ...VERCEL_FORBIDDEN_DYNAMIC_IMPORTS],
    },
  },
  {
    // Invariant #1 entry surface — domain components (ui handled by its own zone
    // above, so excluded here). Restates parent-traversal + @/app bans (the
    // non-route zone is no longer the last matcher for these files) plus the
    // worker-only runtime bans. Tests are exempt (they don't ship and legitimately
    // import route handlers under test) — matching the non-route zone; the ../..
    // ban still reaches them via the base src/** zone.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/**', '**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [PARENT_TRAVERSAL_BAN, APP_LEAF_IMPORT_BAN, ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS],
      }],
      // This zone is now the last matcher of no-restricted-syntax for these files,
      // so it CLOBBERS the non-route zone's dynamic @/app ban — restate it here +
      // add the dynamic SDK bans.
      'no-restricted-syntax': ['error', APP_LEAF_DYNAMIC_IMPORT_BAN, ...VERCEL_FORBIDDEN_DYNAMIC_IMPORTS],
    },
  },
];

export default config;
