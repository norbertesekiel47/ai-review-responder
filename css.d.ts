// Ambient declaration for side-effect CSS imports (e.g. `import './globals.css'`).
// TypeScript 6 errors (TS2882) on side-effect imports of modules without a type
// declaration; Next.js handles CSS at the bundler level, so this stub satisfies
// the type checker without affecting runtime behavior.
declare module '*.css';
