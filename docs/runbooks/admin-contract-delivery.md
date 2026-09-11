# Admin API contract delivery

Owner: ADR 0028 D3 / #1191. `docs/admin-api/` in
`RepWorth/ai-review-responder` is authoritative. The **Admin contract delivery**
workflow copies the current main snapshot into one PR in `RepWorth/admin-app`.
It never updates target main, executes target code, or checks out the target repo.

## Credential installation

Create a **fine-grained personal access token**, resource owner **RepWorth**,
repository access **Only select repositories → admin-app**. Repository permissions:

- **Contents: Read and write** (read trees, create blobs/commits, update the bot branch).
- **Pull requests: Read and write** (find/create/update/close the delivery PR).
- **Metadata: Read-only** (GitHub includes this automatically).

Grant no other permissions and do not select `ai-review-responder`. Set a bounded
expiration and rotate before it expires. If organization approval is required,
approve the request before dispatching. A classic PAT or the operator's broad
`gh auth` token is **not** a substitute. The delivery credential must not have
access to the private source repo. See GitHub's
[fine-grained token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [endpoint permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Install it as the **source repository Actions secret**
`ADMIN_CONTRACT_DELIVERY_TOKEN` at
[source Actions secrets](https://github.com/RepWorth/ai-review-responder/settings/secrets/actions).
Alternatively run the following command and paste only that scoped token into its
hidden prompt; do not put the token in shell arguments, files, or issue comments:

```bash
gh secret set ADMIN_CONTRACT_DELIVERY_TOKEN --repo RepWorth/ai-review-responder
```

The source checkout uses `github.token` with `contents: read` and
`persist-credentials: false`. Only the delivery step receives the target token.
Every authenticated delivery request uses the hard-coded target repository API
and rejects redirects. No package installation or target-repository code runs in
the delivery job. This split is why the target token needs no source read access.

## Trigger, bootstrap, and recovery

Merges to source main that change `docs/admin-api/**` start the job; other changes
do not. Since #1190's initial snapshot predates this workflow, dispatch once after
this workflow is merged and its secret installed:

```bash
gh workflow run admin-contract-delivery.yml --ref main --repo RepWorth/ai-review-responder
gh run list --workflow admin-contract-delivery.yml --repo RepWorth/ai-review-responder --limit 3
```

Dispatch has no inputs and only runs on main. Both triggers read **current main**
when the job starts, preventing delayed runs from copying an older event snapshot.
The PR links the checked-out source commit and lists additions, changes, and
removals relative to target main. A source commit URL requires source access;
admin-app developers can review the copied files without that access.

The reserved branch `automation/admin-api-contract` belongs only to this workflow.
Do not edit it manually. Each run rebuilds it from target main plus the source
contract and updates the existing open PR. All other target files are preserved;
contract files removed in the source are also removed in the copy. If source and
target main already match, no commit/PR is created and any obsolete open delivery
PR is closed. Delivery PRs require the normal admin-app review/merge process.

Runs are serialized with cancellation disabled. An API failure fails the workflow;
no source credentials or API response bodies are logged. A failure after creating
a branch or updating the branch is recoverable by dispatching again: the reserved
branch and open PR are rediscovered. There are no automatic write retries after an
ambiguous network response. For HTTP 401/403, check token expiry, organization
approval, selected repo, and both permissions, then rotate or correct the secret.
For a branch-rules failure, inspect the target policy; never bypass target main
protections. For a truncated tree, investigate before retrying; partial snapshots
are refused. Re-dispatch is safe even after a successful run.

## Verification

Locally, `pnpm exec vitest run scripts/ci/__tests__/admin-contract-delivery.test.ts`
exercises creation, updating instead of stacking, deletion/preservation, no-op,
revert closure, failure/recovery, and the target-token request boundary. Workflow
assertions cover main/path filtering, pinned actions, light runner, and credential
separation. No product browser journey changes.

After bootstrap, inspect the Actions result and linked admin-app PR. Confirm the
source SHA, changed-file list, and byte-for-byte copied contract. The next real
contract merge while that PR remains open must update the same PR number. Record
the workflow run and target PR URLs on #1191; do not call delivery operational
before the scoped secret and first successful run exist.
