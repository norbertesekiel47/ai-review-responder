import { describe, it, expect } from 'vitest';
import { scanRouteFile } from '../admin-aal2-audit';

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
    // The regression this audit's helper list exists to prevent, and the reason
    // it names the RESOLVER rather than the runners. runChannelStart is
    // portal-agnostic: it calls whatever resolveActor it is handed. An admin
    // route that bound the OWNER resolver would run under the owner role gate
    // with no MFA step-up. Listing runChannelStart as a gated helper — the
    // naive successor to the three admin-only names this replaced — would let
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

  it('(l) admin route that MENTIONS resolveAdminActor but BINDS resolveOwnerActor → FINDING', () => {
    // Case (k) passes only because its fixture never names the admin resolver.
    // The allowlist clearance is a substring test over the whole file, so any
    // mention of resolveAdminActor satisfies it — and every real channel route
    // carries a header comment naming its handler. Without the deny rule this
    // file is an admin mutation running under the owner role gate with no MFA
    // step-up, and CI is green. Reported by the step-7 adversarial review.
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
    // The false positive the deny rule produced on its first run, caught by the
    // gate: the real admin telegram start route documents its owner counterpart
    // ("The owner equivalent ... binds the same runner with resolveOwnerActor")
    // while binding the admin resolver. A whole-file substring test is wrong in
    // BOTH directions, which is why the scan reads comment-stripped code — a
    // mention must neither clear the allowlist nor trip the deny rule.
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
