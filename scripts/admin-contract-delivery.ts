import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT_PATH = 'docs/admin-api/';
const DELIVERY_BRANCH = 'automation/admin-api-contract';
const TARGET_API = 'https://api.github.com/repos/RepWorth/admin-app';
type TreeEntry = { path: string; mode: string; type: string; sha: string };
type Tree = { sha: string; truncated?: boolean; tree: TreeEntry[] };
type PullRequest = { number: number; html_url: string };
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export function readContract(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function visit(directory: string): void {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) visit(`${path}/`);
      else if (entry.isFile()) files.set(path, readFileSync(resolve(root, path)));
      else throw new Error(`Contract contains a non-regular file: ${path}`);
    }
  }
  visit(CONTRACT_PATH);
  for (const required of ['README.md', 'admin-api.d.ts']) {
    if (!files.has(`${CONTRACT_PATH}${required}`)) throw new Error(`Missing contract ${required}`);
  }
  return files;
}

function blobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function createTargetApi(token: string, request: typeof fetch = fetch): Api {
  if (!token) throw new Error('Missing ADMIN_CONTRACT_DELIVERY_TOKEN; see docs/runbooks/admin-contract-delivery.md');
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    // No caller-controlled host/repository and no redirect may receive this token.
    if (!path.startsWith('/') || path.includes('..')) throw new Error('Invalid target API path');
    const response = await request(`${TARGET_API}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Do not log API bodies, request headers, or raw network errors containing credentials.
    if (!response.ok) throw new Error(`Admin contract delivery: ${method} ${path} returned HTTP ${response.status}`);
    return await response.json() as T;
  };
}

async function getTree(api: Api, ref: string): Promise<Tree> {
  const tree = await api<Tree>(`/git/trees/${ref}?recursive=1`);
  if (tree.truncated) throw new Error('Target tree is truncated; refusing a partial contract comparison');
  return tree;
}

function changedFiles(files: Map<string, Buffer>, tree: Tree): string[] {
  const previous = new Map(tree.tree.filter((entry) => entry.path.startsWith(CONTRACT_PATH) && entry.type !== 'tree')
    .map((entry) => [entry.path, entry]));
  return [...new Set([...files.keys(), ...previous.keys()])].sort().filter((path) => {
    const content = files.get(path);
    const old = previous.get(path);
    return !content || !old || old.mode !== '100644' || old.sha !== blobSha(content);
  });
}

async function commitContract(api: Api, files: Map<string, Buffer>, tree: Tree, parent: string, sourceSha: string): Promise<string> {
  const entries = [];
  for (const path of changedFiles(files, tree)) {
    const content = files.get(path);
    const blob = content ? await api<{ sha: string }>('/git/blobs', 'POST', {
      content: content.toString('base64'), encoding: 'base64',
    }) : null;
    entries.push({ path, mode: '100644', type: 'blob', sha: blob?.sha ?? null });
  }
  const updated = await api<{ sha: string }>('/git/trees', 'POST', { base_tree: tree.sha, tree: entries });
  const commit = await api<{ sha: string }>('/git/commits', 'POST', {
    message: `chore: sync Admin API contract from ${sourceSha}`,
    tree: updated.sha,
    parents: [parent],
  });
  return commit.sha;
}

export async function deliverContract(api: Api, files: Map<string, Buffer>, sourceSha: string): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid source commit SHA');
  if ([...files.keys()].some((path) => !path.startsWith(CONTRACT_PATH) || path.includes('..'))) {
    throw new Error('Only docs/admin-api files may be delivered');
  }
  const main = await api<{ object: { sha: string } }>('/git/ref/heads/main');
  const tree = await getTree(api, main.object.sha);
  const changed = changedFiles(files, tree);
  const pulls = await api<PullRequest[]>(`/pulls?state=open&head=RepWorth:${DELIVERY_BRANCH}&base=main`);
  if (pulls.length > 1) throw new Error('Multiple contract PRs exist; refusing to choose one');
  const pull = pulls[0];
  if (!changed.length) {
    if (pull) await api(`/pulls/${pull.number}`, 'PATCH', { state: 'closed' });
    return 'Contract already matches admin-app main; no delivery needed.';
  }
  // Rebuild only the bot-owned branch atop target main, preserving all non-contract files.
  // A fixed branch plus workflow concurrency makes retries update, never stack.
  const refs = await api<{ ref: string; object: { sha: string } }[]>(`/git/matching-refs/heads/${DELIVERY_BRANCH}`);
  const branch = refs.find((ref) => ref.ref === `refs/heads/${DELIVERY_BRANCH}`);
  const commit = await commitContract(api, files, tree, main.object.sha, sourceSha);
  if (branch) await api(`/git/refs/heads/${DELIVERY_BRANCH}`, 'PATCH', { sha: commit, force: true });
  else await api('/git/refs', 'POST', { ref: `refs/heads/${DELIVERY_BRANCH}`, sha: commit });
  const body = [
    'Generated contract from [RepWorth source merge commit]',
    `(https://github.com/RepWorth/ai-review-responder/commit/${sourceSha}).`,
    '\n\nSource of truth: `RepWorth/ai-review-responder/docs/admin-api/`. Review and merge this PR in admin-app.',
    '\n\nChanged contract files (relative to admin-app main):\n',
    ...changed.map((path) => `\n- \`${path}\`${files.has(path) ? '' : ' (removed)'}`),
  ].join('');
  const metadata = { title: 'chore: sync Admin API contract', body, base: 'main' };
  const result = pull
    ? await api<PullRequest>(`/pulls/${pull.number}`, 'PATCH', metadata)
    : await api<PullRequest>('/pulls', 'POST', { ...metadata, head: DELIVERY_BRANCH });
  return `Admin contract delivery ready: ${result.html_url}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const api = createTargetApi(process.env.ADMIN_CONTRACT_DELIVERY_TOKEN ?? '');
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(await deliverContract(api, readContract(process.cwd()), sourceSha));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Admin contract delivery failed');
    process.exitCode = 1;
  }
}
