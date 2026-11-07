#!/usr/bin/env bash
# Sets the VM up the way the owner's own machine is: their Claude Code
# config (CLAUDE.md, skills, commands, agents, hooks) from the config
# repo, settings for an unattended run, Codex's login, and git.
#
#   configure.sh <config dir>
#
# Env: AGENT_MODEL, AGENT_EFFORT, OPENAI_API_KEY or CODEX_AUTH_JSON
# (optional), AGENT_GIT_NAME and AGENT_GIT_EMAIL (optional; run/index.mjs
# falls back to the App's bot identity).
set -euo pipefail

cfg=${1:?config dir}
claude=$HOME/.claude
mkdir -p "$claude"
for d in skills commands agents hooks; do
  if [ -d "$cfg/$d" ]; then cp -R "$cfg/$d" "$claude/"; fi
done
if [ -f "$cfg/CLAUDE.md" ]; then cp "$cfg/CLAUDE.md" "$claude/CLAUDE.md"; fi
find "$claude/hooks" "$claude/skills" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true

# Settings for the run. Not the owner's settings.json, which is full of
# machine-specific hooks and permissions; just what matters here.
hook=$claude/hooks/humanize-reminder.sh
node - "$claude/settings.json" "$hook" <<'EOF'
const fs = require("node:fs");
const [file, hook] = process.argv.slice(2);
const settings = {
  model: process.env.AGENT_MODEL,
  effortLevel: process.env.AGENT_EFFORT,
  alwaysThinkingEnabled: true,
  includeCoAuthoredBy: false,
  attribution: { commit: "", pr: "", sessionUrl: false, coAuthoredBy: false, generatedWith: false },
  env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
};
if (fs.existsSync(hook)) {
  settings.hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook, if: "Bash(gh *)" }] }] };
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
EOF

# Codex, for the adversarial review. An API key is the reliable way: a
# ChatGPT auth.json rotates its refresh token, so VMs sharing one copy can
# log each other out.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
elif [ -n "${CODEX_AUTH_JSON:-}" ]; then
  mkdir -p "$HOME/.codex"
  (umask 077 && printenv CODEX_AUTH_JSON >"$HOME/.codex/auth.json")
fi
codex login status || echo "Codex isn't logged in, so a Claude subagent does the adversarial review."

# git pushes with whatever GH_TOKEN the phase has.
git config --global credential.https://github.com.helper ''
git config --global --add credential.https://github.com.helper '!gh auth git-credential'
if [ -n "${AGENT_GIT_NAME:-}" ]; then git config --global user.name "$AGENT_GIT_NAME"; fi
if [ -n "${AGENT_GIT_EMAIL:-}" ]; then git config --global user.email "$AGENT_GIT_EMAIL"; fi
