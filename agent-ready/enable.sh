#!/usr/bin/env bash
# Turns agent-ready on for repos. Run it from your machine, logged in to gh
# as the repos' owner:
#
#   agent-ready/enable.sh [options] owner/repo...
#
#   --app <slug>       The App (default ntodd-agent). Its ID and key are read
#                      from ~/.config/agent-ready/<slug>/, where
#                      app/create-app.mjs put them.
#   --ref <sha>        The ntodd/github-actions commit to pin (default: the
#                      latest agent-ready/v* tag).
#   --tag <name>       The tag named in the pin's comment (default: that tag).
#   --trusted <logins> Who may start runs (default: you).
#   --bot-author       Commit as the App's bot, not as your git identity.
#   --no-ruleset       Don't add the ruleset that requires PRs into the
#                      default branch.
#   --no-pr            Set everything up but don't open the workflow PR.
#
# For each repo it adds the repo to the App's installation, sets the
# AGENT_APP_ID variable and the AGENT_APP_PRIVATE_KEY secret, sets
# CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY and AGENT_ATTACH_TOKEN from your
# environment when they're there, creates the labels, adds the ruleset and opens a PR
# adding .github/workflows/agent-ready.yml.
set -euo pipefail

app=ntodd-agent
ref=""
tag=""
trusted=""
bot_author=false
ruleset=true
open_pr=true
repos=()
while [ $# -gt 0 ]; do
  case $1 in
  --app) app=$2 && shift 2 ;;
  --ref) ref=$2 && shift 2 ;;
  --tag) tag=$2 && shift 2 ;;
  --trusted) trusted=$2 && shift 2 ;;
  --bot-author) bot_author=true && shift ;;
  --no-ruleset) ruleset=false && shift ;;
  --no-pr) open_pr=false && shift ;;
  -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' && exit 0 ;;
  -*) echo "Unknown option $1" >&2 && exit 2 ;;
  *) repos+=("$1") && shift ;;
  esac
done
[ ${#repos[@]} -gt 0 ] || { echo "Usage: enable.sh [options] owner/repo..." >&2 && exit 2; }

dir=$HOME/.config/agent-ready/$app
[ -f "$dir/app.json" ] && [ -f "$dir/private-key.pem" ] || {
  echo "No $dir/app.json and private-key.pem. Create the App with: node agent-ready/app/create-app.mjs" >&2
  exit 1
}
app_id=$(jq -r .id "$dir/app.json")
me=$(gh api user --jq .login)
trusted=${trusted:-$me}
trusted_json=$(printf '%s' "$trusted" | tr -s ', ' '\n' | grep . | jq -R . | jq -sc .)

if [ -z "$ref" ]; then
  tag=${tag:-$(gh api repos/ntodd/github-actions/tags --paginate --jq '.[].name' | grep '^agent-ready/v' | sort -V | tail -1)}
  [ -n "$tag" ] || { echo "No agent-ready/v* tag yet. Pass --ref <sha> --tag <name>." >&2 && exit 1; }
  ref=$(gh api "repos/ntodd/github-actions/commits/$tag" --jq .sha)
fi
tag=${tag:-$ref}

install_id=$(node "$(dirname "$0")/app/installation.mjs" "$dir" "$me")
[ -n "$install_id" ] || {
  echo "$app isn't installed. Install it with 'Only select repositories': https://github.com/apps/$app/installations/new" >&2
  exit 1
}

if $bot_author; then
  author=""
else
  author="      git-user-name: $(git config user.name)
      git-user-email: $(git config user.email)"
fi

for repo in "${repos[@]}"; do
  echo "== $repo"
  repo_id=$(gh api "repos/$repo" --jq .id)
  default=$(gh api "repos/$repo" --jq .default_branch)

  if node "$(dirname "$0")/app/installation.mjs" "$dir" "$me" "$repo" >/dev/null; then
    echo "$app is installed on it."
  elif gh api -X PUT "user/installations/$install_id/repositories/$repo_id" --silent 2>/dev/null; then
    echo "Added to $app."
  else
    # Adding a repo to an installation needs a classic PAT, which gh's token
    # isn't. Choosing All repositories there saves doing this again.
    echo "Add $repo to $app here, or choose All repositories: https://github.com/settings/installations/$install_id"
    [ "$(uname)" = Darwin ] && open "https://github.com/settings/installations/$install_id"
  fi

  gh variable set AGENT_APP_ID -R "$repo" --body "$app_id"
  gh secret set AGENT_APP_PRIVATE_KEY -R "$repo" <"$dir/private-key.pem"
  secrets=$(gh secret list -R "$repo" --json name --jq '.[].name')
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    printenv CLAUDE_CODE_OAUTH_TOKEN | gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$repo"
  elif ! grep -qx CLAUDE_CODE_OAUTH_TOKEN <<<"$secrets"; then
    echo "No CLAUDE_CODE_OAUTH_TOKEN secret. Set one with: gh secret set CLAUDE_CODE_OAUTH_TOKEN -R $repo"
  fi
  if [ -n "${AGENT_ATTACH_TOKEN:-}" ]; then
    printenv AGENT_ATTACH_TOKEN | gh secret set AGENT_ATTACH_TOKEN -R "$repo"
  elif ! grep -qx AGENT_ATTACH_TOKEN <<<"$secrets"; then
    echo "No AGENT_ATTACH_TOKEN secret, so screenshots won't be attached to PRs."
  fi
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    printenv OPENAI_API_KEY | gh secret set OPENAI_API_KEY -R "$repo"
  elif ! grep -qx OPENAI_API_KEY <<<"$secrets"; then
    echo "No OPENAI_API_KEY secret, so a Claude subagent will do the review instead of Codex."
  fi

  gh label create agent-ready -R "$repo" --force --color 1f883d --description "Start agent-ready on this issue" >/dev/null
  gh label create agent-working -R "$repo" --force --color fbca04 --description "agent-ready is working on this" >/dev/null
  gh label create agent-done -R "$repo" --force --color 0e8a16 --description "agent-ready finished" >/dev/null
  gh label create agent-blocked -R "$repo" --force --color d93f0b --description "agent-ready needs you" >/dev/null
  for e in low medium high xhigh max; do
    gh label create "effort:$e" -R "$repo" --force --color c5def5 --description "agent-ready effort" >/dev/null
  done
  echo "Labels set."

  if $ruleset; then
    if gh api "repos/$repo/rulesets" --jq '.[].name' | grep -qx agent-ready; then
      echo "Ruleset already there."
    elif gh api -X POST "repos/$repo/rulesets" --silent --input - <<EOF; then
{
  "name": "agent-ready",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } }
  ]
}
EOF
      echo "Ruleset added: $default needs a PR, except for admins."
    else
      echo "Couldn't add the ruleset (private repos need GitHub Pro for rulesets). The App could push to $default directly."
    fi
  fi

  $open_pr || continue
  tmp=$(mktemp -d)
  gh repo clone "$repo" "$tmp" -- --quiet --depth 1
  mkdir -p "$tmp/.github/workflows"
  cat >"$tmp/.github/workflows/agent-ready.yml" <<EOF
name: agent-ready

# Label an issue you wrote agent-ready, and an agent works it into draft
# pull requests on Crew, then keeps at them until CI is green and review
# threads are answered. See
# https://github.com/ntodd/github-actions/tree/main/agent-ready.
#
# An effort:<level> label (low, medium, high, xhigh, max) or an
# "/effort <level>" comment changes the effort from medium.

on:
  issues:
    types: [labeled]

permissions: {}

jobs:
  agent:
    if: >-
      github.event.label.name == 'agent-ready' &&
      contains(fromJSON('$trusted_json'), github.event.sender.login) &&
      contains(fromJSON('$trusted_json'), github.event.issue.user.login)
    concurrency:
      group: agent-ready-\${{ github.event.issue.number }}
    uses: ntodd/github-actions/.github/workflows/agent-ready.yml@$ref # $tag
    permissions:
      contents: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      actions: read
    with:
      trusted-users: $trusted
      app-id: \${{ vars.AGENT_APP_ID }}
$author
    secrets:
      AGENT_APP_PRIVATE_KEY: \${{ secrets.AGENT_APP_PRIVATE_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
      AGENT_ATTACH_TOKEN: \${{ secrets.AGENT_ATTACH_TOKEN }}
EOF
  (
    cd "$tmp"
    branch=task/agent-ready
    git checkout --quiet -b "$branch"
    git add .github/workflows/agent-ready.yml
    git commit --quiet -m "Work agent-ready issues on Crew" -m "Labeling an issue agent-ready starts ntodd/github-actions' agent-ready
workflow on it, which opens draft PRs and works them until CI is green."
    git push --quiet --force -u origin "$branch"
    gh pr create --head "$branch" --title "Work agent-ready issues on Crew" --body "Adds the agent-ready caller. Label an issue you wrote \`agent-ready\` and an agent works it into draft PRs on Crew: TDD, a headless-browser check, a Codex review, screenshots, and stacks when the fix splits into levels. Then it waits for CI and any review bots and answers them until everything's green.

It runs only on issues $trusted wrote and labeled. The App's key and the Claude token are already set as secrets on this repo." --base "$default"
  )
  rm -rf "$tmp"
done
