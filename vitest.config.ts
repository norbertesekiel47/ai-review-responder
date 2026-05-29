import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
      pragma: 'React.createElement',
      importSource: 'react',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'scripts/ci/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'worker/**/__tests__/**/*.test.{ts,tsx}',
      'tests/**/__tests__/**/*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      // `include` makes the report cover every matching file (untested ones
      // show 0%), giving fallow a real repo-wide untested-risk signal.
      include: ['src/**/*.{ts,tsx}', 'worker/**/*.{ts,tsx}', 'scripts/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
