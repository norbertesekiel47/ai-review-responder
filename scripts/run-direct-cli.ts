import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface DirectCliInput {
  importMetaUrl: string;
  main: () => Promise<number>;
  onError: (error: unknown) => number;
}

/** Run a script entry point only when Node invoked that module directly. */
export function runDirectCli(input: DirectCliInput): void {
  const invokedPath = process.argv[1];
  if (!invokedPath || pathToFileURL(resolve(invokedPath)).href !== input.importMetaUrl) return;

  void input.main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => { process.exitCode = input.onError(error); });
}
