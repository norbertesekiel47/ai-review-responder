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
];

export default config;
