# Self-hosted CI runner (Lima VM on the founder's Mac)

**Status:** live since 2026-08-16 (CI cost pass). **Owner:** founder.
**Files:** `scripts/ci/self-hosted-runner/{install.sh,lima.yaml,register-runner.sh,job-started-hook.sh}`.

## Why

GitHub-hosted minutes for this private repo ran ~15,800 min/month (601 `ci.yml`
runs × 17.8 min, plus fallow/e2e/react-doctor) — roughly $80–85/month after the
free allowance, and the account hit its spending limit on 2026-08-16, which
stopped every PR check. Self-hosted runner minutes are **free** on private
repos. The same cost pass also cut ~27% of the minutes themselves (Tier 1:
duplicate `build-dummy-env-canary` job removed; fallow folded into `ci.yml` and
fed by the `test` job's coverage artifact instead of a second suite run + second
Postgres; `llm-eval` skips at job level). Both changes are independent — Tier 1
still applies when CI moves back to hosted runners at launch.

## Topology

```
Mac (macOS, Apple silicon)
└── Lima VM `repworth-ci`  — Ubuntu 24.04 arm64, 6 vCPU / 8 GiB / 80 GiB sparse, NO host mounts
    ├── dockerd (apt docker.io)         ← `services: postgres` containers, per job
    ├── psql client, git, jq, build tools
    └── actions-runner `repworth-mac-lima` (systemd service, runs as the Lima user)
        ├── labels: self-hosted, linux, arm64, repworth-mac
        ├── ~/actions-runner/_work/…     persistent workspace (actions/checkout cleans it per job)
        ├── ~/actions-runner/.env         ACTIONS_RUNNER_HOOK_JOB_STARTED=…/hooks/job-started.sh
        └── tool cache                    Node (from .nvmrc via setup-node), pnpm store, Playwright browsers — persist on purpose
```

Routing is one repo variable: every job in `ci.yml`, `e2e.yml`, `react-doctor.yml`,
`cache-warm.yml` declares `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`.

| `vars.CI_RUNNER` | where CI runs |
|---|---|
| `self-hosted` (current) | the VM above |
| unset | GitHub-hosted `ubuntu-latest` (x64) — no file change needed |

Deliberately **still hosted**: `claude.yml`, `claude-code-review.yml` (they hold
`CLAUDE_CODE_OAUTH_TOKEN`, the one real secret — it must never land on the VM;
they cost ~0 minutes).

## Install / repair (one command)

```bash
scripts/ci/self-hosted-runner/install.sh
```

Idempotent. It: installs Lima via brew if missing → creates + starts the VM from
`lima.yaml` (first boot: Ubuntu image download + apt provisioning, a few minutes)
→ mints a 1-hour registration token with `gh` → copies `register-runner.sh` +
`job-started-hook.sh` into the VM and runs the registration there (runner
download, `config.sh`, `.env` hook, `svc.sh install/start`) → waits until GitHub
reports the runner `online` → `gh variable set CI_RUNNER self-hosted` → installs
a LaunchAgent (`com.repworth.ci-runner-vm`) that runs `limactl start repworth-ci`
at login. Flags: `SET_REPO_VAR=0` (do not touch the variable), `AUTOSTART=0`
(no LaunchAgent), `RUNNER_NAME=…`, `VM=…`.

## Daily operations

| Want | Command |
|---|---|
| Is the runner online / busy? | `gh api repos/RepWorth/ai-review-responder/actions/runners -q '.runners[]\|{name,status,busy}'` |
| VM status | `limactl list` |
| Start / stop the VM | `limactl start repworth-ci` · `limactl stop repworth-ci` |
| Shell into the VM | `limactl shell repworth-ci` |
| Runner service logs | `limactl shell repworth-ci sudo journalctl -u 'actions.runner.*' -f` |
| Restart the runner service | `limactl shell repworth-ci bash -c 'cd ~/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh start'` |
| Re-register (new token, same name) | re-run `install.sh` |
| **Fallback to hosted for a while** | `gh variable delete CI_RUNNER --repo RepWorth/ai-review-responder` — next push runs on `ubuntu-latest`; re-set with `gh variable set CI_RUNNER --body self-hosted` |
| Disk usage inside the VM | `limactl shell repworth-ci df -h /` and `limactl shell repworth-ci sudo docker system df` (`sudo`: your `limactl shell` session may predate the docker-group grant — see gotcha below) |
| Nuke everything (VM + runner) | `gh api -X DELETE repos/…/actions/runners/<id>` after `limactl delete -f repworth-ci`; `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.repworth.ci-runner-vm.plist` |

If a PR's checks sit **pending / "Waiting for a runner"**: the VM is off (Mac
asleep or rebooted before login) — `limactl start repworth-ci`, the queued jobs
pick up. Or unset `CI_RUNNER` to drain to hosted.

## What is different from GitHub-hosted — and the mitigation for each

| Difference | Consequence | Mitigation in place |
|---|---|---|
| Persistent runner, not a fresh VM per job | leftovers could bleed between jobs | `actions/checkout` `clean: true` (default) wipes the workspace; `job-started-hook.sh` prunes stopped containers, dangling networks, anonymous volumes before every job; weekly `docker system prune` cron in the VM. Not `--ephemeral`: that needs an admin-scoped token on the box for every job — worse than the hygiene it buys on a single-author private repo. |
| Untrusted code runs on your hardware (Dependabot PRs, `postinstall` scripts) | a malicious dependency executes on the VM | VM has **no host mounts** and holds **no secrets** (`ci.yml` env is all dummy values; the Claude OAuth token stays on hosted workflows). The registration token is minted per install, lives ~1 hour, and only registers a runner. |
| **One** runner → jobs run sequentially | a full PR is ~10–15 min wall clock instead of ~8 min parallel | Acceptable. Do NOT add a second runner on the same VM without first making the Postgres service port dynamic: `ci.yml`'s `test` job and `e2e.yml` both publish `5432:5432` and would collide. |
| linux/**arm64**, hosted is linux/x64 | native-module or arch-specific behaviour could differ from prod (x64); **Actions caches are shared across the two** | Every native dep in the lockfile ships an arm64 build (`@next/swc`, esbuild, rollup, sharp, tailwind oxide, fallow). Vercel/Railway still build x64 on their side, so an arch-only break surfaces at deploy, not silently. Every `actions/cache` key carries `${{ runner.arch }}` (Playwright browsers in `e2e.yml`/`cache-warm.yml`, pnpm store in `.github/actions/setup`) — an os-only key let the arm runner restore x64 chromium on the first run. |
| No GitHub runner SLA | CI stops when the Mac is off | LaunchAgent starts the VM at login; fallback is one `gh variable delete`. |
| Runner + toolchain updates are yours | stale runner version eventually refuses jobs | The runner self-updates. Ubuntu security updates: `limactl shell repworth-ci sudo apt-get update && sudo apt-get upgrade -y` occasionally. |

## Gotchas met on first install

- **`limactl start` hung 10 min on the readiness probe with Docker fully healthy.**
  Probes (and `limactl shell`) run over Lima's ssh ControlMaster, which opens
  *before* provisioning ends — that session predates `usermod -aG docker` and
  a bare `docker info` is "permission denied" forever. The probe now asks
  `sudo systemctl is-active docker`. Same reason `docker …` in a `limactl shell`
  may need `sudo` until the VM is restarted; the runner's own systemd session
  is fresh and sees the group.

- **`e2e` failed on the first self-hosted run: `browserType.launch: Executable doesn't exist`
  after a Playwright cache HIT.** The browser cache key was `${{ runner.os }}-playwright-<ver>`
  — no architecture — so the arm64 runner restored the x64 chromium that hosted
  runners had saved on `main`, and the cache-hit branch skips the download. Any
  `actions/cache` key that can be written by one arch and read by the other
  must include `${{ runner.arch }}`; both Playwright keys and the pnpm-store key
  now do.

## Moving back to hosted at launch

1. `gh variable delete CI_RUNNER --repo RepWorth/ai-review-responder`.
2. Raise the Actions spending limit in the GitHub billing settings.
3. Optionally stop paying for the VM's RAM: `limactl stop repworth-ci` and remove
   the LaunchAgent. Keep the files — the whole thing comes back with one
   `install.sh` run.

Follow-ups worth doing when hosted is back on: `ubuntu-24.04-arm` for the heavy
jobs (−17% per minute), `ubuntu-slim` for `changes`/`react-doctor` (−67%),
draft-PR gating so pushes to drafts do not run CI.
