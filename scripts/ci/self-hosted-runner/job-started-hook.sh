#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED — runs on the self-hosted runner before EVERY
# job (register-runner.sh wires it via the runner's `.env`). The runner is
# persistent (not --ephemeral), so this is where leftovers from a previous job
# are removed before the next one starts:
#   - stopped containers   (a `services: postgres` the runner failed to reap
#                           after a cancelled/crashed job — it would sit on
#                           port 5432 and make the next test job's container
#                           fail to bind)
#   - dangling networks    (the per-job network the runner creates for services)
#   - anonymous volumes    (postgres:16 declares VOLUME /var/lib/postgresql/data;
#                           every service container leaves one behind)
# The workspace itself is cleaned by actions/checkout (`clean: true`, the
# default). Never fail the job from here: hygiene is best-effort, and a hook
# non-zero exit fails the job before it starts.
set -uo pipefail

if command -v docker >/dev/null 2>&1; then
  docker container prune -f >/dev/null 2>&1 || true
  docker network prune -f >/dev/null 2>&1 || true
  docker volume prune -f >/dev/null 2>&1 || true
fi

echo "job-started hook: pruned stopped containers, dangling networks, anonymous volumes"
exit 0
