import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTargetApi, deliverContract, readContract } from '../../admin-contract-delivery';

const SOURCE_SHA = 'a'.repeat(40);
const PREFIX = 'docs/admin-api/';
const BRANCH = 'automation/admin-api-contract';
function sha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}
function snapshot(text = 'new contract'): Map<string, Buffer> {
  return new Map([[`${PREFIX}admin-api.d.ts`, Buffer.from(text)], [`${PREFIX}README.md`, Buffer.from('routes')]]);
}

// Stateful target service: running the real orchestrator twice must reuse its PR.
function target(initial = new Map<string, Buffer>()) {
  const state = { main: initial, branch: '', pulls: [] as { number: number; html_url: string }[], treeEntries: [] as { path: string; sha: string | null }[], failPr: false };
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const api = async <T>(path: string, method = 'GET', raw?: unknown): Promise<T> => {
    const body = (raw ?? {}) as Record<string, unknown>;
    calls.push({ path, method, body });
    let result: unknown;
    if (path === '/git/ref/heads/main') result = { object: { sha: 'main-commit' } };
    else if (path === '/git/trees/main-commit?recursive=1') result = { sha: 'main-tree', tree: [...state.main].map(([path, value]) => ({ path, sha: sha(value), type: 'blob', mode: '100644' })) };
    else if (path.startsWith('/pulls?')) result = state.pulls;
    else if (path.startsWith('/git/matching-refs/')) result = state.branch ? [{ ref: `refs/heads/${BRANCH}`, object: { sha: state.branch } }] : [];
    else if (path === '/git/blobs') result = { sha: sha(Buffer.from(body.content as string, 'base64')) };
    else if (path === '/git/trees') {
      state.treeEntries = body.tree as typeof state.treeEntries;
      result = { sha: 'updated-tree' };
    } else if (path === '/git/commits') result = { sha: `commit-${calls.length}` };
    else if (path.startsWith('/git/refs')) { state.branch = body.sha as string; result = {}; }
    else if (path === '/pulls' && method === 'POST') {
      if (state.failPr) throw new Error('PR creation failed');
      const pull = { number: 7, html_url: 'https://github.com/RepWorth/admin-app/pull/7' };
      state.pulls.push(pull); result = pull;
    } else if (path === '/pulls/7' && method === 'PATCH') {
      result = state.pulls[0];
      if (body.state === 'closed') state.pulls = [];
    } else throw new Error(`Unexpected API request ${method} ${path}`);
    return result as T;
  };
  return { api, state, calls };
}

describe('Admin API contract delivery', () => {
  it('creates one PR and updates it on the second source change, preserving target main', async () => {
    const service = target(new Map([['src/app/page.tsx', Buffer.from('target application')], [`${PREFIX}obsolete.json`, Buffer.from('{}')]]));
    await deliverContract(service.api, snapshot(), SOURCE_SHA);
    expect(service.state.treeEntries).toContainEqual({ path: `${PREFIX}obsolete.json`, mode: '100644', type: 'blob', sha: null });
    expect(service.state.treeEntries.every((entry) => entry.path.startsWith(PREFIX))).toBe(true);
    expect(service.calls.find((call) => call.path === '/git/trees')?.body.base_tree).toBe('main-tree');
    expect(service.calls.find((call) => call.path === '/pulls')?.body.body).toContain(`/commit/${SOURCE_SHA}`);
    expect(service.calls.find((call) => call.path === '/pulls')?.body.body).toContain('obsolete.json` (removed)');
    await deliverContract(service.api, snapshot('next contract'), 'b'.repeat(40));
    expect(service.calls.filter((call) => call.path === '/pulls' && call.method === 'POST')).toHaveLength(1);
    expect(service.calls.find((call) => call.path === '/pulls/7')?.body.body).toContain(`/commit/${'b'.repeat(40)}`);
    expect(service.calls.some((call) => call.method !== 'GET' && call.path.endsWith('/heads/main'))).toBe(false);
    expect(service.state.main.get('src/app/page.tsx')?.toString()).toBe('target application');
  });

  it('does nothing when the snapshot matches main and closes an obsolete PR after a revert', async () => {
    const service = target(snapshot());
    await deliverContract(service.api, snapshot(), SOURCE_SHA);
    expect(service.calls.every((call) => call.method === 'GET')).toBe(true);
    service.state.pulls = [{ number: 7, html_url: 'url' }];
    await deliverContract(service.api, snapshot(), SOURCE_SHA);
    expect(service.state.pulls).toEqual([]);
    expect(service.calls.filter((call) => call.method !== 'GET')).toEqual([{ path: '/pulls/7', method: 'PATCH', body: { state: 'closed' } }]);
  });

  it('fails visibly after a partial write and recovers using the same branch', async () => {
    const service = target();
    service.state.failPr = true;
    await expect(deliverContract(service.api, snapshot(), SOURCE_SHA)).rejects.toThrow('PR creation failed');
    expect(service.state.branch).not.toBe('');
    service.state.failPr = false;
    await deliverContract(service.api, snapshot(), SOURCE_SHA);
    expect(service.calls.filter((call) => call.path === '/git/refs' && call.method === 'POST')).toHaveLength(1);
    expect(service.state.pulls).toHaveLength(1);
  });

  it('refuses invalid source paths/SHAs and truncated target trees before any write', async () => {
    const service = target();
    await expect(deliverContract(service.api, new Map([['.github/workflows/attack.yml', Buffer.from('x')]]), SOURCE_SHA)).rejects.toThrow('Only docs/admin-api');
    await expect(deliverContract(service.api, snapshot(), 'not-sha')).rejects.toThrow('Invalid source');
    expect(service.calls).toHaveLength(0);
    const api = async <T>(path: string): Promise<T> => path.includes('/trees/')
      ? { truncated: true, tree: [] } as T : service.api<T>(path);
    await expect(deliverContract(api, snapshot(), SOURCE_SHA)).rejects.toThrow('truncated');
    expect(service.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('sends the scoped token only to the target API, refuses redirects, and reports sanitized errors', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 403 }));
    expect(() => createTargetApi('')).toThrow('Missing ADMIN_CONTRACT_DELIVERY_TOKEN');
    const api = createTargetApi('scoped-test-token', request);
    await expect(api('/git/ref/heads/main')).rejects.toThrow('returned HTTP 403');
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/RepWorth/admin-app/git/ref/heads/main', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer scoped-test-token' }) }));
    await expect(api('https://github.com/other')).rejects.toThrow('Invalid target');
    await expect(api('/../../ai-review-responder')).rejects.toThrow('Invalid target');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads exact file bytes and refuses symlinks or missing snapshot artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-delivery-'));
    try {
      mkdirSync(join(root, PREFIX), { recursive: true });
      expect(() => readContract(root)).toThrow('Missing contract');
      for (const [path, bytes] of snapshot()) writeFileSync(join(root, path), bytes);
      expect(readContract(root)).toEqual(snapshot());
      symlinkSync('/etc/hosts', join(root, PREFIX, 'secret-link'));
      expect(() => readContract(root)).toThrow('non-regular file');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('limits automatic delivery to contract changes on main and uses pinned light-runner actions with separate credentials', () => {
    const workflow = readFileSync('.github/workflows/admin-contract-delivery.yml', 'utf8');
    expect(workflow).toMatch(/push:\s+branches: \[main\]\s+paths: \['docs\/admin-api\/\*\*'\]/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('vars.CI_RUNNER_LIGHT');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toMatch(/permissions:\s+contents: read/);
    expect(workflow).toContain('token: ${{ github.token }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow.match(/ADMIN_CONTRACT_DELIVERY_TOKEN: \$\{\{ secrets.ADMIN_CONTRACT_DELIVERY_TOKEN \}\}/g)).toHaveLength(1);
    const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]);
    expect(actions).toHaveLength(2);
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/);
  });
});
