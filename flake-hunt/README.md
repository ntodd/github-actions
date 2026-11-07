# flake-hunt

Runs a Mix project's test suite many times, with ExUnit's random seed,
across several runners. Any test that fails some runs and passes the rest
gets a GitHub issue with its failure rate, the failing seeds, the distinct
failure messages and the commands to reproduce it. If a Claude token is
set, Claude reads the code, tries to reproduce the failure, and adds a
diagnosis with a suggested fix.

The project needs no changes. The formatter that records results is loaded
from outside it (`elixir -r flake_formatter.exs -S mix test ...`). It needs
Elixir 1.18 or newer.

## Use

```yaml
# .github/workflows/flake-hunt.yml
name: Flake hunt

on:
  schedule:
    - cron: "17 7 * * *"
  workflow_dispatch:
  # A change to this file gets a short dry run on its pull request.
  pull_request:
    paths: [.github/workflows/flake-hunt.yml]

permissions: {}

jobs:
  hunt:
    uses: ntodd/github-actions/.github/workflows/flake-hunt.yml@<sha> # flake-hunt/v1
    permissions:
      contents: read
      issues: write
    with:
      runs-per-shard: ${{ github.event_name == 'pull_request' && 2 || 25 }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

For a monorepo, add one job per Mix project with `working-directory` set.

To get diagnoses, make a token with `claude setup-token` and store it in each
repo: `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R owner/repo`. An
`ANTHROPIC_API_KEY` secret works too. Without either, issues go out
without a diagnosis.

## Inputs

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | The Mix project, relative to the repo root. |
| `runs-on` | `crew-m` | The runner label for every job. |
| `shards` | `4` | Jobs running the suite in parallel, 1 to 50. |
| `runs-per-shard` | `25` | Suite runs per shard. |
| `elixir-version`, `otp-version` | from `mise.toml` or `.tool-versions` | Looked for in the project's directory, then the repo root. |
| `node-version`, `go-version` | | Installs Node or Go for suites that need them. |
| `setup` | | Bash run in the project before `mix deps.get`, in the hunt and diagnose jobs. Start a database here, or append to `$GITHUB_ENV` to set variables for the tests. |
| `test-args` | | Extra `mix test` arguments. |
| `label` | `flaky-test` | The label on flake-hunt's issues. |
| `max-diagnoses` | `3` | The most new flakes Claude looks at in one hunt. |
| `claude-model` | Claude Code's default | |
| `claude-version` | `stable` | The Claude Code version to install. |
| `dry-run` | `auto` | `auto` files issues only on the default branch, and anywhere else writes them to the job summary. Also `always` or `never`. |
| `timeout-minutes` | `60` | For each hunt and diagnose job. |
| `id` | from `working-directory` | Names the artifacts. Set it if one workflow hunts the same directory twice. |

Outputs: `flaky-count` and `broken-count`.

## What it files

One issue per flaky test, labeled `flaky-test`, keyed by the project
directory, module and test name (not the line, which moves). On later
hunts:

- **Issue open:** a comment with the new failure rate and seeds.
- **Closed as completed:** reopened, with a comment and a fresh diagnosis.
  It flaked again, so the fix didn't take.
- **Closed as not planned:** left alone. That's how to stop tracking a test.

A test that fails every run isn't filed, since that's a broken test and not
a flaky one. It's listed in the job summary instead. If CI is green for that
test, it probably needs something the hunt's runners lack.

## Jobs

```
plan ─▶ hunt × shards ─▶ triage ─▶ diagnose ─▶ report
```

- **plan** checks the inputs and picks the Elixir and OTP versions.
- **hunt** sets up like CI, then runs `run/hunt.sh`: the suite
  `runs-per-shard` times, with each test's result appended as a JSON line.
- **triage** (`triage/`) merges the shards, finds the tests with
  `0 < failures < runs`, matches them to existing issues and writes a
  prompt for each new or reopened one, up to `max-diagnoses`.
- **diagnose** sets up like a hunt shard and runs Claude Code once per
  prompt (`diagnose/diagnose.sh`, `prompts/diagnose.md`). Claude can run
  the tests and edit files to test an idea. The checkout is reset between
  prompts. The job's token is read-only and the checkout keeps no
  credentials, so Claude can't push or write issues.
- **report** (`report/`) files the issues with the job's `issues: write`
  token and writes the job summary.

## Costs

A hunt boots `shards + 4` runners per project (5 with a diagnosis). On
Crew that's VM time and nothing else. Claude runs only when a hunt finds a
flake that has no open issue.
