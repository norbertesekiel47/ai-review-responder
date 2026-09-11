import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { describeResponses, renderJsonType } from '../admin-contract-types';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'admin-contract-types-'));
  roots.push(root);
  const file = join(root, 'route.ts');
  writeFileSync(file, `declare class NextResponse { static json(body: unknown, init?: {status: number}): NextResponse; }\n${text}`);
  const program = ts.createProgram([file], { strict: true, target: ts.ScriptTarget.ES2022 });
  return { program, source: program.getSourceFile(file)! };
}

describe('compiler-derived response contracts', () => {
  it('emits portable wire declarations for composed responses and JSON serialization', () => {
    const { program, source } = fixture(`
      const detail = {} as { name: string; payload: unknown; optional?: string; date: Date; number: number; slots: unknown[]; hook: () => void; callbackOrText: string | (() => void); callbacks: (() => void)[] };
      const batchSummary = null as { id: string } | null;
      export function GET() { return NextResponse.json({ ...detail, batchSummary }); }
    `);
    const responses = describeResponses(program, source, 'GET');
    expect(responses).toHaveLength(1);
    const type = responses[0]!.body;
    expect(type).toContain('"batchSummary": null | { "id": string; }');
    expect(type).toContain('"payload"?: JsonValue');
    expect(type).toContain('"date": string | null');
    expect(type).toContain('"number": number | null');
    expect(type).toContain('"optional"?: string');
    expect(type).toContain('"slots": Array<JsonValue>');
    expect(type).not.toContain('"hook"');
    expect(type).toContain('"callbackOrText"?: string');
    expect(type).toContain('"callbacks": Array<null>');
    expect(type).not.toContain('@/');
  });

  it('specializes nested response helpers and configuration callbacks', () => {
    const { program, source } = fixture(`
      function json(body: unknown, status = 200): NextResponse { return NextResponse.json(body, {status}); }
      function error(code: string, status: number): NextResponse { return json({error: code}, status); }
      function run(config: { assertEnvReady: () => NextResponse | null }): NextResponse {
        const env = config.assertEnvReady(); if(env) return env;
        return json({deepLink: 'url'});
      }
      function wrap(handler: () => NextResponse) { return () => handler(); }
      export const POST = wrap(() => run({assertEnvReady: () => error('disabled', 503)}));
    `);
    const responses = describeResponses(program, source, 'POST');
    expect(responses.map((item) => item.status).sort()).toEqual(['200', '503']);
    expect(responses.some((item) => item.status === '503' && item.body.includes('"error"'))).toBe(true);
    expect(responses.some((item) => item.status === '200' && item.body.includes('"deepLink"'))).toBe(true);
  });

  it('rejects unsupported wire response types', () => {
    const { program, source } = fixture('const body: unknown = {}; export function GET() { return NextResponse.json(body); }');
    expect(() => describeResponses(program, source, 'GET')).toThrow('unknown');
    const bigint = fixture('export function GET() { return NextResponse.json({value: 1n}); }');
    expect(() => describeResponses(bigint.program, bigint.source, 'GET')).toThrow('bigint');
    const absent = fixture('export function GET() { return NextResponse.json(undefined); }');
    expect(() => describeResponses(absent.program, absent.source, 'GET')).toThrow('undefined');
    expect(() => Response.json(undefined)).toThrow(TypeError);
    for (const body of ['{ toJSON() { return "different"; } }', '{} as { nested: {toJSON(): string} }', '[] as [string, number?]']) {
      const custom = fixture(`export function GET() { return NextResponse.json(${body}); }`);
      expect(() => describeResponses(custom.program, custom.source, 'GET')).toThrow(/toJSON|tuple/);
    }
  });

  it('preserves distinct response calls and nested bindings on the same line', () => {
    const { program, source } = fixture(`
      function reply(body: unknown, status: number): NextResponse { return NextResponse.json(body, {status}); }
      function nested(body: unknown, status: number): NextResponse { return reply(body, status); }
      export function GET() { if (Date.now()) return nested({ok: true}, 200); return nested({error: 'later'}, 418); }
    `);
    const responses = describeResponses(program, source, 'GET');
    expect(responses.map((item) => item.status).sort()).toEqual(['200', '418']);
    expect(responses.find((item) => item.status === '200')?.body).toContain('"ok"');
    expect(responses.find((item) => item.status === '418')?.body).toContain('"error"');
  });

  it('refuses mutable status bindings instead of reporting their initial values', () => {
    for (const assignment of ['status = 418;', 'if (Date.now()) status = 418;']) {
      const { program, source } = fixture(`export function GET() {
        let status = 200; ${assignment} return NextResponse.json({ok:true}, {status});
      }`);
      expect(() => describeResponses(program, source, 'GET')).toThrow('unresolved status');
    }
  });

  it('preserves inline dictionary signatures and refuses unresolved object spreads', () => {
    const { program, source } = fixture(`
      declare const values: Record<string, number>;
      export function GET() { return NextResponse.json({...values}); }
      export function POST() { const body = {...values}; return NextResponse.json(body); }
    `);
    const inline = describeResponses(program, source, 'GET')[0]!.body;
    expect(inline).toContain('[key: string]: number | null | undefined');
    expect(inline).toBe(describeResponses(program, source, 'POST')[0]!.body);
    const unknown = fixture('declare const value: any; export function GET() { return NextResponse.json({...value}); }');
    expect(() => describeResponses(unknown.program, unknown.source, 'GET')).toThrow('unknown/any');
  });

  it('rejects unresolved response-producing callbacks', () => {
    const { program, source } = fixture('declare const callback: () => NextResponse; export function GET() { return callback(); }');
    expect(() => describeResponses(program, source, 'GET')).toThrow('unresolved');
    const opaque = fixture('declare const opaque: NextResponse; export function GET() { if (Date.now()) return opaque; return NextResponse.json({ok:true}); }');
    expect(() => describeResponses(opaque.program, opaque.source, 'GET')).toThrow('unresolved response return');
  });

  it('derives finite status codes from domain errors and constant lookup maps', () => {
    const { program, source } = fixture(`
      class DomainError extends Error { constructor(readonly status: number) { super(); } }
      function service() { throw new DomainError(409); }
      const codes = { absent: 404, blocked: 422 };
      export function POST() { try { service(); } catch (err) {
        if (err instanceof DomainError) return NextResponse.json({error: 'domain'}, {status: err.status});
      } return NextResponse.json({error:'lookup'}, {status: codes[Math.random() ? 'absent' : 'blocked']}); }
    `);
    expect(describeResponses(program, source, 'POST').map((item) => item.status).sort()).toEqual(['404, 422', '409']);
    const unknown = fixture('declare const status: number; export function GET() {return NextResponse.json({ok:true},{status});}');
    expect(() => describeResponses(unknown.program, unknown.source, 'GET')).toThrow('unresolved status');
    for (const expression of ['Math.random() ? 400 : unknown', '({known: 400, unknown})[Math.random() ? "known" : "unknown"]']) {
      const partial = fixture(`declare const unknown: number; export function GET() { return NextResponse.json({error: 'bad'}, {status: ${expression}}); }`);
      expect(() => describeResponses(partial.program, partial.source, 'GET')).toThrow('unresolved status');
    }
    const opaqueInit = fixture('declare const init: {status: number}; export function GET() { return NextResponse.json({ok:true}, init); }');
    expect(() => describeResponses(opaqueInit.program, opaqueInit.source, 'GET')).toThrow('response init');
    const partialHelper = fixture(`declare const other: {status: number};
      function decision() { return Math.random() ? {status: 409} : other; }
      export function GET() { return NextResponse.json({error: 'bad'}, {status: decision().status}); }`);
    expect(() => describeResponses(partialHelper.program, partialHelper.source, 'GET')).toThrow('unresolved status');
  });

  it('does not include uncalled local response helpers or erase mutated local flow types', () => {
    const { program, source } = fixture(`
      export function GET() {
        const unused = () => NextResponse.json({secret: true}, {status: 418});
        const body: Record<string, unknown> = {error:'failure'};
        body.detail = 'detail';
        return NextResponse.json(body, {status:400});
      }
    `);
    const responses = describeResponses(program, source, 'GET');
    expect(responses.map((item) => item.status)).toEqual(['400']);
    expect(responses[0]!.body).toContain('[key: string]: JsonValue');
    expect(responses[0]!.body).not.toContain('secret');
  });

  it('preserves source DTO uncertainty separately from successful JSON wire types', () => {
    const { program, source } = fixture('export interface DTO { payload: unknown; date: Date; value: number; }');
    const checker = program.getTypeChecker();
    const declaration = source.statements.find(ts.isInterfaceDeclaration)!;
    expect(renderJsonType(checker, checker.getTypeAtLocation(declaration), declaration, false)).toContain('"payload": unknown');
    expect(JSON.stringify({ bad: new Date('bad'), infinite: Infinity, empty: undefined, slots: [undefined] })).toBe('{"bad":null,"infinite":null,"slots":[null]}');
  });
});
