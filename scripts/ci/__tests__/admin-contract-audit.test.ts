import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditContractFiles, checkRouteTable, emitPortableDeclarations, generateAdminContract } from '../admin-contract-audit';

// See red-team-status.test.ts for the full reasoning. These CI audit suites
// build a fixture tree on disk and shell out, so one case costs far more than a
// unit test. The two contract-regeneration cases here measure ~2.7s and ~2.6s
// on an idle machine, which a loaded CI runner pushes past the 5,000ms default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'admin-contract-cli-')); roots.push(root);
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, allowJs: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@/*': ['./src/*'] } } }),
    'src/lib/admin/dto.ts': 'export interface Example { name: string; }',
    'src/lib/admin/api-contract.ts': "export type { Example } from './dto';",
    'src/lib/admin/value.js': '/** @returns {{ value: number }} */ export function typedValue() { return JSON.parse("{}"); }',
    'src/lib/auth/admin-mfa-gate.ts': 'export async function requireAdminWithAal2(_req: Request) { return {ok: true}; }',
    'src/app/api/admin/example/route.ts': `import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
      import { typedValue } from '@/lib/admin/value';
      import { z } from 'zod';
      const Input = z.object({name: z.string().trim().min(1)});
      export async function POST(req: Request) {
        await requireAdminWithAal2(req);
        const parsed = Input.safeParse(await req.json());
        return Response.json({success: parsed.success, value: typedValue().value}, {status: 201});
      }`,
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), contents);
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/ci/admin-contract-audit.ts'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  });
  return { root, run };
}

// #879 made `withSameOrigin` return-type-preserving, which types the wrapped
// `handler(req, …)` call as `Promise<TRes> | TRes`. `responseBearing` matched on
// symbol NAME only, so an unresolved type parameter read as not-a-Response, the
// walker stopped at the wrapper, and `/api/admin/impersonation/{start,end}` lost
// every response variant but the wrapper's own 403 — a silently emptied contract,
// not a failure. This fixture is the smallest shape that reproduces it.
function genericWrapperFixture() {
  const root = mkdtempSync(join(tmpdir(), 'admin-contract-generic-')); roots.push(root);
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: { '@/*': ['./src/*'] } } }),
    'src/lib/admin/dto.ts': 'export interface Example { name: string; }',
    'src/lib/admin/api-contract.ts': "export type { Example } from './dto';",
    'src/lib/auth/admin-mfa-gate.ts': 'export async function requireAdminWithAal2(_req: Request) { return {ok: true}; }',
    'src/lib/auth/route-helpers.ts': `type Handler<TRes extends Response = Response> = (req: Request) => Promise<TRes> | TRes;
      export function withSameOrigin(): <TRes extends Response>(handler: Handler<TRes>) => (req: Request) => Promise<TRes | Response> {
        return (handler) => async (req) => {
          if (req.headers.get('origin') !== 'https://app.example.com') {
            return Response.json({error: 'forbidden'}, {status: 403});
          }
          return handler(req);
        };
      }`,
    'src/app/api/admin/wrapped/route.ts': `import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
      import { withSameOrigin } from '@/lib/auth/route-helpers';
      async function wrapped(req: Request) {
        await requireAdminWithAal2(req);
        if (!req.headers.get('x-id')) return Response.json({error: 'missing_id' as const}, {status: 400});
        return Response.json({ok: true as const}, {status: 200});
      }
      export const GET = withSameOrigin()(wrapped);`,
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), contents);
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

describe('admin contract audit', () => {
  it('fails on edited declarations and missing or stale route rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-contract-audit-')); roots.push(root);
    const files = new Map([['admin-api.d.ts', 'export type Result = string;\n'], ['README.md', 'generated\n']]);
    for (const [file, contents] of files) writeFileSync(join(root, file), contents);
    expect(await auditContractFiles(root, files)).toEqual([]);
    writeFileSync(join(root, 'admin-api.d.ts'), 'export type Result = number;\n');
    expect((await auditContractFiles(root, files)).join('\n')).toContain('admin-api.d.ts');
    mkdirSync(join(root, 'schemas')); writeFileSync(join(root, 'schemas/stale.json'), '{}');
    expect((await auditContractFiles(root, files)).join('\n')).toContain('stale.json');
    const rows = [{ path: '/api/admin/test', methods: ['GET'], gates: ['GET: requireAdminWithAal2'] }];
    expect(checkRouteTable('| `/api/admin/test` | GET | GET: requireAdminWithAal2 | none | Test | 200 |', rows)).toEqual([]);
    expect(checkRouteTable('', rows).join()).toContain('missing');
    expect(checkRouteTable('| `/api/admin/gone` | GET | GET: requireAdminWithAal2 | none | Test | 200 |', rows).join()).toContain('stale');
    const aliases = mkdtempSync(join(tmpdir(), 'admin-contract-alias-')); roots.push(aliases);
    const alias = join(aliases, 'contract'); symlinkSync(root, alias, 'dir');
    await expect(auditContractFiles(alias, files)).rejects.toThrow('symlink');
  });

  it('detects route method and gate provenance drift', () => {
    const rows = [{ path: '/api/admin/test', methods: ['GET', 'POST'], gates: ['GET: requireAdminWithAal2', 'POST: requireAdminJson'] }];
    expect(checkRouteTable('| `/api/admin/test` | GET | GET: requireAdminWithAal2 | none | Test | 200 |', rows).join()).toContain('methods');
    expect(checkRouteTable('| `/api/admin/test` | GET, POST | GET: requireRole<br>POST: requireAdminJson | none | Test | 200 |', rows).join()).toContain('gate');
  });

  it('emits standalone declarations without repository aliases', () => {
    const declaration = emitPortableDeclarations('export type Result = { name: string; nested: {value: number | null} };');
    expect(declaration).toContain('export type Result');
    expect(declaration).not.toContain('@/');
    expect(() => emitPortableDeclarations('export type Result = MissingPrivateName;')).toThrow('MissingPrivateName');
    expect(() => emitPortableDeclarations('export type Result = HTMLElement;')).toThrow('HTMLElement');
    expect(emitPortableDeclarations('export type Result = { at: Date };')).toContain('at: Date');
  });

  // Parses the complete application type graph. Parallel CI coverage exceeded
  // 10s twice in run 34637163000; bound compiler work without narrowing inputs.
  it('reproduces the current contract including enriched responses and existing DTO exports', { timeout: 30_000 }, async () => {
    const generated = await generateAdminContract(process.cwd());
    expect(await auditContractFiles(resolve('docs/admin-api'), generated.files)).toEqual([]);
    const declarations = generated.files.get('admin-api.d.ts')!;
    for (const name of ['DemoListItem', 'SuspendedPolicyListItem', 'SendBreakerState', 'BusinessDetailResponse']) {
      expect(declarations).toContain(`export type ${name} =`);
    }
    expect(declarations).toMatch(/export type BusinessesIdGETResponse =[\s\S]*?"batchSummary"/);
    expect(declarations).toMatch(/export type BusinessesOptionsGETResponse =[\s\S]*?"betaCompActive": false \| true/);
    expect(generated.rows.find((row) => row.path === '/api/admin/businesses/options')).toEqual({
      path: '/api/admin/businesses/options', methods: ['GET'], gates: ['GET: requireAdminWithAal2'],
    });
  });

  // Five fresh CLI processes build the TypeScript graph. An isolated local run
  // takes ~13s; bound the complete round trip without dropping drift checks.
  it('regenerates an isolated contract and rejects drift through the real CLI', { timeout: 30_000 }, () => {
    const { root, run } = cliFixture();
    const generated = run('--write');
    expect(generated.stderr).toBe(''); expect(generated.status).toBe(0);
    const audit = run(); expect(audit.status, audit.stderr).toBe(0);
    const destination = join(root, 'docs/admin-api');
    expect(readFileSync(join(destination, 'admin-api.d.ts'), 'utf8')).toContain('"value": number | null');
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toContain('POST: 201');
    const schema = JSON.parse(readFileSync(join(destination, 'schemas/ExamplePOST-body-Input.json'), 'utf8'));
    expect(schema).toMatchObject({ 'x-repworth-approximation': true, properties: {name: {type: 'string', minLength: 1}} });
    writeFileSync(join(destination, 'admin-api.d.ts'), 'changed');
    const drift = run(); expect(drift.status).toBe(1); expect(drift.stderr).toContain('changed artifact admin-api.d.ts');
    writeFileSync(join(destination, 'schemas/stale.json'), '{}');
    expect(run('--write').status).toBe(0);
    expect(existsSync(join(destination, 'schemas/stale.json'))).toBe(false);
    expect(run().status).toBe(0);
  });

  // Builds one small TypeScript graph in a temp tree; no CLI process is spawned.
  it('descends into a handler wrapped by a return-type-preserving generic wrapper', { timeout: 30_000 }, async () => {
    const generated = await generateAdminContract(genericWrapperFixture());

    // The wrapper's OWN 403 is never the thing at risk — the walker always reached
    // it. The handler's 200 and 400 are what disappeared, so they are the assertion.
    const row = generated.rows.find((entry) => entry.path === '/api/admin/wrapped');
    expect(row).toBeDefined();
    const readme = generated.files.get('README.md')!;
    expect(readme).toContain('GET: 200, 400, 403');

    const declarations = generated.files.get('admin-api.d.ts')!;
    expect(declarations).toContain('"ok": true');
    expect(declarations).toContain('"error": "missing_id"');
  });

  it('rejects linked output roots and ancestors before reading or deleting outside artifacts', () => {
    for (const linked of ['docs/admin-api', 'docs']) {
      const { root, run } = cliFixture();
      const external = mkdtempSync(join(tmpdir(), 'admin-contract-sentinel-')); roots.push(external);
      const target = linked === 'docs' ? join(external, 'admin-api') : external;
      mkdirSync(target, { recursive: true });
      const sentinel = join(target, 'sentinel.txt'); writeFileSync(sentinel, 'preserve unrelated data');
      mkdirSync(dirname(join(root, linked)), { recursive: true });
      symlinkSync(external, join(root, linked), 'dir');
      for (const args of [['--write'], []]) {
        const result = run(...args);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('symlink');
        expect(readFileSync(sentinel, 'utf8')).toBe('preserve unrelated data');
      }
    }
  });

  it('rejects non-directory output ancestors without overwriting existing files', () => {
    for (const blocked of ['docs', 'docs/admin-api']) {
      const { root, run } = cliFixture();
      const existing = join(root, blocked);
      mkdirSync(dirname(existing), { recursive: true }); writeFileSync(existing, 'preserve existing file');
      for (const args of [[], ['--write']]) {
        const result = run(...args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('directory is required');
        expect(readFileSync(existing, 'utf8')).toBe('preserve existing file');
      }
    }
  });
});
