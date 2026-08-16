import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  scanRouteFile,
  scanAdminPageFile,
  readAdminPageGate,
  readPreAuthAdminPaths,
  routeGetRequiresAal2,
  pageRoutePath,
  siblingRouteFile,
  collectRouteFiles,
  collectAdminPageFiles,
  type PageScanContext,
} from '../admin-aal2-audit';

describe('scanRouteFile — admin AAL2 gate audit', () => {
  const adminPath = 'src/app/api/admin/businesses/route.ts';
  const nonAdminPath = 'src/app/api/owner/reviews/route.ts';

  it('(a) GET-only admin route → no finding', () => {
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export async function GET(request: Request) {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ ok: true });',
      '}',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(b) export const POST without the gate → finding', () => {
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export const POST = async (request: Request) => {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ ok: true });',
      '};',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('[admin-aal2]');
    expect(findings[0]).toContain(adminPath);
    expect(findings[0]).toContain('requireAdminWithAal2');
  });

  it('(c) export const POST WITH requireAdminWithAal2 → no finding', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'export const POST = async (request: Request) => {',
      '  const gate = await requireAdminWithAal2(request);',
      '  if (!gate.ok) return gate.response;',
      '  return Response.json({ ok: true });',
      '};',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(d) export async function PATCH variant without gate → finding', () => {
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export async function PATCH(request: Request) {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ ok: true });',
      '}',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('[admin-aal2]');
  });

  it('(e) non-admin path with a POST export → no finding (out of scope)', () => {
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export const POST = async (request: Request) => {',
      "  await requireRoleOr401(request, 'owner');",
      '  return Response.json({ ok: true });',
      '};',
    ].join('\n');
    expect(scanRouteFile(nonAdminPath, text)).toHaveLength(0);
  });

  it('(f) export async function DELETE with gate → no finding', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'export async function DELETE(request: Request) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  if (!gate.ok) return gate.response;',
      '  return Response.json({ deleted: true });',
      '}',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(g) export const PUT without gate → finding', () => {
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export const PUT = async (request: Request) => {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ ok: true });',
      '};',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('[admin-aal2]');
  });

  it('(h) thin delegator binding resolveAdminActor to the start runner → no finding (gated by resolver)', () => {
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, {',
      '    channel: "telegram",',
      '    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),',
      '  }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });

  it('(i) thin delegator binding resolveAdminActor to the cancel runner → no finding', () => {
    const channelPath = 'src/app/api/admin/channels/telegram/cancel/route.ts';
    const text = [
      "import { runChannelCancel } from '@/app/api/_shared/channels/action';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelCancel(sql, req, {',
      '    channel: "telegram",',
      '    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),',
      '  }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });

  it('(j) thin delegator binding resolveAdminActor to the disable runner → no finding', () => {
    const channelPath = 'src/app/api/admin/channels/telegram/disable/route.ts';
    const text = [
      "import { runChannelDisable } from '@/app/api/_shared/channels/action';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelDisable(sql, req, {',
      '    channel: "telegram",',
      '    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),',
      '  }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });

  it('(k) admin route binding resolveOwnerActor to a shared runner → FINDING (the runner is not itself a gate)', () => {
    // The regression this audit's allowlist exists to prevent, and the reason it
    // names the RESOLVER rather than the runners. runChannelStart is
    // portal-agnostic: it calls whatever resolveActor it is handed. An admin
    // route that bound the OWNER resolver would run under the owner role gate
    // with no MFA step-up. Crediting runChannelStart as a gated helper — the
    // naive successor to the three admin-only names it replaced — would let
    // exactly this file through.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveOwnerActor }),',
      ');',
    ].join('\n');
    const findings = scanRouteFile(channelPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('[admin-aal2]');
  });

  it('(l) admin route that MENTIONS resolveAdminActor in a comment but BINDS resolveOwnerActor → FINDING', () => {
    // Under the old text scan, any mention of resolveAdminActor cleared the
    // allowlist and every real channel route carries a header comment naming its
    // handler. The AST scan never reads comments at all, so the mention is
    // invisible in BOTH directions — and the binding is what is judged.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      '// POST /api/admin/channels/telegram/start — resolves via resolveAdminActor.',
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveOwnerActor }),',
      ');',
    ].join('\n');
    const findings = scanRouteFile(channelPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('must not reference resolveOwnerActor');
  });

  it('(m) admin route importing BOTH resolvers is still a FINDING', () => {
    // The deny rule outranks the allowlist deliberately: an admin route with a
    // live resolveAdminActor import is exactly the shape a half-finished edit
    // leaves behind, and "it also mentions the right one" must not clear it.
    const channelPath = 'src/app/api/admin/channels/telegram/cancel/route.ts';
    const text = [
      "import { runChannelCancel } from '@/app/api/_shared/channels/action';",
      "import { resolveAdminActor, resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelCancel(sql, req, { channel: "telegram", resolveActor: resolveOwnerActor }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(1);
  });

  it('(n) admin route binding resolveAdminActor is still clean (no false positive)', () => {
    // The deny rule must not flag the shipped shape: the 6 real admin channel
    // routes name only resolveAdminActor and must stay green.
    const channelPath = 'src/app/api/admin/channels/telegram/cancel/route.ts';
    const text = [
      "import { runChannelCancel } from '@/app/api/_shared/channels/action';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelCancel(sql, req, {',
      '    channel: "telegram",',
      '    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),',
      '  }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });

  it('(o) admin route whose COMMENT mentions resolveOwnerActor but binds resolveAdminActor is clean', () => {
    // The false positive the old deny rule produced on its first run: the real
    // admin telegram start route documents its owner counterpart ("The owner
    // equivalent ... binds the same runner with resolveOwnerActor") while
    // binding the admin resolver. A comment is not an Identifier, so the AST
    // scan cannot see it — the old `stripComments` step is retired, not fixed.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      '// POST /api/admin/channels/telegram/start — admin generates a deep link.',
      '//',
      '// The owner equivalent at /api/dashboard/channels/telegram/start binds the',
      '// same runner with resolveOwnerActor.',
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, {',
      '    channel: "telegram",',
      '    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),',
      '  }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The three verified holes the AST conversion closes. Each case below PASSED
// the predecessor text scan (verified by the Pathfinder S1 probe run) and must
// now fail.
// ---------------------------------------------------------------------------
describe('scanRouteFile — verb scoping, indirection and provenance', () => {
  const adminPath = 'src/app/api/admin/businesses/route.ts';

  it('(H3-a) mixed-verb file: GET is gated, POST is not → FINDING naming POST', () => {
    // HOLE 1. The old scan bound `stripComments(text)` to the WHOLE file and
    // both rules were `code.includes(...)`, so the compliant GET's gate call
    // cleared the ungated POST. Mixed-verb admin routes are the normal App
    // Router shape and this repo has them — src/app/api/admin/businesses/route.ts
    // really does carry a plain-admin GET beside an AAL2 POST.
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'export async function GET(request: Request) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  if (!gate.ok) return gate.response;',
      '  return Response.json({ ok: true });',
      '}',
      '',
      'export async function POST(request: Request) {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ created: true });',
      '}',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('mutation handler POST');
    expect(findings[0]).toContain('requireAdminWithAal2');
  });

  it('(H3-a2) mixed-verb file: a gated GET does NOT clear an ungated PATCH or DELETE', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'export async function GET(request: Request) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return Response.json({ ok: gate.ok });',
      '}',
      '',
      'export async function PATCH() { return Response.json({}); }',
      'export async function DELETE() { return Response.json({}); }',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.includes('mutation handler PATCH'))).toBe(true);
    expect(findings.some((f) => f.includes('mutation handler DELETE'))).toBe(true);
  });

  it('(H3-b) unused import of requireAdminWithAal2 with an ungated POST → FINDING', () => {
    // HOLE 2. Deleting the real call site left the import behind, and
    // `code.includes('requireAdminWithAal2')` still cleared the file. A gate
    // must be CALLED; an import declaration is never in a handler's reachable set.
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      '',
      'export async function POST(request: Request) {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({ created: true });',
      '}',
    ].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('mutation handler POST');
  });

  it('(H3-c) renaming re-export indirection binding the owner resolver → FINDING', () => {
    // HOLE 3. A one-line `export { resolveOwnerActor as resolveChannelActor }`
    // in a file this audit never reads launders the denied literal away. It is
    // NOT closed by following re-exports across files — it is closed because
    // `resolveChannelActor` is not a RECOGNIZED gate, and an unrecognized shape
    // is a finding rather than a pass.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveChannelActor } from '@/app/api/_shared/channels/actor-alias';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveChannelActor }),',
      ');',
    ].join('\n');
    const findings = scanRouteFile(channelPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('mutation handler POST');
  });

  it('(H3-c2) the Pathfinder "minimal passing-but-wrong shape": gated GET + alias-bound POST → FINDING', () => {
    // Shape E from docs/reviews/PATHFINDER-2026-08-15/01-flowcharts/s1-auth-gate-seam.md
    // §4.2 — the cheapest realistic defeat of the old audit, needing no
    // contrived string and no unused import. Both holes 1 and 3 at once.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveChannelActor } from '@/app/api/_shared/channels/actor-alias';",
      '',
      'export async function GET(req: NextRequest) {',
      '  const gate = await requireAdminWithAal2(req);',
      '  if (!gate.ok) return gate.response;',
      '  return Response.json({ ok: true });',
      '}',
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveChannelActor }),',
      ');',
    ].join('\n');
    const findings = scanRouteFile(channelPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('mutation handler POST');
  });

  it('(H3-c3) same-file alias of the owner resolver → FINDING (the denied literal survives the rename)', () => {
    // Case A from the same probe, and the correction to the claim that "an
    // aliased import would still clear it": `resolveOwnerActor` sits on the LEFT
    // of the `as` as a real Identifier node, so the deny rule reads it.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { resolveOwnerActor as pickActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: pickActor }),',
      ');',
    ].join('\n');
    const findings = scanRouteFile(channelPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('must not reference resolveOwnerActor');
  });

  it('(H3-d) thin-shim `resolveActor: resolveAdminActor` passed uncalled → PASS', () => {
    // The resolver may be handed to the runner as a bare value rather than
    // wrapped in an arrow. Both forms are a real binding of the admin resolver.
    const channelPath = 'src/app/api/admin/channels/whatsapp/disable/route.ts';
    const text = [
      "import { runChannelDisable } from '@/app/api/_shared/channels/action';",
      "import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelDisable(sql, req, { channel: "whatsapp", resolveActor: resolveAdminActor }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });

  it('(H3-e) `withSameOrigin()(inner)` delegation where `inner` gates → PASS', () => {
    // The shipped shape of src/app/api/admin/businesses/route.ts:105 —
    // `export const POST = withSameOrigin()(createBusiness)` with the gate call
    // inside createBusiness. The reachability walk must follow the local
    // identifier one hop to find it.
    const text = [
      "import { withSameOrigin } from '@/lib/auth/route-helpers';",
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'async function createBusiness(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  if (!gate.ok) return gate.response;',
      '  return Response.json({ created: true });',
      '}',
      '',
      'export const POST = withSameOrigin()(createBusiness);',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(H3-e2) delegation two hops deep still resolves → PASS', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'async function reallyDoIt(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return gate.ok ? Response.json({}) : gate.response;',
      '}',
      'const wrapped = (request: NextRequest) => reallyDoIt(request);',
      'export const POST = withSameOrigin()(wrapped);',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(H3-e3) `export { createBusiness as POST }` resolves through the local table → PASS', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      '',
      'async function createBusiness(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return gate.ok ? Response.json({}) : gate.response;',
      '}',
      '',
      'export { createBusiness as POST };',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(0);
  });

  it('(H3-f) a handler re-exported from another module → FINDING (fail closed)', () => {
    const text = ["export { POST } from './elsewhere';"].join('\n');
    const findings = scanRouteFile(adminPath, text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('re-exported from another module');
  });

  it('(H3-g) a STRING LITERAL naming the admin resolver earns nothing → FINDING', () => {
    // Case D from the probe, which PASSED the substring scan: the config carries
    // a tag string, not a binding. An AST scan reads Identifiers, so a literal
    // is invisible.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { pickActor } from '@/app/api/_shared/channels/actor-alias';",
      '',
      "const GATE_TAG = 'resolveAdminActor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", tag: GATE_TAG, resolveActor: pickActor }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(1);
  });

  it('(H3-h) provenance: a look-alike import from another module earns nothing → FINDING', () => {
    // `import { somethingElse as resolveAdminActor } from './evil'` binds the
    // trusted NAME to untrusted code. Credit requires the canonical module.
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '@/app/api/_shared/channels/start';",
      "import { somethingElse as resolveAdminActor } from '@/app/api/_shared/channels/evil';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveAdminActor }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(1);
  });

  it('(H3-h2) provenance: requireAdminWithAal2 imported from a look-alike module earns nothing', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/fake-gate';",
      '',
      'export async function POST(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return gate.ok ? Response.json({}) : gate.response;',
      '}',
    ].join('\n');
    expect(scanRouteFile(adminPath, text)).toHaveLength(1);
  });

  it('(H3-h3) relative specifiers for the canonical modules are still credited', () => {
    const channelPath = 'src/app/api/admin/channels/telegram/start/route.ts';
    const text = [
      "import { runChannelStart } from '../../../_shared/channels/start';",
      "import { resolveAdminActor } from '../../../_shared/channels/resolve-actor';",
      '',
      'export const POST = withSameOrigin()((req: NextRequest) =>',
      '  runChannelStart(sql, req, { channel: "telegram", resolveActor: resolveAdminActor }),',
      ');',
    ].join('\n');
    expect(scanRouteFile(channelPath, text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Admin PAGES. The rule is read-gate PARITY with the sibling route, derived
// from what the tree does — NOT "a page rendering a mutation surface needs
// AAL2", which is false here (see the businesses/[id] case below).
// ---------------------------------------------------------------------------
describe('readAdminPageGate', () => {
  const gate = (body: string[]) =>
    readAdminPageGate(
      ["import { requireAdminPage } from '@/lib/auth/page-gate';", ...body].join('\n'),
    );

  it('reads a plain requireAdminPage call', () => {
    expect(gate(['export default async function P() {', "  await requireAdminPage(sql, { from: '/admin/jobs' });", '}'])).toBe('plain');
  });

  it('reads { aal2: true }', () => {
    expect(gate(['export default async function P() {', "  await requireAdminPage(sql, { from: '/admin/flagged', aal2: true });", '}'])).toBe('aal2');
  });

  it('treats { aal2: false } as plain', () => {
    expect(gate(['export default async function P() {', "  await requireAdminPage(sql, { from: '/admin/jobs', aal2: false });", '}'])).toBe('plain');
  });

  it('treats a NON-literal aal2 as plain (fail closed — not provably a step-up)', () => {
    expect(gate(['export default async function P() {', "  await requireAdminPage(sql, { from: '/admin/x', aal2: someFlag });", '}'])).toBe('plain');
  });

  it('does NOT credit an unused import — a gate must be CALLED', () => {
    expect(gate(['export default async function P() { return null; }'])).toBe('none');
  });

  it('credits requireCurrentAal2FromSupabase (the impersonation view page shape)', () => {
    const text = [
      "import { requireCurrentAal2FromSupabase } from '@/lib/auth/mfa';",
      'export default async function P() {',
      '  const aal = await requireCurrentAal2FromSupabase(supabase);',
      '  return aal.ok ? null : null;',
      '}',
    ].join('\n');
    expect(readAdminPageGate(text)).toBe('aal2');
  });

  it('returns none for a page with no gate at all', () => {
    expect(readAdminPageGate('export default function P() { return null; }')).toBe('none');
  });
});

describe('readPreAuthAdminPaths — derived from src/proxy.ts, never hand-listed', () => {
  it('extracts the routePath !== exclusions from the admin block', () => {
    const proxy = [
      '// 3. Admin pages (except /admin/login, /admin/forgot-password, /admin/reset-password)',
      'if (',
      "  routePath.startsWith('/admin') &&",
      "  routePath !== '/admin/login' &&",
      "  routePath !== '/admin/forgot-password' &&",
      "  routePath !== '/admin/reset-password'",
      ') {',
      '  doThing();',
      '}',
    ].join('\n');
    expect([...readPreAuthAdminPaths(proxy)].sort()).toEqual([
      '/admin/forgot-password',
      '/admin/login',
      '/admin/reset-password',
    ]);
  });

  it('ignores non-/admin comparisons and comments', () => {
    const proxy = ["if (routePath !== '/login' && routePath !== '/dashboard') { x(); }"].join('\n');
    expect([...readPreAuthAdminPaths(proxy)]).toEqual([]);
  });
});

describe('routeGetRequiresAal2 — the parity anchor', () => {
  it('true when the exported GET calls the gate', () => {
    const text = [
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      'export async function GET(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return gate.ok ? Response.json({}) : gate.response;',
      '}',
    ].join('\n');
    expect(routeGetRequiresAal2(text)).toBe(true);
  });

  it('false when the GET uses only requireRoleOr401, even if a sibling POST gates', () => {
    // The shipped src/app/api/admin/businesses/route.ts shape — and the reason
    // /admin/businesses is correctly a plain-gated page.
    const text = [
      "import { requireRoleOr401 } from '@/lib/db/auth';",
      "import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';",
      'export async function GET(request: NextRequest) {',
      "  await requireRoleOr401(request, 'admin');",
      '  return Response.json({});',
      '}',
      'async function createBusiness(request: NextRequest) {',
      '  const gate = await requireAdminWithAal2(request);',
      '  return gate.ok ? Response.json({}) : gate.response;',
      '}',
      'export const POST = withSameOrigin()(createBusiness);',
    ].join('\n');
    expect(routeGetRequiresAal2(text)).toBe(false);
  });

  it('false when the route exports no GET at all', () => {
    expect(routeGetRequiresAal2('export const POST = 1;')).toBe(false);
  });
});

describe('scanAdminPageFile — admin page contract', () => {
  const preAuthPaths = new Set(['/admin/login', '/admin/forgot-password', '/admin/reset-password']);
  const ctx = (siblingGetRequiresAal2: boolean | null): PageScanContext => ({
    preAuthPaths,
    siblingGetRequiresAal2,
  });
  const plainPage = [
    "import { requireAdminPage } from '@/lib/auth/page-gate';",
    'export default async function P() {',
    "  await requireAdminPage(sql, { from: '/admin/x' });",
    '  return null;',
    '}',
  ].join('\n');
  const aal2Page = [
    "import { requireAdminPage } from '@/lib/auth/page-gate';",
    'export default async function P() {',
    "  await requireAdminPage(sql, { from: '/admin/x', aal2: true });",
    '  return null;',
    '}',
  ].join('\n');
  const ungatedPage = 'export default function P() { return null; }';

  it('(P1) an admin page with NO gate at all → FINDING', () => {
    const findings = scanAdminPageFile('src/app/admin/jobs/page.tsx', ungatedPage, ctx(false));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('must call requireAdminPage');
  });

  it('(P1) a pre-auth page derived from proxy.ts is exempt', () => {
    expect(scanAdminPageFile('src/app/admin/login/page.tsx', ungatedPage, ctx(null))).toHaveLength(0);
    expect(scanAdminPageFile('src/app/admin/reset-password/page.tsx', ungatedPage, ctx(null))).toHaveLength(0);
    expect(scanAdminPageFile('src/app/admin/forgot-password/page.tsx', ungatedPage, ctx(null))).toHaveLength(0);
  });

  it('(P2) sibling GET requires AAL2 but the page gates plain → FINDING', () => {
    // The bypass this rule exists for: /admin/flagged reads flagged draft text
    // straight out of Postgres in the server component, so an AAL1 admin refused
    // by GET /api/admin/flagged would be served the same rows by the page.
    const findings = scanAdminPageFile('src/app/admin/flagged/page.tsx', plainPage, ctx(true));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('{ aal2: true }');
    expect(findings[0]).toContain('src/app/api/admin/flagged/route.ts');
  });

  it('(P2) sibling GET requires AAL2 and the page gates AAL2 → clean', () => {
    expect(scanAdminPageFile('src/app/admin/flagged/page.tsx', aal2Page, ctx(true))).toHaveLength(0);
  });

  it('(P2) sibling GET is plain and the page is plain → clean (parity, not "pages need AAL2")', () => {
    // /admin/businesses, /admin/costs, /admin/jobs, /admin/notifications,
    // /admin/overview all sit here. "admin API ⇒ AAL2" is false, and so is
    // "admin page ⇒ AAL2".
    expect(scanAdminPageFile('src/app/admin/businesses/page.tsx', plainPage, ctx(false))).toHaveLength(0);
  });

  it('(P2) a page that gates AAL2 above its sibling GET is a SUPERSET, never a finding', () => {
    // /admin/demos, /admin/locations/csv-import, /admin/businesses/new and
    // /admin/impersonate each step up before a form renders as a UX affordance,
    // documented in each page's comment. Requiring MORE is always allowed.
    expect(scanAdminPageFile('src/app/admin/demos/page.tsx', aal2Page, ctx(false))).toHaveLength(0);
  });

  it('(P2) a page hosting mutation surfaces over a PLAIN GET is clean — the contract is READ parity', () => {
    // The rule this audit deliberately does NOT enforce. /admin/businesses/[id]
    // hosts five mutation surfaces (PATCH business, POST resend-invite /
    // ranking / zernio-queue / grant-extension, PUT keywords) whose routes are
    // ALL AAL2-gated, and the page is deliberately `aal2: false`: "Gate parity
    // with GET /api/admin/businesses/[id] — plain admin role, no AAL2."
    // Mutations are enforced at their own routes, which is the ROUTE half of
    // this audit. A "renders a mutation surface ⇒ AAL2" rule would flag this
    // correct page.
    expect(scanAdminPageFile('src/app/admin/businesses/[id]/page.tsx', plainPage, ctx(false))).toHaveLength(0);
  });

  it('(P2) no sibling route → P2 has no anchor and is skipped; P1 still applies', () => {
    expect(scanAdminPageFile('src/app/admin/security/page.tsx', plainPage, ctx(null))).toHaveLength(0);
    expect(scanAdminPageFile('src/app/admin/security/page.tsx', ungatedPage, ctx(null))).toHaveLength(1);
  });

  it('(P1) the impersonation view page shape (its own auth, requireCurrentAal2FromSupabase) is clean', () => {
    const text = [
      "import { requireCurrentAal2FromSupabase } from '@/lib/auth/mfa';",
      'export default async function P() {',
      '  const aal = await requireCurrentAal2FromSupabase(supabase);',
      '  return aal.ok ? null : null;',
      '}',
    ].join('\n');
    expect(
      scanAdminPageFile('src/app/admin/impersonate/[sessionId]/view/page.tsx', text, ctx(null)),
    ).toHaveLength(0);
  });

  it('ignores files outside src/app/admin and non-page.tsx files', () => {
    expect(scanAdminPageFile('src/app/dashboard/page.tsx', ungatedPage, ctx(null))).toHaveLength(0);
    expect(scanAdminPageFile('src/app/admin/layout.tsx', ungatedPage, ctx(null))).toHaveLength(0);
  });
});

describe('page ↔ route path mapping', () => {
  it('derives the route path from the page file', () => {
    expect(pageRoutePath('src/app/admin/flagged/page.tsx')).toBe('/admin/flagged');
    expect(pageRoutePath('src/app/admin/businesses/[id]/page.tsx')).toBe('/admin/businesses/[id]');
    expect(pageRoutePath('src/app/admin/locations/csv-import/page.tsx')).toBe('/admin/locations/csv-import');
  });

  it('derives the sibling route file', () => {
    expect(siblingRouteFile('src/app/admin/flagged/page.tsx')).toBe('src/app/api/admin/flagged/route.ts');
    expect(siblingRouteFile('src/app/admin/businesses/[id]/page.tsx')).toBe(
      'src/app/api/admin/businesses/[id]/route.ts',
    );
  });
});

// collectRouteFiles decides WHICH files scanRouteFile ever sees. An under-walk
// makes the whole audit pass vacuously — every case above proves nothing about a
// route the walker never handed over — so its scope rules are pinned here.
describe('collectRouteFiles / collectAdminPageFiles — audit scope', () => {
  let root: string;

  beforeAll(() => {
    // realpath: on macOS $TMPDIR is /var/folders/... symlinked to /private/var/...,
    // and `relative()` against the unresolved root would yield ../.. paths.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aal2-scope-')));

    const admin = join(root, 'src', 'app', 'api', 'admin');
    mkdirSync(join(admin, 'businesses'), { recursive: true });
    mkdirSync(join(admin, 'channels', 'telegram', 'start'), { recursive: true });
    mkdirSync(join(admin, 'channels', 'telegram', '__tests__'), { recursive: true });

    writeFileSync(join(admin, 'businesses', 'route.ts'), 'export const POST = 1;');
    writeFileSync(join(admin, 'channels', 'telegram', 'start', 'route.ts'), 'export const POST = 1;');
    // Must be ignored: not named route.ts.
    writeFileSync(join(admin, 'businesses', 'helpers.ts'), 'export const x = 1;');
    // Must be ignored: test directories are deliberately out of scope, and their
    // fixtures contain route-shaped strings that would produce phantom findings.
    writeFileSync(join(admin, 'channels', 'telegram', '__tests__', 'route.ts'), 'export const POST = 1;');

    const pages = join(root, 'src', 'app', 'admin');
    mkdirSync(join(pages, 'jobs'), { recursive: true });
    mkdirSync(join(pages, 'flagged', '__tests__'), { recursive: true });
    writeFileSync(join(pages, 'jobs', 'page.tsx'), 'export default function P() {}');
    writeFileSync(join(pages, 'layout.tsx'), 'export default function L() {}');
    writeFileSync(join(pages, 'flagged', '__tests__', 'page.tsx'), 'export default function P() {}');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('collects every route.ts under the tree, relative to root', async () => {
    const out: string[] = [];
    await collectRouteFiles(join(root, 'src', 'app', 'api', 'admin'), root, out);

    expect(out.sort()).toEqual([
      join('src', 'app', 'api', 'admin', 'businesses', 'route.ts'),
      join('src', 'app', 'api', 'admin', 'channels', 'telegram', 'start', 'route.ts'),
    ]);
  });

  it('skips __tests__ directories and non-route.ts files', async () => {
    const out: string[] = [];
    await collectRouteFiles(join(root, 'src', 'app', 'api', 'admin'), root, out);

    expect(out.some((p) => p.includes('__tests__'))).toBe(false);
    expect(out.some((p) => p.endsWith('helpers.ts'))).toBe(false);
  });

  it('returns quietly for a directory that does not exist', async () => {
    // A permissions or missing-path error must not fail the build. Pinned because
    // the swallow is deliberate and would otherwise read as a missing catch.
    const out: string[] = [];
    await expect(collectRouteFiles(join(root, 'no', 'such', 'dir'), root, out)).resolves.toBeUndefined();
    expect(out).toEqual([]);
  });

  it('collects page.tsx only — not layout.tsx, not __tests__ fixtures', async () => {
    const out: string[] = [];
    await collectAdminPageFiles(join(root, 'src', 'app', 'admin'), root, out);

    expect(out).toEqual([join('src', 'app', 'admin', 'jobs', 'page.tsx')]);
  });
});
