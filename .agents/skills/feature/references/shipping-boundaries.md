# Shipping boundaries

The feature workflow produces a verified, reviewed, review-ready change. Local
implementation authority does not imply authority for external state changes.

## Actions requiring explicit authorization

Require the user to authorize each applicable action or an explicitly scoped
bundle before performing it:

- create a commit when the request did not already ask for commits
- push a branch
- open or update a pull request
- merge a pull request
- push or reset the staging branch
- deploy staging or production
- apply a remote migration
- change a remote environment variable or feature flag
- run a production or staging runbook that mutates state
- remove a worktree or delete durable artifacts

Approval for one action does not imply the next action. “Implement the feature”
does not mean “deploy it.”

## Review-ready handoff

Before asking for the next authority boundary, report:

- branch and worktree
- observable behavior implemented
- material design decisions and deviations
- exact verification commands and current fingerprint result
- accepted and rejected review findings
- migration, flag, deployment, or rollback requirements
- remaining risks or skipped environmental checks
- the single next external action proposed

If the user authorizes shipping, continue incrementally and re-check remote
state immediately before each mutation. Use the repository's dedicated
GitHub, migration, flag, deployment, or runbook skill when applicable.

## State transitions

Transition to `shipped` only after the authorized terminal action has actually
succeeded and the repository's post-ship checks are complete. Do not use
`shipped` to mean “ready to ship,” “PR opened,” or “CI likely green.”
