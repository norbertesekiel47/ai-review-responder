#!/usr/bin/env bash
# Set up (or repair) the RepWorth self-hosted CI runner on THIS Mac.
#
#   1. installs Lima (brew) if missing
#   2. creates + starts the `repworth-ci` Ubuntu VM from lima.yaml (idempotent)
#   3. mints a one-hour runner registration token with `gh` (needs repo admin —
#      the founder's `gh auth login` has it) and registers the runner INSIDE the
#      VM as a systemd service (register-runner.sh)
#   4. waits until GitHub reports the runner online
#   5. sets the repo variable CI_RUNNER=self-hosted so ci.yml/e2e.yml/
#      react-doctor.yml route to it   (skip with SET_REPO_VAR=0)
#   6. installs a LaunchAgent that starts the VM at login (skip with AUTOSTART=0)
#
# Re-run any time: every step is a no-op when already done, except (3), which
# re-registers under the same runner name (harmless).
#
# Roll back to GitHub-hosted runners without touching this Mac:
#   gh variable delete CI_RUNNER --repo RepWorth/ai-review-responder
# Full runbook: docs/runbooks/self-hosted-ci-runner.md
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-RepWorth/ai-review-responder}"
VM="${VM:-repworth-ci}"
RUNNER_NAME="${RUNNER_NAME:-repworth-mac-lima}"
SET_REPO_VAR="${SET_REPO_VAR:-1}"
AUTOSTART="${AUTOSTART:-1}"
PLIST="$HOME/Library/LaunchAgents/com.repworth.ci-runner-vm.plist"

log() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }

need brew
need gh
need jq
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in — run: gh auth login" >&2; exit 1; }

# 1. Lima
if ! command -v limactl >/dev/null 2>&1; then
  log "installing Lima (brew install lima)"
  brew install lima
fi
LIMACTL="$(command -v limactl)"
log "lima: $("$LIMACTL" --version)"

# 2. VM create + start
if ! "$LIMACTL" list -q 2>/dev/null | grep -qx "$VM"; then
  log "creating VM '$VM' from $HERE/lima.yaml (first boot downloads Ubuntu 24.04 + provisions docker; a few minutes)"
  "$LIMACTL" create --name "$VM" --tty=false "$HERE/lima.yaml"
fi
status="$("$LIMACTL" list "$VM" --json 2>/dev/null | jq -r '.status // empty')"
if [ "$status" != "Running" ]; then
  log "starting VM '$VM' (status: ${status:-unknown})"
  "$LIMACTL" start --tty=false "$VM"
fi
log "VM '$VM' is running: $("$LIMACTL" shell "$VM" uname -srm) / docker $("$LIMACTL" shell "$VM" docker --version | cut -d, -f1)"

# 3. Register the runner inside the VM
log "minting a runner registration token for $REPO"
REG_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q '.token')"
[ -n "$REG_TOKEN" ] || { echo "could not mint a registration token (need repo admin)" >&2; exit 1; }

log "copying scripts into the VM and registering runner '$RUNNER_NAME'"
"$LIMACTL" shell "$VM" mkdir -p /tmp/repworth-runner
"$LIMACTL" copy "$HERE/register-runner.sh" "$HERE/job-started-hook.sh" "$VM:/tmp/repworth-runner/"
"$LIMACTL" shell "$VM" chmod +x /tmp/repworth-runner/register-runner.sh /tmp/repworth-runner/job-started-hook.sh
"$LIMACTL" shell "$VM" env \
  REPO_URL="https://github.com/$REPO" \
  REG_TOKEN="$REG_TOKEN" \
  RUNNER_NAME="$RUNNER_NAME" \
  bash /tmp/repworth-runner/register-runner.sh
unset REG_TOKEN

# 4. Wait for GitHub to see it online
log "waiting for GitHub to report '$RUNNER_NAME' online"
rstatus=""
for _ in $(seq 1 30); do
  rstatus="$(gh api "repos/$REPO/actions/runners" -q ".runners[] | select(.name==\"$RUNNER_NAME\") | .status" 2>/dev/null || true)"
  [ "$rstatus" = "online" ] && break
  sleep 2
done
echo "runner status: ${rstatus:-not registered}"
[ "$rstatus" = "online" ] || { echo "runner did not come online — check: limactl shell $VM sudo journalctl -u 'actions.runner.*' --no-pager | tail -50" >&2; exit 1; }

# 5. Route CI to it
if [ "$SET_REPO_VAR" = "1" ]; then
  log "setting repo variable CI_RUNNER=self-hosted on $REPO"
  gh variable set CI_RUNNER --repo "$REPO" --body self-hosted
else
  log "SET_REPO_VAR=0 — not touching the CI_RUNNER repo variable"
fi

# 6. Start the VM at login
if [ "$AUTOSTART" = "1" ]; then
  log "installing LaunchAgent to start the VM at login ($PLIST)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.repworth.ci-runner-vm</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LIMACTL}</string>
    <string>start</string>
    <string>--tty=false</string>
    <string>${VM}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/repworth-ci-vm.log</string>
  <key>StandardErrorPath</key><string>/tmp/repworth-ci-vm.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  log "AUTOSTART=0 — no LaunchAgent installed (start the VM by hand: limactl start $VM)"
fi

log "done. CI now runs on '$RUNNER_NAME' (VM '$VM'). Status: gh api repos/$REPO/actions/runners -q '.runners[]|{name,status,busy}'"
