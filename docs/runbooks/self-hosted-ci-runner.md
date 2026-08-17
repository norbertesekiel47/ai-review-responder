# CI runners — routing, and the self-hosted Lima VM (parked)

**Status:** the Mac VM was the primary runner 2026-08-16 → 2026-08-17, then
**parked** by the cloud cutover below (managed fast runners for the heavy jobs,
GitHub-hosted for the sub-minute ones). The VM sections further down describe
the parked setup; `install.sh` brings it back. **Owner:** founder.
**Files:** `scripts/ci/self-hosted-runner/{install.sh,lima.yaml,register-runner.sh,job-started-hook.sh}`.

## Routing (current)

Two repo variables route every job; the old single knob is the fallback. No
workflow file changes to move CI between runners.

| Variable | Jobs | Value today | Why |
|---|---|---|---|
| `CI_RUNNER_HEAVY` | `lint`, `test`, `build`, `llm-eval` (ci.yml) · `e2e` (e2e.yml) · `warm` (cache-warm.yml) | `blacksmith-4vcpu-ubuntu-2404` | the minutes that matter: vitest scales with cores, `next build` too; per-second billing, 3,000 free min/month, then $0.004/min per 2 vCPU (x64) |
| `CI_RUNNER_LIGHT` | `changes`, `deploy-install`, `fallow` (ci.yml) · `react-doctor` (react-doctor.yml) | `ubuntu-latest` | each is a sub-minute job that GitHub bills as one rounded minute — ~2,400 min/month, inside the plan's 3,000 free minutes, so $0 |
| `CI_RUNNER` (legacy) | fallback for both | unset (was `self-hosted`) | `install.sh` sets it; it only routes jobs when the two above are deleted |
| — | `claude.yml`, `claude-code-review.yml` | hosted, hard-coded | they hold `CLAUDE_CODE_OAUTH_TOKEN`, the one real secret; it never reaches any other runner |

Precedence per job: `CI_RUNNER_HEAVY|LIGHT` → `CI_RUNNER` → `ubuntu-latest`.
`gh variable list --repo RepWorth/ai-review-responder` shows the live values.

**Draft PRs run nothing.** `changes` (and `lint`, which has no `needs:`) carry
`if: github.event.pull_request.draft == false`; every other job `needs: changes`
and is skipped with it. Agents open PRs with `gh pr create --draft` and run
`gh pr ready` when the work is complete — CI then runs once per finished PR plus
once per fix push instead of once per WIP push (~600 runs/month before this).
`ready_for_review` is in every workflow's trigger list. Skipped jobs bill
nothing; a draft cannot merge, so a skipped required check on a draft is
harmless.

Runner-independent trims that landed with the cutover: e2e boots
`next build && next start` under CI (the dev server's compile-on-first-hit blew
the 30s test timeout on a loaded runner and read as "flaky"), Postgres service
containers use a tmpfs data dir and 2s health probes (was ~8s of pure wait per
job), CI coverage writes only the `json` report the fallow gate reads.

### Cutover / rollback procedures

| Want | Do |
|---|---|
| Move heavy jobs to a different managed runner (Depot, Ubicloud, GitHub arm…) | install that provider's GitHub App on the `RepWorth` org, then `gh variable set CI_RUNNER_HEAVY --body <label>` — e.g. `depot-ubuntu-24.04-4`, `ubuntu-24.04-arm` |
| Benchmark 8 vCPU for `test` | temporarily `gh variable set CI_RUNNER_HEAVY --body blacksmith-8vcpu-ubuntu-2404`; compare the `test` job's vitest `Duration` line and the job's billed seconds; only the parallel project scales — the `integration` project is serialised by design |
| Free minutes exhausted mid-month (light jobs stall "waiting for a runner" / billing error) | `gh variable set CI_RUNNER_LIGHT --body blacksmith-2vcpu-ubuntu-2404` until the cycle resets, then delete it |
| Everything back on the Mac VM | `limactl start repworth-ci` (or `install.sh`), then `gh variable delete CI_RUNNER_HEAVY` and `gh variable delete CI_RUNNER_LIGHT`, and `gh variable set CI_RUNNER --body self-hosted` |
| Everything on GitHub-hosted | delete all three variables; raise the Actions spending limit first |

Measure a change the same way each time: p50/p95 PR completion (`gh run list
--workflow ci.yml --json createdAt,updatedAt`), per-job billed seconds
(`gh api repos/…/actions/runs/<id>/timing`), and the provider's monthly usage
page. Two weeks per experiment.

## Why the Mac VM existed (2026-08-16)

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

Routing: see § Routing above. The VM receives jobs only via the legacy
`vars.CI_RUNNER=self-hosted` when `CI_RUNNER_HEAVY` / `CI_RUNNER_LIGHT` are
unset. Every job in `ci.yml`, `e2e.yml`, `react-doctor.yml`, `cache-warm.yml`
declares `runs-on: ${{ vars.CI_RUNNER_<HEAVY|LIGHT> || vars.CI_RUNNER || 'ubuntu-latest' }}`.

Deliberately **always hosted**: `claude.yml`, `claude-code-review.yml` (they hold
`CLAUDE_CODE_OAUTH_TOKEN`, the one real secret — it must never land on the VM or
any third-party runner; they cost ~0 minutes).

## Why it was parked (2026-08-17)

Measured on the last two PRs before the cutover: one runner process runs one job
at a time, so a PR's seven jobs plus e2e/react-doctor ran in series (~10–14 min
of runner time per PR, two queued PRs ≈ 29 min wall clock) while GitHub-hosted
ran them in parallel (~8 min). The VM also shares the Mac's 12 cores with the
founder's local multi-agent sessions: the same `next build` took 35s idle and
141s under local load; e2e 236s vs 465s. Adding runners on the same VM needed
dynamic Postgres ports and more RAM than the Mac can spare. Managed fast runners
give parallelism, faster CPUs, and per-second billing at $5–15/month for this
workload — cheaper than the ~$54/month GitHub-hosted bill and without the toll on
the Mac. Third-party runners see the same things GitHub-hosted runners see (repo
code, the dummy CI env); the one real secret stays on the hosted-only workflows.

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
| **Route CI to / away from the VM** | § Routing → Cutover / rollback procedures (the VM only receives jobs via `CI_RUNNER=self-hosted` with the two newer variables deleted) |
| Disk usage inside the VM | `limactl shell repworth-ci df -h /` and `limactl shell repworth-ci sudo docker system df` (`sudo`: your `limactl shell` session may predate the docker-group grant — see gotcha below) |
| Nuke everything (VM + runner) | `gh api -X DELETE repos/…/actions/runners/<id>` after `limactl delete -f repworth-ci`; `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.repworth.ci-runner-vm.plist` |

If a PR's checks sit **pending / "Waiting for a runner"** while the VM is the
routed runner: the VM is off (Mac asleep or rebooted before login) —
`limactl start repworth-ci`, the queued jobs pick up. Or route away (§ Routing).

## What is different from GitHub-hosted — and the mitigation for each

| Difference | Consequence | Mitigation in place |
|---|---|---|
| Persistent runner, not a fresh VM per job | leftovers could bleed between jobs | `actions/checkout` `clean: true` (default) wipes the workspace; `job-started-hook.sh` prunes stopped containers, dangling networks, anonymous volumes before every job; weekly `docker system prune` cron in the VM. Not `--ephemeral`: that needs an admin-scoped token on the box for every job — worse than the hygiene it buys on a single-author private repo. |
| Untrusted code runs on your hardware (Dependabot PRs, `postinstall` scripts) | a malicious dependency executes on the VM | VM has **no host mounts** and holds **no secrets** (`ci.yml` env is all dummy values; the Claude OAuth token stays on hosted workflows). The registration token is minted per install, lives ~1 hour, and only registers a runner. |
| **One** runner → jobs run sequentially | a full PR is ~10–15 min wall clock instead of ~8 min parallel; two queued PRs ≈ 29 min | This is why the VM was parked (§ Why it was parked). Do NOT add a second runner on the same VM without first making the Postgres service port dynamic: `ci.yml`'s `test` job and `e2e.yml` both publish `5432:5432` and would collide; and Playwright's `webServer` pins port 3000. |
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

## Retiring the VM for good

1. Confirm nothing routes to it: `gh variable list` shows no `CI_RUNNER=self-hosted`
   (or `CI_RUNNER_HEAVY`/`LIGHT` are both set).
2. `limactl stop repworth-ci`; `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.repworth.ci-runner-vm.plist`.
3. Optionally deregister: `gh api -X DELETE repos/RepWorth/ai-review-responder/actions/runners/<id>` and `limactl delete -f repworth-ci`.
Keep the files — `install.sh` rebuilds the whole thing in a few minutes if a
provider outage or price change ever makes the Mac the right answer again.
