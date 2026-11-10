# agent-ready

Label an issue you wrote `agent-ready`, and an agent works it into draft
pull requests on Crew, the way you would: the issue-fix-stack skill with
TDD, a headless-browser check, a Codex review, screenshots, and stacked PRs
when the fix splits into levels. Then it waits for CI and any review bots
and answers them, round after round, until everything is green and every
thread has a reply.

It runs your own Claude Code config (CLAUDE.md, skills, commands, agents
and hooks) from a repo, `ntodd/dotfiles` by default, so it follows the same
rules you do.

## Turning it on

Once, create the GitHub App and install it on one repo with *Only select
repositories*:

```sh
node agent-ready/app/create-app.mjs        # opens GitHub; click Create
```

The App can write contents, pull requests, issues and actions, and read
checks and statuses. Actions write is only for the workflow to rerun a
flaky job; the tokens Claude gets ask for actions read. It has no
workflows permission, so GitHub refuses any push from it that touches
`.github/workflows/`. Its ID and key land in
`~/.config/agent-ready/ntodd-agent/`.

Then, for each repo:

```sh
CLAUDE_CODE_OAUTH_TOKEN=... OPENAI_API_KEY=... AGENT_ATTACH_TOKEN=... agent-ready/enable.sh ntodd/foo ntodd/bar
```

`AGENT_ATTACH_TOKEN` is a fine-grained PAT for screenshots: all
repositories, Contents and Pull requests read and write. GitHub's upload
endpoint for PR attachments takes a user's token but not an App's. Claude
never holds it; after each publish the workflow itself runs
`gh pr edit --attach` for the `./screenshots/` images Claude referenced.
Without it, the references become plain text.

That checks the repos are on the App, sets the `AGENT_APP_ID` variable and
the secrets, creates the labels, adds a ruleset, and opens a PR with the
caller workflow. Rerunning it with `--no-pr` updates all but the caller.
The caller holds the triggers and the two small jobs that start resolve
runs, so rerun it without `--no-pr` to pick up changes to those.

The caller uses agent-ready's `main`, so changes here apply everywhere
without a repin. Pass `--ref <sha>` to pin a repo instead.

The ruleset requires an approved PR into the default branch, and admins
are exempt from it. It's what keeps the agent off the default branch: the
App can't push there, and it can't approve its own PRs, so it can't merge
them either. The approval has to cover the PR's last push
(`require_last_push_approval`), so the App can't push to a PR you've
approved and then merge it on that approval. Only the admin role bypasses
the ruleset, and the App has no administration permission, so it can't
edit it. Without
`OPENAI_API_KEY`, a Claude subagent does the adversarial review instead of
Codex.

## Using it

- **Start:** label an issue `agent-ready`. Only issues a trusted user wrote
  and labeled start a run (`trusted-users`, you by default). Removing and
  re-adding the label starts it again. You can also start one from the
  Actions tab (*Run workflow*, with the issue number) on an open issue
  that has the label.
- **Flaky tests:** with flake-hunt's `agent-workflow` set, each flaky
  test it files or reopens gets the label and a run, and the agent fixes
  the flake. flake-hunt's issues are the only ones a trusted user didn't
  write that the gate accepts: written by `github-actions[bot]` with
  flake-hunt's marker. Only workflows in the repo can write as that bot,
  never Claude, whose writes are the App's. A label added with the job's
  token doesn't start workflows, so flake-hunt dispatches the caller
  instead, and `github-actions[bot]` may dispatch only on those issues.
  The owner (the first trusted user) is asked to review.
- **One fix per cause:** flake-hunt starts one run for a group of flakes
  that fail the same way, on the group's first issue, whose body lists
  the rest. The run checks each one's failing seeds against the fix, and
  the PR closes the ones it covers. Before it builds, a run on a
  flake-hunt issue checks out each of the App's open PRs that could fix
  the same cause and runs the issue's failing seeds. If one passes them
  all, it opens nothing: it comments on the issue with the PR and the
  seeds, comments on the PR, and labels the issue `agent-covered`. The
  issue stays open: close it by hand when that PR merges. Adding
  `Fixes #N` to the PR instead would fail the resolve checks, since the
  issue isn't in the PR's group.
- **Taking turns:** runs flake-hunt starts from one hunt don't all build
  at once, or none could see another's PR. A build on a flake-hunt issue
  waits in the gate while a flake-hunt issue with a lower number is still
  queued (labeled `agent-ready`), or a run on one is working and hasn't
  opened its PR yet. It looks every five minutes, waits two hours at
  most, then goes ahead. The wait holds the runner and counts toward
  `timeout-minutes`, so keep that well above two hours.
- **Effort:** medium unless the issue has an `effort:<level>` label (`low`,
  `medium`, `high`, `xhigh`, `max`) or a trusted comment with
  `/effort <level>`.
- **Stacks:** an issue with sub-issues becomes a stack, one level per
  sub-issue. Otherwise it stacks only when the fix splits into levels that
  each stand alone.
- **Progress:** a status comment on the issue lists each phase with how
  long it took and what the agent is doing now. It's edited in place, at
  most every 5 minutes during a long phase, so it doesn't notify anyone.
- **Done:** CI is green and every thread has a reply. The PRs come out of
  draft, the issue's author (or `reviewers`) is asked to review them, and
  the issue gets `agent-done`.
- **Conflicts:** when the default branch moves and a PR conflicts with it,
  a resolve run merges it in. See [Keeping PRs mergeable](#keeping-prs-mergeable).
- **Blocked:** anything else, and the issue gets `agent-blocked` and a
  comment that starts with **Blocked:** and the exact reason. That's a
  question only you can answer, checks still failing after `max-rounds`,
  a fix that needs a change under `.github/workflows/`, or an error. The
  PRs stay drafts.
- **Comments:** only trusted users' comments on the issue count, and only
  their review threads and the listed review bots' get answered. An issue
  whose body or title someone untrusted edited doesn't run, and only a
  trusted user's sub-issues are part of the set. The App can edit and add
  issues, so this keeps Claude from writing its own next task.

## Keeping PRs mergeable

Merge one of several queued PRs and the rest can end up conflicting with
the default branch. A **resolve run** fixes one: it merges the default
branch into the PR's branch, resolves the conflicts the way the PR meant,
gets CI green again, and hands the PR back.

- **The sweep:** five minutes after a push to the default branch, and once
  a day, a small job on GitHub's runners looks at the App's open PRs and
  starts a resolve run on each one that conflicts. At most five a sweep,
  one per issue, the least recently updated first. PRs that are only
  behind are left alone: they still merge, and updating them would only
  rerun CI. It also skips stacks, PRs labeled `agent-conflict`, PRs with
  a resolve run already queued, and issues a run is still working or
  whose build ended `agent-blocked`.
- **`/resolve`:** comment exactly that on a PR, like `@dependabot rebase`.
  It works on the App's PRs and on PRs you wrote yourself, and does nothing
  when the PR doesn't conflict. The sweep never touches your own PRs.
- **What it does:** a merge, never a rebase, so review history stays and
  nothing is force-pushed. Changes stay limited to what it takes to
  integrate the two sides, and generated files (lock files, say) are
  regenerated. A comment on the PR says which commit of the default
  branch was merged and which files were resolved.
- **Done** means CI is green and GitHub says the PR is mergeable. If the
  default branch moved again in the meantime, it resolves again, as one of
  `max-rounds`.
- **Blocked** when it would have to guess: the default branch already does
  what the PR does (it asks you to close the PR), the two sides want
  different things, a check fails the same way on the default branch, or
  GitHub refuses the push. The reason goes where a run's always does, and
  the PR gets `agent-conflict` while it still conflicts, so the sweep
  doesn't try again until you've looked. `/resolve` clears it.
- **On your own PR** there's no issue, so the status comment and the
  labels go on the PR. It doesn't answer review threads, change the draft
  state or ask for a review, and when the PR doesn't make clear what you
  meant it blocks and asks. The App pushes a merge commit to your branch,
  so pull before you push again.
- **Stacks** aren't handled yet. A resolve run on a stack's PR ends
  blocked and says so.

A resolve run is a `workflow_dispatch` of the caller with `mode: resolve`,
so it shares the issue's concurrency group with the issue's build run and
never runs alongside it. A PR being the App's, or saying it closes an
issue, isn't enough to start one, because Claude can open and edit PRs
while it publishes. The gate, and the main step again before Claude
starts, check that:

- the issue is open, a trusted user (or flake-hunt) wrote it, and nobody
  untrusted edited it
- the last time the issue was labeled `agent-ready`, a trusted user did it
  (flake-hunt's bot, on flake-hunt's issues). That's GitHub's record in
  the issue's timeline, which the App can't forge
- the PR is open, the App opened it after that label, its branch is in the
  same repo, it goes into the default branch, and it closes that issue and
  no other. A flake-hunt group's PR may also close the others its first
  issue lists, as long as flake-hunt wrote each one and nobody untrusted
  edited it. The resolve run is for the group's first issue
- the head is still the commit that was checked, and the PR still
  conflicts. If not, the run stops without touching the issue

For a PR of your own, it checks instead that you wrote the PR, that nobody
untrusted edited its title or description, that its
branch is in the same repo and goes into the default branch, and that the
`/resolve` comment the dispatch names is on that PR, says exactly
`/resolve`, and is yours.

What this doesn't stop: within an issue you labeled, a hijacked run could
open a second PR that says it closes the issue, and a resolve run would
then work on that PR.

The App has no workflows permission. A merge can bring in the default
branch's changes under `.github/workflows/`, and GitHub may refuse that
push. When it does, the run ends blocked with GitHub's message.

## How a run goes

One job on `crew-l`. Claude works in one session that the workflow resumes
phase by phase:

1. **Build:** triage and reproduce, then TDD each level, run the gates,
   check the UI in a headless browser and take screenshots, and get the
   adversarial review. Commits stay local.
2. **Publish:** with a fresh App token, push and open draft PRs. Then the
   workflow attaches the screenshots the bodies reference.
3. **Wait:** the workflow, not Claude, polls until every PR's checks finish
   and each review bot has reviewed the head commit (or
   `review-timeout-minutes` passes). With `ready-for-bots`, drafts are
   marked ready once CI is green, for bots that skip drafts (CodeRabbit
   does by default).
4. **Respond and publish:** failures and open threads go back to Claude,
   which fixes locally, then pushes and replies with a new token. Up to
   `max-rounds` times. A failure is Claude's to fix even when main fails
   the same way. When all that's left is a flake or a cancelled job,
   the workflow reruns the job instead.
5. **Report:** issue-fix-stack's report goes in the job summary.

PR bodies follow the repo's PR template, or the git-workflow one when it
has none, and end with **How this was made** (a checklist of what it ran:
reproduction, TDD, gates, the headless browser, the adversarial review)
and **Decisions**.

## Tokens

- Claude's `GH_TOKEN` is the job's read-only `GITHUB_TOKEN`, except in
  publish phases. Then it's an App installation token limited to this one
  repository, minted for that phase and valid for an hour.
- The App key reaches the main step through a file, written in a step of
  its own and deleted on read. So it's never in Claude's environment or on
  disk while Claude runs.
- Claude has sudo on a throwaway VM, so a hijacked session could in
  principle dig the key out of the runner's memory. That's the remaining
  exposure. Crew blocks the VM from the LAN, the tailnet and the host.

## Inputs

| Input | Default | |
|---|---|---|
| `trusted-users` | (required) | Logins whose issues, labels and comments count. |
| `app-id` | (required) | `${{ vars.AGENT_APP_ID }}` |
| `label` | `agent-ready` | |
| `runs-on` | `crew-l` | |
| `model` | `claude-opus-5-5` | |
| `effort` | `medium` | The default effort. |
| `max-turns` | `500` | Per phase. |
| `phase-timeout-minutes` | `150` | |
| `timeout-minutes` | `360` | For the whole job. |
| `max-rounds` | `3` | CI and review rounds after the first publish. |
| `review-bots` | | Bots to wait for and answer, like `coderabbitai[bot]`. |
| `review-timeout-minutes` | `20` | |
| `ready-for-bots` | `false` | |
| `reviewers` | the issue's author | Asked to review when the PRs are done. Logins or `org/team`. |
| `working-directory`, `elixir-version`, `otp-version`, `node-version`, `go-version`, `setup` | | As in flake-hunt. `setup` gets the `SETUP_SECRETS` secret. Elixir is set up whenever the inputs or a `mise.toml` or `.tool-versions` name a version, even with no `mix.exs` in `working-directory`. |
| `ruby-version` | | Installs Ruby, with `bundle install` when there's a `Gemfile.lock`. |
| `git-user-name`, `git-user-email` | the App's bot | The commit author. |
| `claude-config`, `claude-config-path`, `claude-config-ref` | `ntodd/dotfiles`, `claude`, `main` | Where your Claude Code config lives. |
| `transcripts` | `auto` | Uploads Claude's session transcripts; `auto` does it for private repos only. |

Secrets: `AGENT_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`, and optionally `AGENT_ATTACH_TOKEN`, `OPENAI_API_KEY`
(or `CODEX_AUTH_JSON`) and `SETUP_SECRETS`.
