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

The caller uses agent-ready's `main`, so changes here apply everywhere
without a repin. Pass `--ref <sha>` to pin a repo instead.

The ruleset requires an approved PR into the default branch, and admins
are exempt from it. It's what keeps the agent off the default branch: the
App can't push there, and it can't approve its own PRs, so it can't merge
them either. Without
`OPENAI_API_KEY`, a Claude subagent does the adversarial review instead of
Codex.

## Using it

- **Start:** label an issue `agent-ready`. Only issues a trusted user wrote
  and labeled start a run (`trusted-users`, you by default). Removing and
  re-adding the label starts it again.
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
- **Blocked:** anything else, and the issue gets `agent-blocked` and a
  comment that starts with **Blocked:** and the exact reason. That's a
  question only you can answer, checks still failing after `max-rounds`,
  a fix that needs a change under `.github/workflows/`, or an error. The
  PRs stay drafts.
- **Comments:** only trusted users' comments on the issue count, and only
  their review threads and the listed review bots' get answered.

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
