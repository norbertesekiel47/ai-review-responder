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
    const cases = [
      { text: 'const body: unknown = {}; export function GET() { return NextResponse.json(body); }', error: /unknown/ },
      { text: 'export function GET() { return NextResponse.json({value: 1n}); }', error: /bigint/ },
      { text: 'export function GET() { return NextResponse.json(undefined); }', error: /undefined/ },
      { text: 'export function GET() { return NextResponse.json(Symbol("value")); }', error: /unsupported JSON type/ },
      { text: 'export function GET<T>() { let body!: T; return NextResponse.json(body); }', error: /unsupported JSON type/ },
      ...['{ toJSON() { return "different"; } }', '{} as { nested: {toJSON(): string} }', '[] as [string, number?]'].map((body) => ({
        text: `export function GET() { return NextResponse.json(${body}); }`, error: /toJSON|tuple/,
      })),
    ];
    // Each exported GET remains a separate module; only standard-library parsing
    // is shared instead of rebuilding the same compiler program eight times.
    const root = mkdtempSync(join(tmpdir(), 'admin-contract-unsupported-'));
    roots.push(root);
    const files = cases.map(({ text }, index) => {
      const file = join(root, `route-${index}.ts`);
      writeFileSync(file, `declare class NextResponse { static json(body: unknown, init?: {status: number}): NextResponse; }\n${text}`);
      return file;
    });
    const program = ts.createProgram(files, { strict: true, target: ts.ScriptTarget.ES2022 });
    cases.forEach(({ text, error }, index) => {
      expect(() => describeResponses(program, program.getSourceFile(files[index]!)!, 'GET'), text).toThrow(error);
    });
    expect(() => Response.json(undefined)).toThrow(TypeError);
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
    const refused = [
      ...['status = 418;', 'if (Date.now()) status = 418;'].map((assignment) => `export function GET() {
        let status = 200; ${assignment} return NextResponse.json({ok:true}, {status});
      }`),
      'function reply(status:number): NextResponse { status=418; return NextResponse.json({ok:true},{status}); } export function GET(){return reply(200);}',
      'function reply(status:number): NextResponse { (() => {status++;})(); return NextResponse.json({ok:true},{status}); } export function GET(){return reply(200);}',
      'export function GET(){const init={status:200}; init.status=418; return NextResponse.json({ok:true},init);}',
      'export function GET(){const init={status:200}; const alias=init; alias.status=418; return NextResponse.json({ok:true},init);}',
      'function change(init:{status:number}){init.status=418;} export function GET(){const init={status:200}; change(init); return NextResponse.json({ok:true},init);}',
      'export function GET(){const init={status:200}; init.status=418; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const init={status:200,change(){this.status=418;}}; init.change(); return NextResponse.json({ok:true},init);}',
      'export function GET(){const choices={ok:{status:200}}; const alias=choices.ok; alias.status=418; return NextResponse.json({ok:true},{status:choices.ok.status});}',
      'export const init={status:200}; export function GET(){return NextResponse.json({ok:true},init);}',
      'export function GET(){const init:{status?:number}={status:418}; delete init.status; return NextResponse.json({ok:true},{status:init.status!});}',
      'function change(init:{status:number}){init.status=418;} export function GET(){const choices={ok:{status:200}}; change(choices.ok); return NextResponse.json({ok:true},{status:choices.ok.status});}',
      'function reply(init:{status:number}):NextResponse {init.status=418; return NextResponse.json({ok:true},init);} export function GET(){return reply({status:200});}',
      'function reply(status:number):NextResponse {status+=218; return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {--status; return NextResponse.json({ok:true},{status});} export function GET(){return reply(419);}',
      'function reply(status:number):NextResponse {for(status of [418]){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'export function GET(){const init={status:200}; for(init.status of [418]){} return NextResponse.json({ok:true},init);}',
      'function reply(status:number):NextResponse {for([status] of [[418]]){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {for({code:status} of [{code:418}]){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:any):NextResponse {for(status in {418:true}){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'async function reply(status:number):Promise<NextResponse> {for await(status of [418]){} return NextResponse.json({ok:true},{status});} export async function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {var status=418; return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {var {code:status}={code:418}; return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {for(var status=418;false;){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {for(var status of [418]){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:any):NextResponse {for(var status in {418:true}){} return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {var [status]=[418]; return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:any):NextResponse {[...status]=[418]; return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:any):NextResponse {({...status}={code:418}); return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'function reply(status:number):NextResponse {({status=418}={}); return NextResponse.json({ok:true},{status});} export function GET(){return reply(200);}',
      'export function GET(){const init={status:200}; let copy={status:0}; ({copy=init}={}); copy.status=418; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const init:{status:number;read:number}={status:200,get read(){this.status=418;return 0;}}; void init.read; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const init:{status:number;read?:number;__proto__?:object}={status:200,__proto__:{get read(){Reflect.set(this,"status",418);return 0;}}}; void init.read; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const patch:Record<string,number>={status:418}; const init={status:200,...patch}; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const key:string="status"; const init={status:200,[key]:418}; return NextResponse.json({ok:true},{status:init.status});}',
      'const init={status:200}; export {init}; export function GET(){return NextResponse.json({ok:true},init);}',
      'export function GET(){const init={status:200,status:418}; return NextResponse.json({ok:true},{status:init.status});}',
      'export function GET(){const choices={ok:{status:200,get read(){this.status=418;return 0;}}}; void choices.ok.read; return NextResponse.json({ok:true},{status:choices.ok.status});}',
      'export function GET(){const init={status:200,1:0,"1":1}; return NextResponse.json({ok:true},{status:init.status});}',
    ];
    const preserved = [
      { text: 'function reply(status:number):NextResponse {return NextResponse.json({ok:true},{status});} export function GET(){const status=200; return reply(status);}', statuses: ['200'] },
      { text: 'export function GET(){const choices={ok:{status:200}}; const known=Math.random() ? choices.ok : undefined; if(known) return NextResponse.json({ok:true},{status:known.status}); return NextResponse.json({ok:false},{status:404});}', statuses: ['200','404'] },
      { text: 'export function GET(){const init={status:200}; return NextResponse.json({ok:true},init);}', statuses: ['200'] },
      { text: 'function reply(init:{status:number}):NextResponse {return NextResponse.json({ok:true},init);} export function GET(){return reply({status:200});}', statuses: ['200'] },
      { text: 'function reply(status:number):NextResponse {function shadow(){let status=0; status=418; return status;} shadow(); let copied=0; copied=status; const read=()=>status; read(); return NextResponse.json({copied},{status});} export function GET(){return reply(200);}', statuses: ['200'] },
      { text: 'export function GET(){const known={status:200}; if(!known) return NextResponse.json({ok:false},{status:404}); const selected=known?200:404; return NextResponse.json({selected},known);}', statuses: ['200','404'] },
      { text: 'export function GET(){const choices={ok:{status:200}}; const known=(choices.ok as {status:number})!; const direct=choices.ok.status; return NextResponse.json({direct},{status:known.status});}', statuses: ['200'] },
      { text: 'function reply(status:number):NextResponse {var status; for(var status;false;){} for(const value of [status]){void value;} for(const key in {[status]:true}){void key;} const {copy=status}={}; return NextResponse.json({copy},{status});} export function GET(){return reply(200);}', statuses: ['200'] },
      { text: 'function reply(status:number):NextResponse {let copy=0; ({copy=status}={}); return NextResponse.json({copy},{status});} export function GET(){return reply(200);}', statuses: ['200'] },
      { text: 'export function GET(){const init={"status":200,1:0,"meta":0}; return NextResponse.json({ok:true},init);}', statuses: ['200'] },
      { text: `const status=200; export default status;
        function defaults(value=status){return value;} class Holder {value=status;}
        const nested=[...[(<number>status satisfies number)],{...{status}}];
        const boxed=new Number(status); const table:Record<number,string>={}; const indexed=table[status];
        type Status=typeof status; const text=\`value:\${status}\`;
        function returns(){return status;} function throws(){throw status;}
        async function waits(){await status;} function* yields(){yield status;}
        function controls(){while(status){break;} do{break;}while(status); switch(status){case status:break;} for(status;status;status){break;}}
        export function GET(){return NextResponse.json({ok:true},{status});}`, statuses: ['200'] },
    ];
    // Each source remains an independent module; load the standard library once
    // for this behavioral matrix instead of rebuilding it for every fixture.
    const root = mkdtempSync(join(tmpdir(), 'admin-status-matrix-'));
    roots.push(root);
    const texts = [...refused, ...preserved.map((entry) => entry.text)];
    const files = texts.map((text, index) => {
      const file = join(root, `route-${index}.ts`);
      writeFileSync(file, `declare class NextResponse { static json(body:unknown, init?:{status:number}):NextResponse; }\n${text}`);
      return file;
    });
    const program = ts.createProgram(files, {strict:true, target:ts.ScriptTarget.ES2022});
    for (const [index, text] of refused.entries()) {
      expect(() => describeResponses(program, program.getSourceFile(files[index]!)!, 'GET'), text).toThrow('unresolved status');
    }
    for (const [index, entry] of preserved.entries()) {
      const source = program.getSourceFile(files[refused.length + index]!)!;
      expect(describeResponses(program, source, 'GET').map((response) => response.status).sort(), entry.text).toEqual(entry.statuses);
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

  // Six fresh TypeScript programs exceeded 5s twice under parallel CI coverage
  // (run 34637163000); bound compiler work without dropping uncertainty checks.
  it('derives finite status codes from domain errors and constant lookup maps', { timeout: 30_000 }, () => {
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
