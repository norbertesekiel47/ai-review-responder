import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const repo = resolve(source, '../../../../..');
const require = createRequire(resolve(repo, 'package.json'));
// Media dependencies live in the isolated runtime, so this project has its own
// strict compiler boundary. Every render validates it before bundling.
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', resolve(source, 'tsconfig.json'), '--pretty', 'false'], { stdio: 'inherit' });
