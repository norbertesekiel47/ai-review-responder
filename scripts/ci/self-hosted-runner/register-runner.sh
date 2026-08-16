#!/usr/bin/env bash
# Runs INSIDE the Lima VM (install.sh copies it in and invokes it). Downloads
# the GitHub Actions runner, registers it against the repo, installs the
# per-job hygiene hook, and starts it as a systemd service so it survives VM
# reboots. Idempotent: re-running re-registers the same runner name.
#
# Required env: REPO_URL (https://github.com/<owner>/<repo>), REG_TOKEN (a
# registration token from POST /repos/{owner}/{repo}/actions/runners/registration-token
# — valid ~1 hour, only good for registering; install.sh mints it with `gh`).
# Optional: RUNNER_NAME (default repworth-mac-lima), RUNNER_VERSION (default
# latest release), RUNNER_LABELS (default self-hosted,linux,<arch>,repworth-mac).
#
# Persistent, NOT --ephemeral, on purpose: an ephemeral runner needs a fresh
# registration token before every job, i.e. an admin-scoped credential living
# on the box. Hygiene comes instead from actions/checkout's per-job clean and
# job-started-hook.sh (containers/networks/anon volumes). Runbook:
# docs/runbooks/self-hosted-ci-runner.md
set -euo pipefail

: "${REPO_URL:?REPO_URL is required}"
: "${REG_TOKEN:?REG_TOKEN is required}"
RUNNER_NAME="${RUNNER_NAME:-repworth-mac-lima}"
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -m)" in
  aarch64) RARCH=arm64 ;;
  x86_64) RARCH=x64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,${RARCH},repworth-mac}"

if [ -z "${RUNNER_VERSION:-}" ]; then
  RUNNER_VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/^v//')"
fi

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

if [ ! -x ./config.sh ]; then
  echo "downloading actions-runner v${RUNNER_VERSION} (linux-${RARCH})"
  curl -fsSL -o runner.tgz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RARCH}-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tgz && rm -f runner.tgz
  sudo ./bin/installdependencies.sh
fi

# Per-job hygiene hook. The runner reads `.env` in its root at startup; the
# hook path variable is the documented way to run a script before every job.
mkdir -p hooks
cp "$HERE/job-started-hook.sh" hooks/job-started.sh
chmod +x hooks/job-started.sh
printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s/hooks/job-started.sh\n' "$RUNNER_DIR" > .env

# Re-register cleanly if this VM already had a runner configured.
if [ -f .runner ]; then
  echo "existing runner config found — stopping service and re-registering"
  sudo ./svc.sh stop >/dev/null 2>&1 || true
  sudo ./svc.sh uninstall >/dev/null 2>&1 || true
  ./config.sh remove --token "$REG_TOKEN" >/dev/null 2>&1 || rm -f .runner .credentials .credentials_rsaparams
fi

./config.sh \
  --unattended \
  --replace \
  --url "$REPO_URL" \
  --token "$REG_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work _work

# systemd service, runs as this (unprivileged, docker-group) user, restarts on
# boot. `svc.sh` is the runner's own installer.
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
sudo ./svc.sh status | head -5 || true
echo "runner '${RUNNER_NAME}' registered with labels ${RUNNER_LABELS}"
