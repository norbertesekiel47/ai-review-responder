import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateRequestSchemas } from '../admin-contract-schemas';
import { describeRouteHandlers } from '../admin-aal2-audit';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files: Record<string, string>, method = 'POST') {
  const root = mkdtempSync(join(tmpdir(), 'admin-request-schema-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const program = ts.createProgram(Object.keys(files).map((name) => join(root, name)), {
    target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext, noEmit: true, skipLibCheck: true,
  });
  return generateRequestSchemas(program, program.getSourceFile(join(root, 'route.ts'))!, method);
}

describe('admin request schema source analysis', () => {
  it('generates request schemas without importing runtime modules', () => {
    const result = fixture({
      'schema.ts': `import { z } from 'zod'; throw new Error('runtime import forbidden');
        const MAX = 12; export const Input = z.object({ name: z.string().max(MAX) });`,
      'helper.ts': `export async function parse(request: Request, schema: unknown) {
        const raw = await request.json(); return schema.safeParse(raw);
      }`,
      'route.ts': `import { Input } from './schema'; import { parse } from './helper';
        export async function POST(request: Request) { return parse(request, Input); }`,
    });
    expect(result.body).toBe('json-schema');
    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]?.schema).toMatchObject({ type: 'object', properties: { name: { type: 'string', maxLength: 12 } } });
    expect(result.schemas[0]?.location).toBe('body');
  });

  it('labels padded and whitespace-only normalization disagreements', () => {
    const result = fixture({ 'route.ts': `import { z } from 'zod';
      const Input = z.object({ keywords: z.array(z.string().trim().min(1).max(3)) });
      export async function POST(req: Request) { return Input.safeParse(await req.json()); }` });
    const entry = result.schemas[0]!;
    expect(entry.approximation).toBe(true);
    expect(entry.limitations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'normalization', path: '$.keywords[]', operation: 'trim' })]));
    const runtime = z.string().trim().min(1).max(3);
    const properties = entry.schema.properties as Record<string, { items: { type: string; minLength: number; maxLength: number } }>;
    const projected = properties.keywords!.items;
    expect(projected).toMatchObject({ type: 'string', minLength: 1, maxLength: 3 });
    const acceptsProjectedLength = (value: string) => value.length >= projected.minLength && value.length <= projected.maxLength;
    expect(runtime.safeParse(' abc ').success).toBe(true);
    expect(acceptsProjectedLength(' abc ')).toBe(false);
    expect(runtime.safeParse('   ').success).toBe(false);
    expect(acceptsProjectedLength('   ')).toBe(true);
  });

  it('records refinements without executing their callbacks', () => {
    const result = fixture({ 'route.ts': `import { z } from 'zod';
      const Input = z.object({ name: z.string().refine(() => { throw new Error('never execute'); }) });
      export async function POST(req: Request) { return Input.safeParse(await req.json()); }` });
    expect(result.schemas[0]?.limitations[0]).toMatchObject({ kind: 'refinement', path: '$.name' });
    expect(result.schemas[0]?.limitations[0]?.source).toContain('never execute');
  });

  // Five fresh TypeScript programs exceed 5s under parallel CI coverage
  // (run 34637163000, attempt 2); keep every refusal fixture within a bounded case.
  it('refuses unsupported dynamic schema dependencies and getters', { timeout: 30_000 }, () => {
    for (const expr of ['z.string().max(getLimit())', 'z.object({ get name() { return z.string(); } })', 'z.string().refine(makeCallback())']) {
      expect(() => fixture({ 'route.ts': `import { z } from 'zod'; const Input = ${expr};
        export async function POST(req: Request) { return Input.safeParse(await req.json()); }` })).toThrow(/Unsupported request schema.*route.ts:\d+/);
    }
    expect(() => fixture({ 'route.ts': `import { z } from 'zod'; let Input = z.string();
      export async function POST(req: Request) { return Input.safeParse(await req.json()); }` })).toThrow(/mutable schema dependency/);
    expect(() => fixture({ 'route.ts': `import { z } from 'zod'; const Input = z.lazy(() => z.string());
      export async function POST(req: Request) { return Input.safeParse(await req.json()); }` })).toThrow(/Zod operation lazy/);
  });

  it('binds callback and parser parameters without including unused callbacks', () => {
    const result = fixture({
      'helper.ts': `export async function run(req: Request, config: { parse: (req: Request) => unknown }) { return config.parse(req); }
        export async function parse(req: Request, schema: unknown) { return schema.safeParse(await req.json()); }`,
      'route.ts': `import { z } from 'zod'; import { run, parse } from './helper';
        const Input = z.strictObject({ title: z.string() });
        export async function POST(req: Request) {
          const unused = async (req: Request) => z.number().safeParse(await req.json());
          return run(req, { parse: (request: Request) => parse(request, Input) });
        }`,
    });
    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]?.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('preserves union normalization paths and preprocessing uncertainty', () => {
    const result = fixture({ 'route.ts': `import { z } from 'zod';
      const Input = z.object({ name: z.union([z.string().trim(), z.number()]),
        email: z.preprocess(value => String(value), z.string()) });
      export async function POST(req: Request) { return Input.safeParse(await req.json()); }` });
    expect(result.schemas[0]?.limitations.map((entry) => entry.path).sort()).toEqual(['$.email', '$.name']);
    const properties = result.schemas[0]!.schema.properties as Record<string, unknown>;
    expect(properties.email).toEqual({});
  });

  it('separates parameters, JSON bodies, multipart, and bodyless methods', () => {
    const files = { 'route.ts': `import { z } from 'zod'; const Params = z.object({ id: z.uuid() });
      const Body = z.object({ note: z.string() });
      export async function POST(req: Request, { params }: { params: Promise<{id: string}> }) {
        Params.safeParse(await params); return Body.safeParse(await req.json());
      }
      export async function GET() { return {}; }
      export async function PUT(req: Request) { return req.formData(); }
      export async function PATCH(req: Request) { return req.json(); }` };
    expect(fixture(files).schemas.map((item) => item.location).sort()).toEqual(['body', 'path']);
    expect(fixture(files, 'GET').body).toBe('none');
    expect(fixture(files, 'PUT').body).toBe('multipart');
    expect(fixture(files, 'PATCH').body).toBe('hand-parsed-json');
  });

  it('refuses unmodeled request-derived parser inputs and follows imported body parsers', () => {
    for (const input of ['(await req.json()) ?? {}', '(await req.json()).payload', '{ payload: await req.json() }']) {
      expect(() => fixture({ 'route.ts': `import { z } from 'zod'; const Input = z.object({name: z.string().max(12)});
        export async function POST(req: Request) { return Input.safeParse(${input}); }` })).toThrow(/request-derived parser input/);
    }
    const result = fixture({
      'helper.ts': `import { z } from 'zod'; const Input = z.object({name: z.string().max(12)});
        export function parse(body: unknown) { return Input.safeParse(body); }`,
      'route.ts': `import { parse } from './helper';
        export async function POST(req: Request) { const body = await req.json(); return parse(body); }`,
    });
    expect(result.body).toBe('json-schema');
    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]?.schema).toMatchObject({properties: {name: {maxLength: 12}}});
  });

  it('recognizes current imported schemas and shared channel parsing', () => {
    const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
    const routes = [
      ['businesses', 'POST', 'json-schema'],
      ['businesses/[id]', 'PATCH', 'json-schema'],
      ['offboardings/[offboardingId]/provider-disposition', 'POST', 'json-schema'],
      ['channels/telegram/start', 'POST', 'hand-parsed-json'],
      ['locations/csv-import', 'POST', 'multipart'],
      ['businesses/options', 'GET', 'none'],
    ];
    const names = routes.map(([route]) => resolve(`src/app/api/admin/${route}/route.ts`));
    const program = ts.createProgram(names, parsed.options);
    for (const [index, [, method, body]] of routes.entries()) {
      const result = generateRequestSchemas(program, program.getSourceFile(names[index]!)!, method!);
      expect(result.body).toBe(body);
    }
  }, 30_000);

  it('accounts for every current admin method without runtime imports', () => {
    const root = resolve('src/app/api/admin');
    const names = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'route.ts')
      .map((entry) => join(entry.parentPath, entry.name));
    const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
    const program = ts.createProgram(names, parsed.options);
    const bodies = new Map<string, string>();
    for (const name of names) {
      for (const { method } of describeRouteHandlers(name, readFileSync(name, 'utf8'))) {
        const result = generateRequestSchemas(program, program.getSourceFile(name)!, method);
        bodies.set(`${name.slice(root.length)}/${method}`, result.body);
      }
    }
    expect(bodies.get('/autonomy/unsuspend/route.ts/POST')).toBe('json-schema');
    expect(bodies.get('/suppressions/lookup/route.ts/POST')).toBe('json-schema');
    for (const channel of ['telegram', 'whatsapp']) {
      for (const action of ['start', 'cancel', 'disable']) {
        expect(bodies.get(`/channels/${channel}/${action}/route.ts/POST`)).toBe('hand-parsed-json');
      }
    }
  }, 30_000);
});
