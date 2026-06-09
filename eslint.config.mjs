import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/**
 * Flat-config replacement for the legacy `.eslintrc.json` (`extends:
 * next/core-web-vitals`). ESLint 10 dropped eslintrc support and Next 16
 * removed the `next lint` command, so linting now runs through the ESLint
 * CLI (`eslint src`) against this config. `eslint-config-next/core-web-vitals`
 * ships a ready-made flat-config array, so we just spread it.
 */
const config = [
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
    // Pin the React version so eslint-plugin-react skips runtime detection,
    // which calls the `context.getFilename()` API that ESLint 10 removed.
    settings: { react: { version: '19.2.6' } },
    rules: {
      // eslint-config-next 16 newly enables the React-Compiler-era hook rules.
      // They flag existing, working patterns that predate this config bump.
      // Kept off here to keep the upgrade non-breaking; adopting them is
      // tracked as a separate follow-up (see PR description).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
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
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
        ],
      }],
    },
  },
  {
    // Non-route code may not import @/app/** (route leaves are terminal).
    // app/** is exempt so co-located siblings can import each other.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
          {
            group: ['@/app/*', '@/app/**'],
            message:
              'Route leaves (app/**) are terminal — non-route code must not import from app/. ' +
              'Move shared code into components/<domain> or lib/<domain>.',
          },
        ],
      }],
    },
  },
  {
    // components/ui/** are domain-agnostic primitives: no lib/<domain> (lib/ui +
    // lib/shared allowed), no app/**, no domain components. Restates the above.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
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
        ],
      }],
    },
  },
];

export default config;
